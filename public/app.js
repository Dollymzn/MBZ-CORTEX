/* =====================================================================
   MBZ::CORTEX — app.js
   Vanilla JS, no framework, no build step.
   Sections:
     1. Constants & state
     2. localStorage helpers
     3. Utility helpers (numbers, dates, dom)
     4. Markdown mini-renderer
     5. Onboarding flow
     6. Header / connection indicator / model select / reset config
     7. Chat: history, rendering, sending, SSE parsing
     8. Dashboard: snapshot fetch, normalizers, rendering
     9. Mobile tabs
     10. Boot
   ===================================================================== */
(function () {
  'use strict';

  /* ============================== 1. CONSTANTS & STATE ============================== */

  var LS_CONFIG = 'cortex.config';
  var LS_CHAT = 'cortex.chat';
  var LS_SNAPSHOT = 'cortex.snapshot';
  var LS_FLOORS = 'cortex.floors';

  var MAX_CHAT_HISTORY = 40;
  var SNAPSHOT_WARN_MS = 30 * 60 * 1000; // 30 min
  var SNAPSHOT_AGE_TICK_MS = 30 * 1000; // 30s

  // id -> nome, montado dinamicamente a partir do snapshot.projetos (listar_projetos
  // do moodlr-ops, escopado pelo token do gestor). Sem lista fixa: cada gestor
  // enxerga apenas os proprios projetos.
  var projectNames = {};

  function rebuildProjectNames() {
    projectNames = {};
    var proj = state.snapshot && state.snapshot.projetos;
    if (!proj) return;
    var rows = extractRows(proj.data !== undefined ? proj.data : proj);
    rows.forEach(function (row) {
      var id = pick(row, ['id', 'id_blog', 'idBlog', 'project_id']);
      var nome = pick(row, ['blog_name', 'blog', 'nome', 'name', 'projeto', 'site']);
      if (id !== undefined && id !== null && nome) projectNames[id] = String(nome);
    });
  }

  var REFRESH_COMMAND_RE = /atualiza|refresh|puxa de novo/i;

  // Placeholder delimiters used by the markdown renderer to protect fenced
  // code blocks / tables from further inline processing. PH is a single
  // non-whitespace control char (SOH, 0x01), so String.prototype.trim() never eats it.
  var PH = '';

  var state = {
    config: null, // {name, moodlrToken, model}
    chatHistory: [], // [{role, content}]
    snapshot: null,
    period: 'hoje',
    chatBusy: false
  };

  /* ============================== 2. LOCALSTORAGE HELPERS ============================== */

  function lsGet(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage full or unavailable - fail silently, app still works in-memory */
    }
  }

  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  /* ============================== 3. UTILITY HELPERS ============================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s) return null;
    // strip currency symbols / spaces defensively; keep digits, comma, dot, minus
    s = s.replace(/[^\d.,-]/g, '');
    if (!s) return null;
    var n = parseFloat(s.replace(/,/g, '.'));
    return isFinite(n) ? n : null;
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
  }

  function formatCurrencyUSD(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var neg = n < 0;
    var abs = Math.abs(n);
    var parts = abs.toFixed(2).split('.');
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + '$ ' + intPart + ',' + parts[1];
  }

  function formatPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var sign = n > 0 ? '+' : '';
    return sign + n.toFixed(1).replace('.', ',') + '%';
  }

  function formatEcpm(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return '$ ' + n.toFixed(2).replace('.', ',');
  }

  function formatPct1(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toFixed(1).replace('.', ',') + '%';
  }

  function formatFloorNum(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Number(n).toFixed(2);
  }

  function formatIntBR(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  // Toast neon simples, no canto inferior direito - usado pelo fluxo de FLOORS
  // (aplicar/erro), sem depender de nenhum componente pre-existente.
  function showToast(message, kind) {
    var container = $('#toast-container');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast-show'); });
    setTimeout(function () {
      el.classList.remove('toast-show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 3600);
  }

  /* ============================== 4. MARKDOWN MINI-RENDERER ============================== */

  function inlineMd(str) {
    var s = str;
    // inline code
    s = s.replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; });
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italics (single asterisk not already consumed by bold)
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // links [text](url) - only http(s)/mailto are linkified
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, url) {
      if (/^(https?:|mailto:)/i.test(url)) {
        return '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">' + t + '</a>';
      }
      return t;
    });
    return s;
  }

  function isTableRow(line) { return typeof line === 'string' && /^\s*\|.*\|\s*$/.test(line); }
  function isTableSep(line) { return typeof line === 'string' && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line); }
  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map(function (c) { return c.trim(); });
  }
  function buildTableHtml(header, rows) {
    var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    header.forEach(function (h) { html += '<th>' + inlineMd(h) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>';
      r.forEach(function (c) { html += '<td>' + inlineMd(c) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function renderBlocks(text) {
    var lines = text.split('\n');
    var html = '';
    var inUl = false, inOl = false;
    var closeLists = function () {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    };
    var tbRe = new RegExp('^' + PH + 'TB\\d+' + PH + '$');
    var cbRe = new RegExp('^' + PH + 'CB\\d+' + PH + '$');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (tbRe.test(trimmed)) { closeLists(); html += trimmed; continue; }
      if (cbRe.test(trimmed)) { closeLists(); html += trimmed; continue; }
      if (trimmed === '') { closeLists(); continue; }

      var m;
      if ((m = /^#{3}\s+(.*)/.exec(trimmed))) { closeLists(); html += '<h3>' + inlineMd(m[1]) + '</h3>'; continue; }
      if ((m = /^#{2}\s+(.*)/.exec(trimmed))) { closeLists(); html += '<h2>' + inlineMd(m[1]) + '</h2>'; continue; }
      if ((m = /^#{1}\s+(.*)/.exec(trimmed))) { closeLists(); html += '<h1>' + inlineMd(m[1]) + '</h1>'; continue; }

      if ((m = /^[-*]\s+(.*)/.exec(trimmed))) {
        if (inOl) closeLists();
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += '<li>' + inlineMd(m[1]) + '</li>';
        continue;
      }
      if ((m = /^\d+\.\s+(.*)/.exec(trimmed))) {
        if (inUl) closeLists();
        if (!inOl) { html += '<ol>'; inOl = true; }
        html += '<li>' + inlineMd(m[1]) + '</li>';
        continue;
      }

      closeLists();
      html += '<p>' + inlineMd(trimmed) + '</p>';
    }
    closeLists();
    return html;
  }

  function renderMarkdown(raw) {
    if (!raw) return '';
    var text = escapeHtml(raw);

    // 1. fenced code blocks -> placeholders
    var codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function (m, lang, code) {
      codeBlocks.push(code);
      return PH + 'CB' + (codeBlocks.length - 1) + PH;
    });

    // 2. tables -> placeholders
    var tables = [];
    var lines = text.split('\n');
    var linesOut = [];
    for (var i = 0; i < lines.length; i++) {
      if (isTableRow(lines[i]) && isTableSep(lines[i + 1])) {
        var header = splitRow(lines[i]);
        i += 2;
        var rows = [];
        while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        i--; // compensate loop increment
        tables.push(buildTableHtml(header, rows));
        linesOut.push(PH + 'TB' + (tables.length - 1) + PH);
        continue;
      }
      linesOut.push(lines[i]);
    }
    text = linesOut.join('\n');

    // 3. block-level rendering (headings, lists, paragraphs)
    text = renderBlocks(text);

    // 4. restore placeholders
    var tbGlobalRe = new RegExp(PH + 'TB(\\d+)' + PH, 'g');
    var cbGlobalRe = new RegExp(PH + 'CB(\\d+)' + PH, 'g');
    text = text.replace(tbGlobalRe, function (m, idx) { return tables[Number(idx)]; });
    text = text.replace(cbGlobalRe, function (m, idx) {
      return '<pre class="md-code"><code>' + codeBlocks[Number(idx)] + '</code></pre>';
    });

    return text;
  }

  /* ============================== 5. ONBOARDING FLOW ============================== */

  var obOverlay = $('#onboarding-overlay');
  var obForm = $('#onboarding-form');
  var obName = $('#ob-name');
  var obToken = $('#ob-token');
  var obTokenToggle = $('#ob-token-toggle');
  var obModel = $('#ob-model');
  var obRulerToken = $('#ob-ruler-token');
  var obRulerToggle = $('#ob-ruler-toggle');
  var obAvBearer = $('#ob-avbearer');
  var obAvBearerToggle = $('#ob-avbearer-toggle');
  var obAvBearerHint = $('#ob-avbearer-hint');
  var obSubmit = $('#ob-submit');
  var obSpinner = $('#ob-spinner');
  var obStatus = $('#ob-status');

  obTokenToggle.addEventListener('click', function () {
    var isPwd = obToken.type === 'password';
    obToken.type = isPwd ? 'text' : 'password';
  });

  obRulerToggle.addEventListener('click', function () {
    var isPwd = obRulerToken.type === 'password';
    obRulerToken.type = isPwd ? 'text' : 'password';
  });

  obAvBearerToggle.addEventListener('click', function () {
    var isPwd = obAvBearer.type === 'password';
    obAvBearer.type = isPwd ? 'text' : 'password';
  });

  // Aviso dim: se o gestor preencher a key do ruler-mcp sem av_bearer, algumas
  // tools de price floor vao exigir av_bearer em runtime - avisa mas nao bloqueia.
  function updateAvBearerHint() {
    var show = !!obRulerToken.value.trim() && !obAvBearer.value.trim();
    obAvBearerHint.classList.toggle('hidden', !show);
  }
  obRulerToken.addEventListener('input', updateAvBearerHint);
  obAvBearer.addEventListener('input', updateAvBearerHint);

  function setObStatus(msg, kind) {
    obStatus.textContent = msg || '';
    obStatus.className = 'ob-status' + (kind ? ' ' + kind : '');
  }

  function setObLoading(loading) {
    obSubmit.disabled = loading;
    obSpinner.classList.toggle('hidden', !loading);
  }

  async function validateKey(token) {
    try {
      var res = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moodlrToken: token })
      });
      var json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (res.ok && json && json.ok) {
        return { ok: true, toolCount: json.toolCount };
      }
      if (res.status === 401) {
        return { ok: false, error: 'KEY INVALIDA // ACESSO NEGADO' };
      }
      if (res.status === 502) {
        return { ok: false, error: 'MOODLR-OPS INACESSIVEL' };
      }
      return { ok: false, error: (json && json.error) || 'ERRO DESCONHECIDO // TENTE NOVAMENTE' };
    } catch (e) {
      return { ok: false, error: 'FALHA DE REDE // VERIFIQUE A CONEXAO' };
    }
  }

  async function validateRulerKey(token) {
    try {
      var res = await fetch('/api/validate-ruler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rulerToken: token })
      });
      var json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (res.ok && json && json.ok) {
        return { ok: true, toolCount: json.toolCount };
      }
      if (res.status === 401) {
        return { ok: false, error: 'KEY RULER-MCP INVALIDA' };
      }
      if (res.status === 502) {
        return { ok: false, error: 'RULER-MCP INACESSIVEL' };
      }
      return { ok: false, error: (json && json.error) || 'ERRO DESCONHECIDO // TENTE NOVAMENTE' };
    } catch (e) {
      return { ok: false, error: 'FALHA DE REDE // VERIFIQUE A CONEXAO' };
    }
  }

  obForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = obName.value.trim();
    var token = obToken.value.trim();
    var model = obModel.value;
    var rulerToken = obRulerToken.value.trim();
    var avBearer = obAvBearer.value.trim();

    if (!name || !token) {
      setObStatus('PREENCHA NOME E KEY', 'error');
      return;
    }

    setObLoading(true);
    setObStatus('validando acesso...', 'loading');

    var result = await validateKey(token);

    if (!result.ok) {
      setObLoading(false);
      setObStatus(result.error, 'error');
      setMoodlrConnStatus(false);
      return;
    }

    // Key do moodlr-ops OK. A key do ruler-mcp e OPCIONAL, mas se preenchida
    // precisa validar tambem - se falhar, NAO libera entrada (gestor corrige
    // ou apaga o campo pra entrar sem ruler). av_bearer nao tem validacao
    // propria (usada pelas tools em runtime).
    if (rulerToken) {
      setObStatus('validando ruler-mcp...', 'loading');
      var rulerResult = await validateRulerKey(rulerToken);
      if (!rulerResult.ok) {
        setObLoading(false);
        setObStatus(rulerResult.error, 'error');
        return;
      }
    }

    setObLoading(false);
    setObStatus('');
    state.config = { name: name, moodlrToken: token, model: model };
    if (rulerToken) state.config.rulerToken = rulerToken;
    if (avBearer) state.config.avBearer = avBearer;
    lsSet(LS_CONFIG, state.config);
    setMoodlrConnStatus(true);
    enterApp(true);
  });

  /* ============================== 6. HEADER / CONNECTION / RESET ============================== */

  var connIndicatorMoodlr = $('#conn-indicator-moodlr');
  var connDotMoodlr = $('#conn-dot-moodlr');
  var connIndicatorRuler = $('#conn-indicator-ruler');
  var connDotRuler = $('#conn-dot-ruler');
  var modelSelect = $('#model-select');
  var changeConfigBtn = $('#change-config-btn');

  function setMoodlrConnStatus(online) {
    connDotMoodlr.classList.toggle('online', !!online);
    connDotMoodlr.classList.toggle('offline', !online);
    connIndicatorMoodlr.title = 'moodlr-ops: ' + (online ? 'conectado' : 'offline');
  }

  // status: 'ok' (verde, validou), 'fail' (vermelho, validacao falhou),
  // 'unset' (cinza, sem rulerToken configurado - tools de price floor desabilitadas)
  function setRulerConnStatus(status) {
    connDotRuler.classList.toggle('online', status === 'ok');
    connDotRuler.classList.toggle('offline', status === 'fail');
    var label = status === 'ok' ? 'conectado' : status === 'fail' ? 'falhou na validação' : 'não configurado';
    connIndicatorRuler.title = 'ruler-mcp: ' + label;
  }

  modelSelect.addEventListener('change', function () {
    if (!state.config) return;
    state.config.model = modelSelect.value;
    lsSet(LS_CONFIG, state.config);
  });

  changeConfigBtn.addEventListener('click', function () {
    var ok = confirm('Isso vai apagar sua configuracao, historico de chat e dados salvos neste navegador. Continuar?');
    if (!ok) return;
    lsRemove(LS_CONFIG);
    lsRemove(LS_CHAT);
    lsRemove(LS_SNAPSHOT);
    lsRemove('cortex.booted'); // replay the boot animation on next load
    location.reload();
  });

  /* ============================== 7. CHAT ============================== */

  var chatMessagesEl = $('#chat-messages');
  var chatForm = $('#chat-form');
  var chatInput = $('#chat-input');
  var chatSendBtn = $('#chat-send');
  var chatSuggestions = $('#chat-suggestions');

  function saveChatHistory() {
    var trimmed = state.chatHistory.slice(-MAX_CHAT_HISTORY);
    state.chatHistory = trimmed;
    lsSet(LS_CHAT, trimmed);
  }

  function scrollChatToBottom() {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function appendMessageBubble(role, htmlContent) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'msg-user' : role === 'error' ? 'msg-error' : 'msg-agent');
    var content = document.createElement('div');
    content.className = 'msg-content';
    content.innerHTML = htmlContent;
    wrap.appendChild(content);
    chatMessagesEl.appendChild(wrap);
    scrollChatToBottom();
    return content;
  }

  function appendUserMessage(text) {
    appendMessageBubble('user', '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>');
  }

  function appendErrorMessage(text) {
    appendMessageBubble('error', '<p>' + escapeHtml(text) + '</p>');
  }

  function appendTypingIndicator() {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-agent typing-wrap';
    wrap.innerHTML = '<div class="typing-indicator"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    chatMessagesEl.appendChild(wrap);
    scrollChatToBottom();
    return wrap;
  }

  function appendToolChip(name) {
    var chip = document.createElement('div');
    chip.className = 'tool-chip tool-start';
    chip.innerHTML = '<span class="tool-icon">⚡</span><span class="tool-name"></span>';
    chip.querySelector('.tool-name').textContent = 'consultando ' + name + '...';
    chatMessagesEl.appendChild(chip);
    scrollChatToBottom();
    return chip;
  }

  function renderChatHistory() {
    chatMessagesEl.innerHTML = '';
    state.chatHistory.forEach(function (m) {
      if (m.role === 'user') {
        appendMessageBubble('user', '<p>' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>');
      } else {
        appendMessageBubble('assistant', renderMarkdown(m.content));
      }
    });
  }

  function setChatBusy(busy) {
    state.chatBusy = busy;
    chatSendBtn.disabled = busy;
    chatInput.disabled = busy;
  }

  function autoGrowTextarea() {
    chatInput.style.height = 'auto';
    var lineHeight = parseFloat(getComputedStyle(chatInput).lineHeight || '20') || 20;
    var maxPx = lineHeight * 4 + 20;
    chatInput.style.height = Math.min(chatInput.scrollHeight, maxPx) + 'px';
  }

  chatInput.addEventListener('input', autoGrowTextarea);

  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (chatForm.requestSubmit) { chatForm.requestSubmit(); } else { submitChat(); }
    }
  });

  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    submitChat();
  });

  chatSuggestions.addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn || state.chatBusy) return;
    chatInput.value = btn.getAttribute('data-msg');
    submitChat();
  });

  async function submitChat() {
    var text = chatInput.value.trim();
    if (!text || state.chatBusy) return;

    chatInput.value = '';
    autoGrowTextarea();

    appendUserMessage(text);
    state.chatHistory.push({ role: 'user', content: text });
    saveChatHistory();

    if (REFRESH_COMMAND_RE.test(text)) {
      // aguarda o refresh terminar ANTES de perguntar ao agente, senao ele
      // responde com o snapshot velho (corrida refresh vs sendToAgent).
      try {
        await refreshSnapshot(state.period);
      } catch (e) {
        // refresh falhou - segue com o snapshot antigo mesmo assim
      }
    }

    sendToAgent();
  }

  async function sendToAgent() {
    setChatBusy(true);
    var typingEl = appendTypingIndicator();
    var assistantContentEl = null;
    var assistantText = ''; // texto completo do turno (persistido no historico)
    var bubbleText = ''; // texto apenas da bolha corrente (zera a cada rodada de tools)
    var toolChips = {}; // name -> array of pending chip elements (FIFO)

    function ensureAssistantBubble() {
      if (assistantContentEl) return;
      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
      assistantContentEl = appendMessageBubble('assistant', '');
    }

    function handleToolEvent(data) {
      if (!data || !data.name) return;
      if (data.status === 'start') {
        // Finaliza a bolha corrente: a proxima rodada de deltas (apos as tools)
        // deve abrir uma bolha NOVA, renderizada abaixo dos chips, em vez de
        // continuar acrescentando texto numa bolha que ja ficou acima deles.
        // Zera SO o buffer visual; assistantText (historico) segue acumulando,
        // com quebra de paragrafo entre os segmentos.
        if (bubbleText) assistantText += '\n\n';
        bubbleText = '';
        assistantContentEl = null;
        var chip = appendToolChip(data.name);
        if (!toolChips[data.name]) toolChips[data.name] = [];
        toolChips[data.name].push(chip);
      } else if (data.status === 'end') {
        var queue = toolChips[data.name];
        var chip2 = queue && queue.length ? queue.shift() : null;
        if (chip2) {
          chip2.classList.remove('tool-start');
          chip2.classList.add(data.ok === false ? 'tool-fail' : 'tool-ok');
          var nameEl = chip2.querySelector('.tool-name');
          var icon = chip2.querySelector('.tool-icon');
          if (icon) icon.textContent = data.ok === false ? '✗' : '✓';
          if (nameEl) nameEl.textContent = data.name + (data.ok === false ? ' - falhou' : ' - ok');
        }
      }
    }

    try {
      // O backend tem limit de 2mb no body; snapshot bruto pode estourar isso.
      // Se for grande demais, manda uma versao reduzida (o agente ja sabe usar
      // as ferramentas quando o snapshot esta incompleto).
      var snapshotPayload = state.snapshot;
      try {
        if (snapshotPayload && JSON.stringify(snapshotPayload).length > 1500000) {
          snapshotPayload = {
            timestamp: snapshotPayload.timestamp,
            period: snapshotPayload.period,
            errors: snapshotPayload.errors,
            note: 'snapshot muito grande - responda usando as ferramentas'
          };
        }
      } catch (sizeErr) {
        // stringify falhou de forma inesperada - manda o snapshot como esta
      }

      var chatBody = {
        messages: state.chatHistory,
        managerName: state.config.name,
        moodlrToken: state.config.moodlrToken,
        model: state.config.model,
        snapshot: snapshotPayload
      };
      // ruler-mcp (price floors) e' opcional - so manda os campos quando o
      // gestor de fato configurou as keys, pra o backend saber que as tools
      // de price floor estao disponiveis.
      if (state.config.rulerToken) chatBody.rulerToken = state.config.rulerToken;
      if (state.config.avBearer) chatBody.avBearer = state.config.avBearer;

      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody)
      });

      if (res.status === 413) {
        throw new Error('SNAPSHOT_TOO_LARGE');
      }

      if (!res.ok || !res.body) {
        throw new Error('HTTP ' + res.status);
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var done = false;
      var sawError = false;

      while (!done) {
        var chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) {
          buffer += decoder.decode(chunk.value, { stream: true });
        }

        var parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep last (possibly incomplete) part in buffer

        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (!part || !part.trim()) continue;

          var eventType = 'message';
          var dataLines = [];
          var rawLines = part.split('\n');
          for (var j = 0; j < rawLines.length; j++) {
            var line = rawLines[j];
            if (line.indexOf('event:') === 0) {
              eventType = line.slice(6).trim();
            } else if (line.indexOf('data:') === 0) {
              dataLines.push(line.slice(5).trim());
            }
          }
          var dataStr = dataLines.join('\n');
          var data = {};
          if (dataStr) {
            try { data = JSON.parse(dataStr); } catch (e) { continue; }
          }

          if (eventType === 'delta') {
            ensureAssistantBubble();
            assistantText += (data.text || '');
            bubbleText += (data.text || '');
            assistantContentEl.innerHTML = renderMarkdown(bubbleText);
            scrollChatToBottom();
          } else if (eventType === 'tool') {
            handleToolEvent(data);
          } else if (eventType === 'tooldata') {
            // tools do ruler (price floors) tambem alimentam o dashboard de FLOORS
            // direto do chat - nao afeta o parsing de delta/tool/error/done acima.
            handleFloorsToolData(data);
          } else if (eventType === 'error') {
            sawError = true;
            if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
            // texto parcial nao e resposta completa - nao persiste no historico.
            // Marca a bolha visualmente como interrompida (ou remove se vazia).
            if (assistantContentEl) {
              if (bubbleText) {
                var interruptedTag = document.createElement('span');
                interruptedTag.className = 'msg-interrupted';
                interruptedTag.textContent = ' — [interrompido]';
                assistantContentEl.appendChild(interruptedTag);
              } else if (assistantContentEl.parentNode) {
                chatMessagesEl.removeChild(assistantContentEl.parentNode);
              }
              assistantContentEl = null;
            }
            appendErrorMessage(data.message || 'Erro no agente.');
          } else if (eventType === 'done') {
            // finalize below, after loop
          }
        }
      }

      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);

      if (assistantText && !sawError) {
        state.chatHistory.push({ role: 'assistant', content: assistantText });
        saveChatHistory();
      } else if (!assistantText && !sawError) {
        // no content and no explicit error - avoid silently breaking the UI
        appendErrorMessage('O agente nao retornou conteudo. Tente novamente.');
      }
    } catch (err) {
      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
      if (err && err.message === 'SNAPSHOT_TOO_LARGE') {
        appendErrorMessage('Snapshot grande demais para o chat — atualize os dados ou pergunte direto.');
      } else {
        appendErrorMessage('Falha de conexao com o CORTEX. Verifique a rede e tente de novo.');
        setMoodlrConnStatus(false);
      }
    } finally {
      setChatBusy(false);
      chatInput.focus();
    }
  }

  function greetIfEmpty() {
    // SO-UI: a saudacao NUNCA entra em state.chatHistory/localStorage. Se persistida,
    // ela viraria a primeira mensagem role:assistant no payload de /api/chat, e a
    // API da Anthropic exige que a primeira mensagem seja role:user.
    if (state.chatHistory.length > 0) return;
    var name = state.config && state.config.name ? state.config.name : '';
    var greeting = 'E ai' + (name ? ', ' + name : '') + ', bora ver a operacao?';
    appendMessageBubble('assistant', renderMarkdown(greeting));
  }

  /* ============================== 8. DASHBOARD ============================== */

  var periodPills = $('#period-pills');
  var refreshBtn = $('#refresh-btn');
  var refreshSpinner = $('#refresh-spinner');
  var snapshotAgeEl = $('#snapshot-age');
  var snapshotErrorBadge = $('#snapshot-error-badge');
  var metricNoteEl = $('#metric-note');
  var blogsTbody = $('#blogs-tbody');
  var alertsSection = $('#alerts-section');
  var alertsCountEl = $('#alerts-count');
  var alertsBodyEl = $('#alerts-body');

  periodPills.addEventListener('click', function (e) {
    var btn = e.target.closest('.pill');
    if (!btn) return;
    var period = btn.getAttribute('data-period');
    if (period === state.period) return;
    state.period = period;
    $all('.pill', periodPills).forEach(function (p) {
      var active = p === btn;
      p.classList.toggle('active', active);
      p.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    refreshSnapshot(period);
  });

  refreshBtn.addEventListener('click', function () {
    refreshSnapshot(state.period);
  });

  function setDashLoading(loading) {
    refreshBtn.disabled = loading;
    refreshSpinner.classList.toggle('hidden', !loading);
  }

  async function refreshSnapshot(period) {
    if (!state.config) return;
    setDashLoading(true);
    try {
      var res = await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moodlrToken: state.config.moodlrToken, period: period })
      });
      var json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (res.ok && json && json.ok && json.snapshot) {
        state.snapshot = json.snapshot;
        lsSet(LS_SNAPSHOT, state.snapshot);
        setMoodlrConnStatus(true);
        renderDashboard();
      } else {
        setMoodlrConnStatus(false);
        showSnapshotFetchError((json && json.error) || ('HTTP ' + res.status));
      }
    } catch (e) {
      setMoodlrConnStatus(false);
      showSnapshotFetchError('falha de rede');
    } finally {
      setDashLoading(false);
    }
  }

  function showSnapshotFetchError(msg) {
    snapshotErrorBadge.textContent = 'falha ao atualizar: ' + msg;
    snapshotErrorBadge.title = msg;
    snapshotErrorBadge.classList.remove('hidden');
  }

  function updateSnapshotAge() {
    if (!state.snapshot || !state.snapshot.timestamp) {
      snapshotAgeEl.textContent = 'sem dados';
      snapshotAgeEl.classList.remove('warn');
      return;
    }
    var diffMs = Date.now() - state.snapshot.timestamp;
    var mins = Math.max(0, Math.floor(diffMs / 60000));
    var warn = diffMs > SNAPSHOT_WARN_MS;
    snapshotAgeEl.textContent = 'dados de ha ' + mins + ' min' + (warn ? ' - sugerido atualizar' : '');
    snapshotAgeEl.classList.toggle('warn', warn);
  }

  // ---- defensive normalizers ----

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Chaves financeiras/identificadoras usadas para pontuar candidatos durante
  // a busca profunda em extractRows - testadas contra TODAS as keys do
  // primeiro item de cada candidato (nao contra valores).
  var FINANCIAL_KEY_RE = /receita|revenue|gam_revenue|spend|gasto|net_profit|real_profit|lucro|profit|roi|ecpm|blog|project/i;

  function scoreCandidateRows(rows) {
    if (!rows || !rows.length) return 0;
    var first = rows[0];
    if (!isPlainObject(first)) return 0;
    var keys = Object.keys(first);
    var score = 0;
    for (var i = 0; i < keys.length; i++) {
      if (FINANCIAL_KEY_RE.test(keys[i])) score++;
    }
    return score;
  }

  // Busca recursiva (BFS) na arvore inteira quando os candidatos rasos nao
  // acham nada - o payload real de resumo_usuarios costuma vir aninhado mais
  // fundo (ex.: por gestor -> blogs, ou como mapa id -> objeto). Profundidade
  // maxima 5; protecao contra ciclos via WeakSet (fallback pra array se
  // WeakSet nao existir). Candidato = (a) array com >=1 objeto plano, ou
  // (b) objeto cujos values sao >=2 objetos planos (map keyed).
  function deepFindCandidates(root) {
    var MAX_DEPTH = 5;
    var candidates = []; // {rows, score} - insercao em ordem BFS (mais raso primeiro)
    var hasWeakSet = typeof WeakSet === 'function';
    var visitedSet = hasWeakSet ? new WeakSet() : null;
    var visitedArr = hasWeakSet ? null : [];

    function markSeen(node) {
      if (visitedSet) {
        if (visitedSet.has(node)) return true;
        visitedSet.add(node);
        return false;
      }
      if (visitedArr.indexOf(node) !== -1) return true;
      visitedArr.push(node);
      return false;
    }

    var queue = [{ node: root, depth: 0 }];
    while (queue.length) {
      var cur = queue.shift();
      var node = cur.node;
      var depth = cur.depth;
      if (node === null || typeof node !== 'object') continue;
      if (markSeen(node)) continue;

      if (Array.isArray(node)) {
        if (node.length && isPlainObject(node[0])) {
          candidates.push({ rows: node, score: scoreCandidateRows(node) });
        }
        if (depth < MAX_DEPTH) {
          node.forEach(function (item) {
            if (item !== null && typeof item === 'object') queue.push({ node: item, depth: depth + 1 });
          });
        }
      } else {
        var values = Object.keys(node).map(function (k) { return node[k]; });
        var plainCount = 0;
        for (var vi = 0; vi < values.length; vi++) { if (isPlainObject(values[vi])) plainCount++; }
        if (plainCount >= 2) {
          candidates.push({ rows: values, score: scoreCandidateRows(values) });
        }
        if (depth < MAX_DEPTH) {
          values.forEach(function (v) {
            if (v !== null && typeof v === 'object') queue.push({ node: v, depth: depth + 1 });
          });
        }
      }
    }

    return candidates;
  }

  function extractRows(data) {
    if (data === null || data === undefined) return [];
    var candidates = [data, data.rows, data.projetos, data.items, data.data];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (Array.isArray(c) && c.length && typeof c[0] === 'object' && c[0] !== null) return c;
    }
    if (typeof data === 'object' && !Array.isArray(data)) {
      var vals = Object.keys(data).map(function (k) { return data[k]; });
      // Exige >=2 valores-objeto pra tratar como "map keyed" (mesmo criterio
      // do candidato (b) na busca profunda). Com >=1 isso capturava wrappers
      // triviais de uma chave so (ex.: {data: {...}}) como se fossem a linha
      // certa, o que impedia o fallback recursivo abaixo de rodar.
      var plainValsCount = 0;
      for (var vi = 0; vi < vals.length; vi++) { if (isPlainObject(vals[vi])) plainValsCount++; }
      if (plainValsCount >= 2) return vals;
    }

    // Caminho dedicado pro shape REAL confirmado em producao: data.users[]
    // (um por gestor), cada um com .projetos[] (um por blog). As linhas que
    // interessam pro dashboard sao os projetos, entao concatena os projetos
    // de todos os usuarios antes de cair no fallback recursivo generico.
    if (data && Array.isArray(data.users) && data.users.length) {
      var fromUsers = [];
      var usersHaveProjetos = false;
      data.users.forEach(function (u) {
        if (u && Array.isArray(u.projetos)) {
          usersHaveProjetos = true;
          u.projetos.forEach(function (p) { fromUsers.push(p); });
        }
      });
      if (usersHaveProjetos && fromUsers.length) return fromUsers;
    }

    // Nada encontrado nos candidatos rasos - busca recursiva na arvore
    // inteira, pontua cada candidato pelas chaves financeiras e usa o de
    // maior pontuacao (empate: o mais raso, ja garantido pela ordem BFS +
    // sort estavel).
    var deep = deepFindCandidates(data);
    if (deep.length) {
      deep.sort(function (a, b) { return b.score - a.score; });
      if (deep[0].score > 0) return deep[0].rows;
    }
    return [];
  }

  // Lista apenas NOMES de chaves (nunca valores) ate `maxDepth` niveis - usado
  // so pro diagnostico no console quando o formato do snapshot nao e
  // reconhecido, sem arriscar despejar dado sensivel.
  function summarizeKeysForDiagnostics(obj, maxDepth) {
    if (obj === null || typeof obj !== 'object') return typeof obj;
    if (maxDepth <= 0) return Array.isArray(obj) ? '[array]' : '[object]';
    if (Array.isArray(obj)) {
      if (!obj.length) return '[array vazio]';
      return ['[array len=' + obj.length + ']', summarizeKeysForDiagnostics(obj[0], maxDepth - 1)];
    }
    var out = {};
    Object.keys(obj).forEach(function (k) {
      out[k] = summarizeKeysForDiagnostics(obj[k], maxDepth - 1);
    });
    return out;
  }

  function resolveNome(row) {
    var direct = pick(row, ['blog_name', 'blog', 'nome', 'name', 'projeto', 'project', 'site', 'domain']);
    if (direct) return direct;
    var id = pick(row, ['id', 'id_blog', 'idBlog', 'project_id']);
    if (id !== undefined && projectNames[id]) return projectNames[id];
    return '—';
  }

  // Shape real confirmado em producao (resumo_usuarios): os financeiros NAO
  // sao flat no objeto do projeto, vem aninhados em sub-objetos por dominio:
  //   active_view: { revenue, item_level_impressions, ... }  (receita bruta)
  //   investment:  { spend, results, cost_per_result }
  //   billing:     { gross_profit, revshare_profit, net_profit, commission, roi_percentage }
  // Prioriza esses caminhos aninhados; cai pros picks flat (shapes antigos/
  // outras tools) quando o sub-objeto nao existe.
  function normalizeRow(row) {
    var receita = (row && row.active_view) ? toNumber(row.active_view.revenue) : null;
    if (receita === null) {
      receita = toNumber(pick(row, ['receita', 'revenue', 'gam_revenue', 'adx_revenue', 'receita_adx', 'receita_total', 'adx']));
    }

    var gasto = (row && row.investment) ? toNumber(row.investment.spend) : null;
    if (gasto === null) {
      gasto = toNumber(pick(row, ['gasto', 'spend', 'gasto_fb', 'fb_spend', 'custo', 'cost']));
    }

    // net_profit/real_profit sao os liquidos (regra de revshare da operacao) -
    // o numero real, priorizados sobre profit generico.
    var lucro = (row && row.billing) ? toNumber(row.billing.net_profit) : null;
    if (lucro === null) {
      lucro = toNumber(pick(row, ['lucro', 'net_profit', 'real_profit', 'profit', 'resultado']));
    }
    if (lucro === null && receita !== null && gasto !== null) lucro = receita - gasto;

    // billing.roi_percentage NAO e confiavel (valor observado nao bate com
    // net_profit/spend - semantica ambigua no payload real). Prioriza sempre
    // o calculo lucro/gasto*100, que fica consistente com a coluna de lucro
    // (liquido) exibida na tabela; so cai pro pick flat se o calculo nao for
    // possivel (falta lucro ou gasto).
    var roi = (lucro !== null && gasto) ? (lucro / gasto) * 100 : null;
    if (roi === null) {
      roi = toNumber(pick(row, ['roi', 'roi_pct']));
    }

    var ecpm = null;
    if (row && row.active_view && row.active_view.revenue !== undefined && row.active_view.item_level_impressions) {
      var avRevenue = toNumber(row.active_view.revenue);
      var avImpressions = toNumber(row.active_view.item_level_impressions);
      if (avRevenue !== null && avImpressions) ecpm = (avRevenue / avImpressions) * 1000;
    }
    if (ecpm === null) {
      ecpm = toNumber(pick(row, ['ecpm', 'ecpm_medio', 'cpm']));
    }

    return { nome: resolveNome(row), receita: receita, gasto: gasto, lucro: lucro, roi: roi, ecpm: ecpm };
  }

  function renderMetricCards(rows) {
    var totals = { receita: 0, gasto: 0, lucro: 0 };
    var any = false;

    rows.forEach(function (r) {
      if (r.receita !== null) { totals.receita += r.receita; any = true; }
      if (r.gasto !== null) { totals.gasto += r.gasto; any = true; }
      if (r.lucro !== null) { totals.lucro += r.lucro; any = true; }
    });

    var roiTotal = totals.gasto ? (totals.lucro / totals.gasto) * 100 : null;

    if (!any) {
      $('#metric-receita').textContent = '—';
      $('#metric-gasto').textContent = '—';
      $('#metric-lucro').textContent = '—';
      $('#metric-roi').textContent = '—';
      metricNoteEl.textContent = 'formato de dados desconhecido - pergunte ao agente';
      metricNoteEl.classList.remove('hidden');
      return;
    }

    metricNoteEl.classList.add('hidden');
    $('#metric-receita').textContent = formatCurrencyUSD(totals.receita);
    $('#metric-gasto').textContent = formatCurrencyUSD(totals.gasto);

    var lucroEl = $('#metric-lucro');
    lucroEl.textContent = formatCurrencyUSD(totals.lucro);
    lucroEl.classList.toggle('positive', totals.lucro > 0);
    lucroEl.classList.toggle('negative', totals.lucro < 0);

    var roiEl = $('#metric-roi');
    roiEl.textContent = formatPct(roiTotal);
    roiEl.classList.toggle('positive', roiTotal !== null && roiTotal > 0);
    roiEl.classList.toggle('negative', roiTotal !== null && roiTotal < 0);
  }

  function renderBlogsTable(rows) {
    blogsTbody.innerHTML = '';
    if (!rows.length) {
      var tr = document.createElement('tr');
      tr.className = 'empty-row';
      tr.innerHTML = '<td colspan="6">sem dados ainda</td>';
      blogsTbody.appendChild(tr);
      return;
    }

    var sorted = rows.slice().sort(function (a, b) {
      var la = a.lucro === null ? -Infinity : a.lucro;
      var lb = b.lucro === null ? -Infinity : b.lucro;
      return lb - la;
    });

    sorted.forEach(function (r) {
      var tr = document.createElement('tr');

      var lucroClass = r.lucro === null ? 'neutral' : (r.lucro >= 0 ? 'positive' : 'negative');
      var roiClass = r.roi === null ? 'neutral' : (r.roi >= 0 ? 'positive' : 'negative');

      tr.innerHTML =
        '<td>' + escapeHtml(r.nome) + '</td>' +
        '<td>' + formatCurrencyUSD(r.receita) + '</td>' +
        '<td>' + formatCurrencyUSD(r.gasto) + '</td>' +
        '<td>' + formatEcpm(r.ecpm) + '</td>' +
        '<td><span class="pill-value ' + lucroClass + '">' + formatCurrencyUSD(r.lucro) + '</span></td>' +
        '<td><span class="pill-value ' + roiClass + '">' + formatPct(r.roi) + '</span></td>';
      blogsTbody.appendChild(tr);
    });
  }

  var ALERT_MAX_FIELDS = 4;
  var ALERTS_MAX_PER_SOURCE = 12;

  function describeAlertItem(item) {
    if (item === null || item === undefined) return '';
    if (typeof item !== 'object') return escapeHtml(String(item));

    // Prioridade: status/pais continuam sempre presentes quando existirem;
    // nome/adset/campanha/blog/score preenchem os slots restantes ate o cap
    // de ALERT_MAX_FIELDS por item (card nao pode virar uma parede de texto).
    var fieldDefs = [
      ['status', ['status', 'estado']],
      ['pais', ['country', 'pais']],
      ['nome', ['nome', 'name', 'conta', 'account', 'account_name']],
      ['adset', ['adset', 'adset_name', 'ad_set']],
      ['campanha', ['campanha', 'campaign', 'campaign_name']],
      ['blog', ['blog', 'blog_nome', 'site']],
      ['score', ['score', 'severidade']],
      ['motivo', ['motivo', 'reason', 'issue', 'problema']],
      ['roi', ['roi', 'roi_liquido', 'net_roi']]
    ];

    var found = [];
    for (var i = 0; i < fieldDefs.length && found.length < ALERT_MAX_FIELDS; i++) {
      var val = pick(item, fieldDefs[i][1]);
      if (val === undefined || val === null || val === '') continue;
      found.push([fieldDefs[i][0], val]);
    }

    var html = '';
    found.forEach(function (f) {
      html += '<span class="alert-kv"><span class="alert-field">' + escapeHtml(f[0]) + '</span>' + escapeHtml(String(f[1])) + '</span>';
    });

    if (!html) {
      // fallback: dump whatever primitive-ish keys exist
      var keys = Object.keys(item).slice(0, ALERT_MAX_FIELDS);
      keys.forEach(function (k) {
        var v = item[k];
        if (v === null || v === undefined || typeof v === 'object') return;
        html += '<span class="alert-kv"><span class="alert-field">' + escapeHtml(k) + '</span>' + escapeHtml(String(v)) + '</span>';
      });
    }

    return html || 'item sem detalhes reconheciveis';
  }

  function renderAlertGroup(title, items) {
    if (!items.length) return '';
    var html = '<div class="alert-source-title">' + escapeHtml(title) + ' (' + items.length + ')</div>';
    var shown = items.slice(0, ALERTS_MAX_PER_SOURCE);
    shown.forEach(function (item) {
      html += '<div class="alert-item">' + describeAlertItem(item) + '</div>';
    });
    var extra = items.length - shown.length;
    if (extra > 0) {
      html += '<div class="alert-more">+ ' + extra + ' alertas — pergunte ao agente pra priorizar</div>';
    }
    return html;
  }

  function renderAlerts(snapshot) {
    var saudeSource = snapshot.saudeContasFb ? (snapshot.saudeContasFb.data !== undefined ? snapshot.saudeContasFb.data : snapshot.saudeContasFb) : null;
    var fadigaSource = snapshot.fadigaCriativo ? (snapshot.fadigaCriativo.data !== undefined ? snapshot.fadigaCriativo.data : snapshot.fadigaCriativo) : null;

    var saudeItems = extractRows(saudeSource);
    var fadigaItems = extractRows(fadigaSource);

    var total = saudeItems.length + fadigaItems.length;

    if (total === 0) {
      alertsSection.classList.remove('has-alerts');
      alertsCountEl.textContent = '';
      alertsBodyEl.innerHTML = '<div class="alerts-empty">// SEM ALERTAS - OPERACAO NOMINAL</div>';
      return;
    }

    alertsSection.classList.add('has-alerts');
    alertsCountEl.textContent = String(total);
    alertsBodyEl.innerHTML =
      renderAlertGroup('Saude contas FB', saudeItems) +
      renderAlertGroup('Fadiga de criativo', fadigaItems);
  }

  function renderSnapshotErrors(snapshot) {
    var errs = snapshot.errors;
    if (!Array.isArray(errs) || !errs.length) {
      snapshotErrorBadge.classList.add('hidden');
      return;
    }
    var detail = errs.map(function (e) {
      return (e && e.tool ? e.tool : '?') + ': ' + (e && e.error ? e.error : 'erro desconhecido');
    }).join(' | ');
    snapshotErrorBadge.textContent = 'snapshot parcial (' + errs.length + ' falhas)';
    snapshotErrorBadge.title = detail;
    snapshotErrorBadge.classList.remove('hidden');
  }

  function renderDashboard() {
    var snapshot = state.snapshot;
    updateSnapshotAge();

    if (!snapshot) {
      renderMetricCards([]);
      renderBlogsTable([]);
      alertsBodyEl.innerHTML = '<div class="alerts-empty">// aguardando dados</div>';
      alertsSection.classList.remove('has-alerts');
      alertsCountEl.textContent = '';
      snapshotErrorBadge.classList.add('hidden');
      return;
    }

    rebuildProjectNames();

    var resumoData = snapshot.resumoUsuarios ? (snapshot.resumoUsuarios.data !== undefined ? snapshot.resumoUsuarios.data : snapshot.resumoUsuarios) : null;
    var rawRows = extractRows(resumoData);

    if (!rawRows.length && snapshot.resumoUsuarios !== null && snapshot.resumoUsuarios !== undefined) {
      var diagTarget = (resumoData !== null && resumoData !== undefined) ? resumoData : snapshot.resumoUsuarios;
      console.warn('[cortex] resumoUsuarios com formato nao reconhecido. Chaves de topo:', summarizeKeysForDiagnostics(diagTarget, 2));
    }

    var rows = rawRows.map(normalizeRow);

    renderMetricCards(rows);
    renderBlogsTable(rows);
    renderAlerts(snapshot);
    renderSnapshotErrors(snapshot);
  }

  /* ============================== 8b. FLOORS (price rules ActiveView) ============================== */
  // Sub-aba do dashboard, so visivel quando o gestor configurou rulerToken (onboarding
  // ou "trocar config"). Toda a view roda sobre as rotas /api/ruler/* (contrato
  // congelado): POST rules (carrega resumo+regras), POST sugestoes, POST apply
  // (preview sem confirm, aplica com confirm=true + trava de preview no backend).
  // Shape interno de resumo/rules/sugestoes NAO e garantido -> normalizadores
  // defensivos via pick()/extractRows(), mesmo padrao do dashboard de operacao.

  var dashSubtabs = $('#dash-subtabs');
  var dashViewOperacao = $('#dash-view-operacao');
  var dashViewFloors = $('#dash-view-floors');

  var floorsNetworkInput = $('#floors-network');
  var floorsDomainInput = $('#floors-domain');
  var floorsLoadBtn = $('#floors-load-btn');
  var floorsLoadSpinner = $('#floors-load-spinner');
  var floorsSuggestBtn = $('#floors-suggest-btn');
  var floorsSuggestSpinner = $('#floors-suggest-spinner');
  var floorsStatusEl = $('#floors-status');
  var floorsErrorBadge = $('#floors-error-badge');
  var floorsSuggestionsSection = $('#floors-suggestions-section');
  var floorsSuggestionsBody = $('#floors-suggestions-body');
  var floorsTbody = $('#floors-tbody');
  var floorsReviewBtn = $('#floors-review-btn');
  var floorsReviewCount = $('#floors-review-count');

  var floorsModalOverlay = $('#floors-modal-overlay');
  var floorsModalDiff = $('#floors-modal-diff');
  var floorsModalStatus = $('#floors-modal-status');
  var floorsModalCancel = $('#floors-modal-cancel');
  var floorsModalConfirm = $('#floors-modal-confirm');
  var floorsModalSpinner = $('#floors-modal-spinner');

  var floorsState = {
    network: '',
    domain: '',
    resumoRaw: null,
    rows: [], // [{key, raw, floor, ecpm, revenue, impressions, matchRate, desiredMatchRate, country, device, enabled}]
    modified: {}, // key -> novo valor de floor (numero)
    suggestions: [],
    busy: false, // qualquer request de apply (preview ou confirm) em voo
    pendingKeys: null, // ordem dos keys enviados no ultimo preview
    pendingRules: null, // rules[] enviado no ultimo preview (reusado no confirm)
    pending: null // snapshot congelado do preview {network, domain, rules, keys} p/ o confirm
  };

  var MATCH_RATE_PROBLEM_THRESHOLD = 15; // pontos percentuais de diferenca p/ marcar como problematica

  function initFloorsAvailability() {
    if (!dashSubtabs) return;
    var hasRuler = !!(state.config && state.config.rulerToken);
    dashSubtabs.classList.toggle('hidden', !hasRuler);
    if (!hasRuler) { setDashView('operacao'); }

    var saved = lsGet(LS_FLOORS);
    if (saved) {
      if (floorsNetworkInput && saved.network) floorsNetworkInput.value = saved.network;
      if (floorsDomainInput && saved.domain) floorsDomainInput.value = saved.domain;
    }
  }

  function setDashView(view) {
    if (dashSubtabs) {
      $all('.dash-subtab', dashSubtabs).forEach(function (b) {
        var active = b.getAttribute('data-dashview') === view;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
    if (dashViewOperacao) dashViewOperacao.classList.toggle('hidden', view !== 'operacao');
    if (dashViewFloors) dashViewFloors.classList.toggle('hidden', view !== 'floors');
  }

  if (dashSubtabs) {
    dashSubtabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.dash-subtab');
      if (!btn) return;
      setDashView(btn.getAttribute('data-dashview'));
    });
  }

  // ---- normalizers (defensivos - shape de resumo_floors/listar_price_rules/sugerir_floor nao e garantido) ----

  function normalizeMatchRateValue(n) {
    var v = toNumber(n);
    if (v === null) return null;
    // algumas fontes trazem fracao (0-1), outras ja em pontos percentuais (0-100).
    return Math.abs(v) <= 1 ? v * 100 : v;
  }

  function normalizeFloorRow(raw, idx) {
    var floor = toNumber(pick(raw, ['rule', 'floor', 'floor_price', 'price_floor', 'valor']));
    var ecpm = toNumber(pick(raw, ['eCPM', 'ecpm', 'cpm']));
    var revenue = toNumber(pick(raw, ['revenue', 'receita']));
    var impressions = toNumber(pick(raw, ['impressions', 'impressoes', 'impressões', 'imps', 'item_level_impressions']));
    var matchRate = normalizeMatchRateValue(pick(raw, ['match_rate', 'matchRate']));
    var desiredMatchRate = normalizeMatchRateValue(pick(raw, ['desired_match_rate', 'desiredMatchRate']));
    var country = pick(raw, ['country', 'pais', 'país']);
    var device = pick(raw, ['device']);
    var enabledRaw = pick(raw, ['enabled', 'ativo', 'active']);
    var enabled = enabledRaw === undefined ? null : !!enabledRaw;
    return {
      key: 'r' + idx,
      raw: raw,
      floor: floor,
      ecpm: ecpm,
      revenue: revenue,
      impressions: impressions,
      matchRate: matchRate,
      desiredMatchRate: desiredMatchRate,
      country: country,
      device: device,
      enabled: enabled
    };
  }

  function isFloorRowProblematic(row) {
    if (row.matchRate !== null && row.desiredMatchRate !== null) {
      if (Math.abs(row.matchRate - row.desiredMatchRate) >= MATCH_RATE_PROBLEM_THRESHOLD) return true;
    }
    if (row.revenue === 0 && row.impressions !== null && row.impressions > 0) return true;
    return false;
  }

  function normalizeFloorsResumo(resumoPayload) {
    if (!resumoPayload) return null;
    var data = resumoPayload.data !== undefined ? resumoPayload.data : resumoPayload;
    if (!data || typeof data !== 'object') return null;
    var revenue = toNumber(pick(data, ['revenue', 'revenue_total', 'receita', 'receita_total']));
    var ecpmMedio = toNumber(pick(data, ['ecpm_medio', 'ecpm_ponderado', 'ecpm', 'eCPM', 'avg_ecpm']));
    var regrasAtivas = toNumber(pick(data, ['regras_ativas', 'active_rules', 'ativas', 'rules_ativas', 'count_ativas']));
    var problematicasRaw = pick(data, ['regras_problematicas', 'problematic_rules', 'problematicas']);
    var problematicasCount = null;
    if (Array.isArray(problematicasRaw)) problematicasCount = problematicasRaw.length;
    else if (problematicasRaw !== undefined) problematicasCount = toNumber(problematicasRaw);
    return { revenue: revenue, ecpmMedio: ecpmMedio, regrasAtivas: regrasAtivas, problematicasCount: problematicasCount };
  }

  function normalizeSuggestion(item) {
    var alvo = pick(item, ['regra', 'rule', 'target', 'regra_alvo', 'nome']);
    var floorAtual = toNumber(pick(item, ['floor_atual', 'current_floor', 'floor', 'rule_atual']));
    var floorSugerido = toNumber(pick(item, ['floor_sugerido', 'suggested_floor', 'novo_floor', 'new_floor']));
    var direcao = pick(item, ['direcao', 'direction', 'acao', 'action']);
    var justificativa = pick(item, ['justificativa', 'reason', 'motivo', 'explanation']);
    var confianca = pick(item, ['confianca', 'confidence', 'score']);
    var country = pick(item, ['country', 'pais', 'país']);
    var device = pick(item, ['device']);
    return {
      raw: item, alvo: alvo, floorAtual: floorAtual, floorSugerido: floorSugerido,
      direcao: direcao, justificativa: justificativa, confianca: confianca, country: country, device: device
    };
  }

  function describeRowIdentity(row) {
    var parts = [];
    if (row.country) parts.push(row.country);
    if (row.device) parts.push(row.device);
    var uri = pick(row.raw, ['request_uri', 'uri', 'path']);
    if (uri) parts.push(uri);
    var adUnit = pick(row.raw, ['ad_unit', 'adUnit']);
    if (adUnit) parts.push(adUnit);
    return parts.length ? parts.join(' · ') : ('regra ' + row.key);
  }

  function findFloorsRow(key) {
    for (var i = 0; i < floorsState.rows.length; i++) {
      if (floorsState.rows[i].key === key) return floorsState.rows[i];
    }
    return null;
  }

  function matchSuggestionToRowKey(s) {
    var rows = floorsState.rows;
    if (!rows.length) return null;
    var bestKey = null, bestScore = 0;
    rows.forEach(function (r) {
      var score = 0;
      if (s.country && r.country && String(s.country).toLowerCase() === String(r.country).toLowerCase()) score++;
      if (s.device && r.device && String(s.device).toLowerCase() === String(r.device).toLowerCase()) score++;
      if (s.floorAtual !== null && r.floor !== null && Math.abs(s.floorAtual - r.floor) < 0.001) score++;
      if (score > bestScore) { bestScore = score; bestKey = r.key; }
    });
    return bestScore >= 1 ? bestKey : null;
  }

  // ---- rendering ----

  function renderFloorsCards(resumoNorm) {
    var revenueEl = $('#floors-metric-revenue');
    var ecpmEl = $('#floors-metric-ecpm');
    var ativasEl = $('#floors-metric-ativas');
    var probEl = $('#floors-metric-problematicas');
    var probCard = $('#floors-card-problematicas');
    if (!revenueEl) return;

    var revenue = resumoNorm ? resumoNorm.revenue : null;
    var ecpm = resumoNorm ? resumoNorm.ecpmMedio : null;
    var ativas = resumoNorm && resumoNorm.regrasAtivas !== null && resumoNorm.regrasAtivas !== undefined ? resumoNorm.regrasAtivas : null;
    var problematicas = resumoNorm && resumoNorm.problematicasCount !== null && resumoNorm.problematicasCount !== undefined ? resumoNorm.problematicasCount : null;

    if ((ativas === null || ativas === undefined) && floorsState.rows.length) {
      ativas = floorsState.rows.filter(function (r) { return r.enabled !== false; }).length;
    }
    if ((problematicas === null || problematicas === undefined) && floorsState.rows.length) {
      problematicas = floorsState.rows.filter(isFloorRowProblematic).length;
    }

    revenueEl.textContent = formatCurrencyUSD(revenue);
    ecpmEl.textContent = formatEcpm(ecpm);
    ativasEl.textContent = (ativas === null || ativas === undefined) ? '—' : String(ativas);
    probEl.textContent = (problematicas === null || problematicas === undefined) ? '—' : String(problematicas);

    var hasProblems = problematicas !== null && problematicas !== undefined && problematicas > 0;
    if (probCard) probCard.classList.toggle('metric-card-alert', hasProblems);
  }

  function renderFloorsTable() {
    if (!floorsTbody) return;
    floorsTbody.innerHTML = '';
    if (!floorsState.rows.length) {
      var tr0 = document.createElement('tr');
      tr0.className = 'empty-row';
      tr0.innerHTML = '<td colspan="8">sem regras pra este network + domain</td>';
      floorsTbody.appendChild(tr0);
      return;
    }

    floorsState.rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-key', r.key);
      if (isFloorRowProblematic(r)) tr.classList.add('floor-row-problematic');
      if (floorsState.modified.hasOwnProperty(r.key)) tr.classList.add('floor-row-modified');

      var floorValue = floorsState.modified.hasOwnProperty(r.key) ? floorsState.modified[r.key] : r.floor;
      var floorAttr = (floorValue === null || floorValue === undefined || isNaN(floorValue)) ? '' : floorValue;
      var statusHtml = r.enabled === null ? '—' : (r.enabled ? '<span class="pill-value positive">ON</span>' : '<span class="pill-value neutral">OFF</span>');

      tr.innerHTML =
        '<td><input type="number" step="0.01" class="floor-input" id="floor-input-' + r.key + '" data-key="' + r.key + '" value="' + floorAttr + '" aria-label="Floor da regra ' + escapeHtml(describeRowIdentity(r)) + '" /></td>' +
        '<td>' + formatEcpm(r.ecpm) + '</td>' +
        '<td>' + formatCurrencyUSD(r.revenue) + '</td>' +
        '<td>' + formatIntBR(r.impressions) + '</td>' +
        '<td>' + formatPct1(r.matchRate) + ' / ' + formatPct1(r.desiredMatchRate) + '</td>' +
        '<td>' + (r.country ? escapeHtml(String(r.country)) : '—') + '</td>' +
        '<td>' + (r.device ? escapeHtml(String(r.device)) : '—') + '</td>' +
        '<td>' + statusHtml + '</td>';
      floorsTbody.appendChild(tr);
    });
  }

  function updateFloorsReviewButton() {
    if (!floorsReviewBtn) return;
    var count = Object.keys(floorsState.modified).length;
    if (floorsReviewCount) floorsReviewCount.textContent = String(count);
    floorsReviewBtn.classList.toggle('hidden', count === 0);
  }

  function renderFloorsSuggestions() {
    if (!floorsSuggestionsSection || !floorsSuggestionsBody) return;
    var list = floorsState.suggestions || [];
    if (!list.length) {
      floorsSuggestionsSection.classList.add('hidden');
      floorsSuggestionsBody.innerHTML = '';
      return;
    }
    floorsSuggestionsSection.classList.remove('hidden');
    floorsSuggestionsBody.innerHTML = '';
    list.forEach(function (s, idx) {
      var matchKey = matchSuggestionToRowKey(s);
      var dirText = s.direcao ? String(s.direcao) : '—';
      var dirClass = /sob|subir|up/i.test(dirText) ? 'positive' : /desc|descer|down/i.test(dirText) ? 'negative' : 'neutral';
      var label = s.alvo ? String(s.alvo) : ([s.country, s.device].filter(Boolean).join(' · ') || ('sugestão ' + (idx + 1)));

      var card = document.createElement('div');
      card.className = 'suggestion-item';
      card.innerHTML =
        '<div class="suggestion-head">' +
          '<span class="pill-value ' + dirClass + '">' + escapeHtml(dirText) + '</span>' +
          '<span class="suggestion-target">' + escapeHtml(label) + '</span>' +
        '</div>' +
        '<div class="suggestion-body"><span class="floor-diff-values">' + formatFloorNum(s.floorAtual) + ' <span class="floor-diff-arrow">&rarr;</span> <span class="floor-diff-new">' + formatFloorNum(s.floorSugerido) + '</span></span>' +
        (s.confianca !== undefined && s.confianca !== null && s.confianca !== '' ? ' <span class="dim">// confiança: ' + escapeHtml(String(s.confianca)) + '</span>' : '') +
        '</div>' +
        (s.justificativa ? '<div class="suggestion-justif">' + escapeHtml(String(s.justificativa)) + '</div>' : '') +
        (matchKey && s.floorSugerido !== null && s.floorSugerido !== undefined
          ? '<button type="button" class="suggestion-apply-btn" data-key="' + matchKey + '" data-floor="' + s.floorSugerido + '">aplicar sugestão</button>'
          : '<span class="dim suggestion-no-match">regra correspondente não encontrada na tabela</span>');
      floorsSuggestionsBody.appendChild(card);
    });
  }

  if (floorsSuggestionsBody) {
    floorsSuggestionsBody.addEventListener('click', function (e) {
      var btn = e.target.closest('.suggestion-apply-btn');
      if (!btn) return;
      var key = btn.getAttribute('data-key');
      var floor = parseFloat(btn.getAttribute('data-floor'));
      if (!key || isNaN(floor)) return;
      var input = document.getElementById('floor-input-' + key);
      if (!input) return;
      input.value = floor;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus();
    });
  }

  if (floorsTbody) {
    floorsTbody.addEventListener('input', function (e) {
      var input = e.target.closest('.floor-input');
      if (!input) return;
      var key = input.getAttribute('data-key');
      var row = findFloorsRow(key);
      if (!row) return;
      var tr = input.closest('tr');
      var raw = input.value.trim();

      if (raw === '') {
        delete floorsState.modified[key];
        if (tr) tr.classList.remove('floor-row-modified');
        updateFloorsReviewButton();
        return;
      }
      var newVal = parseFloat(raw);
      if (isNaN(newVal)) return; // digitacao incompleta (ex.: "-", ".") - espera valor valido

      var changed = (row.floor === null || row.floor === undefined) ? true : (newVal !== row.floor);
      if (changed) {
        floorsState.modified[key] = newVal;
        if (tr) tr.classList.add('floor-row-modified');
      } else {
        delete floorsState.modified[key];
        if (tr) tr.classList.remove('floor-row-modified');
      }
      updateFloorsReviewButton();
    });
  }

  // ---- errors / status ----

  function showFloorsError(msg) {
    if (!floorsErrorBadge) return;
    floorsErrorBadge.textContent = msg;
    floorsErrorBadge.title = msg;
    floorsErrorBadge.classList.remove('hidden');
  }
  function hideFloorsError() {
    if (floorsErrorBadge) floorsErrorBadge.classList.add('hidden');
  }
  function setFloorsStatusText(msg) {
    if (floorsStatusEl) floorsStatusEl.textContent = msg;
  }
  function handleFloorsLoadError(res, json) {
    // av_bearer ausente e a causa mais provavel de falha nas tools de floor
    // (elas exigem essa credencial) - orienta direto pra correcao, mesmo sem
    // certeza absoluta de que foi essa a causa do erro especifico.
    if (!state.config.avBearer) {
      showFloorsError('configure a key da ActiveView em trocar config');
      return;
    }
    var msg = (json && json.error) ? json.error : ('HTTP ' + res.status);
    if (res.status === 401) msg = 'key inválida (ruler-mcp ou av_bearer) — ' + msg;
    showFloorsError(msg);
  }

  // ---- data fetch ----

  function setFloorsLoading(loading) {
    if (floorsLoadBtn) floorsLoadBtn.disabled = loading;
    if (floorsLoadSpinner) floorsLoadSpinner.classList.toggle('hidden', !loading);
  }
  function setFloorsSuggestLoading(loading) {
    if (floorsSuggestBtn) floorsSuggestBtn.disabled = loading || !floorsState.network || !floorsState.domain;
    if (floorsSuggestSpinner) floorsSuggestSpinner.classList.toggle('hidden', !loading);
  }

  function applyFloorsPayload(json) {
    var rulesData = json.rules ? (json.rules.data !== undefined ? json.rules.data : json.rules) : null;
    var rawRows = extractRows(rulesData);
    floorsState.rows = rawRows.map(normalizeFloorRow);
    floorsState.resumoRaw = json.resumo || null;
    renderFloorsCards(normalizeFloorsResumo(floorsState.resumoRaw));
    renderFloorsTable();
    updateFloorsReviewButton();
  }

  async function loadFloorsRules(network, domain) {
    if (!state.config || !state.config.rulerToken) return;
    setFloorsLoading(true);
    hideFloorsError();
    setFloorsStatusText('carregando...');
    try {
      var body = { rulerToken: state.config.rulerToken, avBearer: state.config.avBearer, network: network, domain: domain };
      var res = await fetch('/api/ruler/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (res.ok && json && json.ok) {
        floorsState.network = network;
        floorsState.domain = domain;
        floorsState.modified = {};
        applyFloorsPayload(json);
        setFloorsStatusText(network + ' · ' + domain);
        if (json.errors && json.errors.length) {
          showFloorsError('parcial: ' + json.errors.map(function (e) { return e.tool + ': ' + e.error; }).join(' | '));
        }
        if (floorsSuggestBtn) floorsSuggestBtn.disabled = false;
      } else {
        setFloorsStatusText('sem dados');
        handleFloorsLoadError(res, json);
      }
    } catch (e) {
      setFloorsStatusText('sem dados');
      showFloorsError('falha de rede');
    } finally {
      setFloorsLoading(false);
    }
  }

  if (floorsLoadBtn) {
    floorsLoadBtn.addEventListener('click', function () {
      var network = floorsNetworkInput ? floorsNetworkInput.value.trim() : '';
      var domain = floorsDomainInput ? floorsDomainInput.value.trim() : '';
      if (!network || !domain) { showFloorsError('informe network e domain'); return; }
      lsSet(LS_FLOORS, { network: network, domain: domain });
      loadFloorsRules(network, domain);
    });
  }
  [floorsNetworkInput, floorsDomainInput].forEach(function (inp) {
    if (!inp) return;
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); floorsLoadBtn && floorsLoadBtn.click(); }
    });
  });

  if (floorsSuggestBtn) {
    floorsSuggestBtn.addEventListener('click', async function () {
      if (!floorsState.network || !floorsState.domain) return;
      setFloorsSuggestLoading(true);
      try {
        var body = { rulerToken: state.config.rulerToken, avBearer: state.config.avBearer, network: floorsState.network, domain: floorsState.domain };
        var res = await fetch('/api/ruler/sugestoes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        if (res.ok && json && json.ok) {
          applyFloorsSuggestionsPayload(json.data);
        } else {
          showToast((json && json.error) || ('falha ao buscar sugestões (HTTP ' + res.status + ')'), 'error');
        }
      } catch (e) {
        showToast('falha de rede ao buscar sugestões', 'error');
      } finally {
        setFloorsSuggestLoading(false);
      }
    });
  }

  function applyFloorsSuggestionsPayload(rawData) {
    var data = rawData ? (rawData.data !== undefined ? rawData.data : rawData) : null;
    var items = extractRows(data);
    floorsState.suggestions = items.map(normalizeSuggestion);
    renderFloorsSuggestions();
  }

  // ---- apply flow (preview -> modal -> confirm) ----

  function setFloorsApplyBusy(busy) {
    floorsState.busy = busy;
    if (floorsReviewBtn) floorsReviewBtn.disabled = busy;
    if (floorsModalConfirm) floorsModalConfirm.disabled = busy;
    if (floorsModalCancel) floorsModalCancel.disabled = busy;
    if (floorsModalSpinner) floorsModalSpinner.classList.toggle('hidden', !busy);
  }

  function renderDefensiveJson(value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined) return '<span class="dim">—</span>';
    if (typeof value !== 'object') return escapeHtml(String(value));
    if (depth >= 3) return '<span class="dim">…</span>';
    if (Array.isArray(value)) {
      if (!value.length) return '<span class="dim">[]</span>';
      var items = value.slice(0, 20).map(function (v) { return '<li>' + renderDefensiveJson(v, depth + 1) + '</li>'; }).join('');
      var extra = value.length > 20 ? '<li class="dim">+ ' + (value.length - 20) + ' itens</li>' : '';
      return '<ul class="json-dump-list">' + items + extra + '</ul>';
    }
    var keys = Object.keys(value);
    if (!keys.length) return '<span class="dim">{}</span>';
    var rows = keys.slice(0, 30).map(function (k) {
      return '<li><span class="json-dump-key">' + escapeHtml(k) + ':</span> ' + renderDefensiveJson(value[k], depth + 1) + '</li>';
    }).join('');
    return '<ul class="json-dump-list">' + rows + '</ul>';
  }

  function buildFloorsDiffHtml(previewData) {
    var html = '<div class="floor-diff-list">';
    (floorsState.pendingKeys || []).forEach(function (key, i) {
      var row = findFloorsRow(key);
      var newFloor = floorsState.modified[key];
      var label = row ? describeRowIdentity(row) : ('regra ' + (i + 1));
      html += '<div class="floor-diff-row"><span class="floor-diff-label">' + escapeHtml(label) + '</span>' +
        '<span class="floor-diff-values">' + formatFloorNum(row ? row.floor : null) + ' <span class="floor-diff-arrow">&rarr;</span> <span class="floor-diff-new">' + formatFloorNum(newFloor) + '</span></span></div>';
    });
    html += '</div>';
    if (previewData !== null && previewData !== undefined) {
      html += '<div class="floor-diff-raw"><div class="floor-diff-raw-title dim">// resposta do preview</div>' + renderDefensiveJson(previewData, 0) + '</div>';
    }
    return html;
  }

  function openFloorsModal() {
    if (floorsModalOverlay) floorsModalOverlay.classList.remove('hidden');
    if (floorsModalConfirm) floorsModalConfirm.focus();
  }
  function closeFloorsModal() {
    if (floorsModalOverlay) floorsModalOverlay.classList.add('hidden');
    if (floorsModalStatus) { floorsModalStatus.textContent = ''; floorsModalStatus.className = 'ob-status'; }
  }

  async function openFloorsPreview() {
    var keys = Object.keys(floorsState.modified);
    if (!keys.length || floorsState.busy) return;

    var rulesPayload = [];
    keys.forEach(function (key) {
      var row = findFloorsRow(key);
      // B2: sem a regra original não temos os identificadores (country/device/uri…)
      // pra mirar o upsert — NÃO envia uma regra sem identidade (evita catch-all).
      if (!row || !row.raw) return;
      var newFloor = floorsState.modified[key];
      var merged = Object.assign({}, row.raw);
      merged.rule = newFloor;
      if (merged.floor !== undefined) merged.floor = newFloor;
      rulesPayload.push(merged);
    });
    if (!rulesPayload.length) {
      showToast('não consegui montar as alterações (regras sem identificador)', 'error');
      return;
    }

    // M1: CONGELA network/domain + rules no instante do preview. O confirm usa
    // ESTE snapshot — um evento tooldata do chat pode mexer em floorsState.network
    // com o modal aberto, mas o que será aplicado é exatamente o que foi previsto.
    floorsState.pending = {
      network: floorsState.network,
      domain: floorsState.domain,
      rules: rulesPayload,
      keys: keys.slice(),
    };
    floorsState.pendingRules = rulesPayload; // compat com checagens existentes

    setFloorsApplyBusy(true);
    try {
      var body = {
        rulerToken: state.config.rulerToken, avBearer: state.config.avBearer,
        network: floorsState.pending.network, domain: floorsState.pending.domain, rules: rulesPayload
      };
      var res = await fetch('/api/ruler/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      var json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (res.ok && json && json.ok && json.mode === 'preview') {
        if (floorsModalDiff) floorsModalDiff.innerHTML = buildFloorsDiffHtml(json.data);
        openFloorsModal();
      } else if (res.status === 409) {
        showToast('preview expirou, revise as alterações de novo', 'warn');
      } else {
        showToast((json && json.error) || 'falha ao gerar preview das alterações', 'error');
      }
    } catch (e) {
      showToast('falha de rede ao gerar preview', 'error');
    } finally {
      setFloorsApplyBusy(false);
    }
  }

  if (floorsReviewBtn) {
    floorsReviewBtn.addEventListener('click', openFloorsPreview);
  }

  if (floorsModalCancel) {
    floorsModalCancel.addEventListener('click', function () {
      if (floorsState.busy) return;
      closeFloorsModal();
    });
  }

  if (floorsModalOverlay) {
    floorsModalOverlay.addEventListener('click', function (e) {
      if (e.target === floorsModalOverlay && !floorsState.busy) closeFloorsModal();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && floorsModalOverlay && !floorsModalOverlay.classList.contains('hidden') && !floorsState.busy) {
      closeFloorsModal();
    }
  });

  if (floorsModalConfirm) {
    floorsModalConfirm.addEventListener('click', async function () {
      var pend = floorsState.pending;
      if (floorsState.busy || !pend || !pend.rules) return;
      setFloorsApplyBusy(true);
      try {
        // Usa o SNAPSHOT do preview (M1): mesmo network/domain/rules previstos,
        // não os valores vivos do floorsState (que o chat pode ter trocado).
        var body = {
          rulerToken: state.config.rulerToken, avBearer: state.config.avBearer,
          network: pend.network, domain: pend.domain,
          rules: pend.rules, confirm: true, managerName: state.config.name
        };
        var res = await fetch('/api/ruler/apply', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        var json = null;
        try { json = await res.json(); } catch (e) { json = null; }

        if (res.ok && json && json.ok && json.mode === 'applied') {
          closeFloorsModal();
          showToast('floors aplicados', 'success');
          floorsState.modified = {};
          floorsState.pendingKeys = null;
          floorsState.pendingRules = null;
          floorsState.pending = null;
          await loadFloorsRules(pend.network, pend.domain);
        } else if (res.status === 409) {
          if (floorsModalStatus) {
            floorsModalStatus.textContent = 'preview expirou, revise de novo.';
            floorsModalStatus.className = 'ob-status error';
          }
          closeFloorsModal();
          showToast('preview expirou, revise as alterações de novo', 'warn');
        } else {
          if (floorsModalStatus) {
            floorsModalStatus.textContent = (json && json.error) || 'falha ao aplicar floors.';
            floorsModalStatus.className = 'ob-status error';
          }
        }
      } catch (e) {
        if (floorsModalStatus) {
          floorsModalStatus.textContent = 'falha de rede ao aplicar.';
          floorsModalStatus.className = 'ob-status error';
        }
      } finally {
        setFloorsApplyBusy(false);
      }
    });
  }

  // ---- auto-open via chat (evento SSE `tooldata`) ----

  function handleFloorsToolData(data) {
    if (!data || !data.name) return;
    if (dashSubtabs && dashSubtabs.classList.contains('hidden')) dashSubtabs.classList.remove('hidden');
    setDashView('floors');

    if (data.network && floorsNetworkInput) floorsNetworkInput.value = data.network;
    if (data.domain && floorsDomainInput) floorsDomainInput.value = data.domain;
    if (data.network && data.domain) {
      floorsState.network = data.network;
      floorsState.domain = data.domain;
      lsSet(LS_FLOORS, { network: data.network, domain: data.domain });
    }

    var result = data.result;
    if (data.name === 'listar_price_rules') {
      var rulesData = result ? (result.data !== undefined ? result.data : result) : null;
      floorsState.rows = extractRows(rulesData).map(normalizeFloorRow);
      floorsState.modified = {};
      renderFloorsTable();
      renderFloorsCards(normalizeFloorsResumo(floorsState.resumoRaw));
      updateFloorsReviewButton();
      if (floorsSuggestBtn) floorsSuggestBtn.disabled = false;
      setFloorsStatusText((data.network || floorsState.network) + ' · ' + (data.domain || floorsState.domain));
    } else if (data.name === 'resumo_floors') {
      floorsState.resumoRaw = result;
      renderFloorsCards(normalizeFloorsResumo(result));
      if (floorsSuggestBtn) floorsSuggestBtn.disabled = false;
      setFloorsStatusText((data.network || floorsState.network) + ' · ' + (data.domain || floorsState.domain));
    } else if (data.name === 'sugerir_floor') {
      applyFloorsSuggestionsPayload(result);
    } else if (data.name === 'aplicar_floor') {
      // nao abre modal (a aplicacao ja aconteceu via chat) - so reflete o estado novo.
      if (floorsState.network && floorsState.domain) {
        loadFloorsRules(floorsState.network, floorsState.domain);
      }
    }
  }

  /* ============================== 9. MOBILE TABS ============================== */

  var splitView = $('#split-view');
  var mobileTabs = $all('.mobile-tab');

  mobileTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.getAttribute('data-tab');
      mobileTabs.forEach(function (t) {
        var active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      splitView.setAttribute('data-mobile-tab', target);
    });
  });

  /* ============================== 10. BOOT ============================== */

  function enterApp(isFreshOnboarding) {
    obOverlay.classList.add('hidden');
    $('#app').classList.remove('hidden');

    modelSelect.value = state.config.model || 'claude-sonnet-5';

    // ruler-mcp: cinza se sem rulerToken configurado, verde se configurado
    // (foi validado no onboarding ou em uma sessao anterior). O chip de
    // sugestao "Floors do dominio?" so aparece quando as tools de price
    // floor estao de fato disponiveis pro agente.
    setRulerConnStatus(state.config.rulerToken ? 'ok' : 'unset');
    var rulerChip = $('#chip-ruler-floors');
    if (rulerChip) rulerChip.classList.toggle('hidden', !state.config.rulerToken);

    // aba FLOORS do dashboard so existe pro gestor com rulerToken configurado -
    // sem isso, nem o switch OPERACAO|FLOORS aparece (dashboard fica identico ao de hoje).
    initFloorsAvailability();

    // chat history
    if (!isFreshOnboarding) {
      state.chatHistory = lsGet(LS_CHAT) || [];
    }
    renderChatHistory();
    greetIfEmpty();

    // snapshot
    if (!isFreshOnboarding) {
      state.snapshot = lsGet(LS_SNAPSHOT) || null;
    }
    renderDashboard();

    var needsRefresh = isFreshOnboarding || !state.snapshot || (Date.now() - (state.snapshot.timestamp || 0)) > SNAPSHOT_WARN_MS;
    if (needsRefresh) {
      refreshSnapshot(state.period);
    } else if (state.snapshot) {
      // gestor recorrente com snapshot fresco (<30min): a ultima interacao com
      // o moodlr-ops foi bem-sucedida, entao o indicador nao deve ficar em "--".
      setMoodlrConnStatus(true);
    }

    chatInput.focus();
  }

  function boot() {
    var config = lsGet(LS_CONFIG);
    if (!config || !config.moodlrToken || !config.name) {
      obOverlay.classList.remove('hidden');
      obName.focus();
      return;
    }

    state.config = config;
    if (!state.config.model) state.config.model = 'claude-sonnet-5';
    obModel.value = state.config.model;

    enterApp(false);
  }

  setInterval(updateSnapshotAge, SNAPSHOT_AGE_TICK_MS);

  document.addEventListener('DOMContentLoaded', boot);
})();

/* =====================================================================
   BOOT ANIMATION SEQUENCER — isolated module, does not touch anything
   above. Plays a ~5.2s cyberpunk intro overlay on the very first visit
   (localStorage flag "cortex.booted"), then removes itself from the DOM.
   Purely cosmetic: the real app boot (onboarding/localStorage/snapshot)
   above runs on its own regardless of this animation.
   ===================================================================== */
(function () {
  'use strict';

  var LS_BOOTED = 'cortex.booted';

  function alreadyBooted() {
    try {
      return !!localStorage.getItem(LS_BOOTED);
    } catch (e) {
      // localStorage blocked (private mode / policy) - do not gate on it,
      // but also do not risk breaking the page: skip the animation.
      return true;
    }
  }

  function markBooted() {
    try { localStorage.setItem(LS_BOOTED, '1'); } catch (e) { /* best effort */ }
  }

  var overlay = document.getElementById('boot-overlay');
  if (!overlay || alreadyBooted()) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    return;
  }

  var reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { /* matchMedia unavailable - treat as normal motion */ }

  if (reduceMotion) {
    markBooted();
    overlay.parentNode.removeChild(overlay);
    return;
  }

  var timers = [];
  var intervals = [];
  function schedule(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clearAllTimers() {
    timers.forEach(clearTimeout);
    timers = [];
    intervals.forEach(clearInterval);
    intervals = [];
  }

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearAllTimers();
    markBooted();
    overlay.removeEventListener('click', onSkip);
    document.removeEventListener('keydown', onKeydown);
    overlay.classList.add('boot-exit');
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 420);
  }

  function onSkip() { finish(); }
  function onKeydown(e) { if (e.key === 'Escape' || e.key === 'Esc') finish(); }

  overlay.addEventListener('click', onSkip);
  document.addEventListener('keydown', onKeydown);

  // ---- skip hint, discreet, appears after 1s ----
  schedule(function () {
    var hint = document.getElementById('boot-skip-hint');
    if (hint) hint.classList.add('show');
  }, 1000);

  /* ---------------- phase 1: terminal typewriter ---------------- */

  var termEl = document.getElementById('boot-terminal');
  var glitchBudget = 3;
  var GLITCH_CHARS = '#%&$@?/\\<>01';

  function randGlitchChar() {
    return GLITCH_CHARS.charAt(Math.floor(Math.random() * GLITCH_CHARS.length));
  }

  function typeLine(lineWrap, text, speed, onDone) {
    var i = 0;
    function step() {
      if (i >= text.length) { onDone(); return; }
      var ch = text.charAt(i);
      if (glitchBudget > 0 && i > 2 && Math.random() < 0.05) {
        glitchBudget--;
        var g = document.createElement('span');
        g.className = 'glitch';
        g.textContent = randGlitchChar();
        lineWrap.appendChild(g);
        schedule(function () {
          g.textContent = ch;
          g.className = '';
        }, 55);
      } else {
        lineWrap.appendChild(document.createTextNode(ch));
      }
      i++;
      schedule(step, speed);
    }
    step();
  }

  function runLine(lineData, onDone) {
    if (!termEl) { onDone(); return; }
    var lineWrap = document.createElement('span');
    lineWrap.className = 'term-line';
    termEl.appendChild(lineWrap);

    function addStatus() {
      if (lineData.status) {
        var st = document.createElement('span');
        st.className = lineData.statusClass || '';
        st.textContent = lineData.status;
        lineWrap.appendChild(st);
      }
      termEl.appendChild(document.createTextNode('\n'));
      onDone();
    }

    if (lineData.instant) {
      lineWrap.textContent = lineData.prefix;
      schedule(addStatus, 90);
    } else {
      typeLine(lineWrap, lineData.prefix, lineData.speed || 14, addStatus);
    }
  }

  function runProgressBar(onDone) {
    if (!termEl) { onDone(); return; }
    var wrap = document.createElement('span');
    wrap.className = 'term-line';
    var bar = document.createElement('span');
    var pctEl = document.createElement('span');
    pctEl.className = 'bar-pct';
    wrap.appendChild(document.createTextNode('> '));
    wrap.appendChild(bar);
    wrap.appendChild(document.createTextNode(' '));
    wrap.appendChild(pctEl);
    termEl.appendChild(wrap);

    var totalBlocks = 12;
    var step = 0;
    var steps = 18;

    function render() {
      var filled = Math.round((step / steps) * totalBlocks);
      var pct = Math.min(100, Math.round((step / steps) * 100));
      var filledStr = new Array(filled + 1).join('█');
      var emptyStr = new Array(totalBlocks - filled + 1).join('░');
      bar.textContent = '[' + filledStr + emptyStr + ']';
      pctEl.textContent = pct + '%';
    }

    render();
    var iv = setInterval(function () {
      step++;
      render();
      if (step >= steps) {
        clearInterval(iv);
        onDone();
      }
    }, 24);
    intervals.push(iv);
  }

  var TERMINAL_LINES = [
    { prefix: '> MBZ BIOS v5.0 — NEURAL LINK', speed: 12 },
    { prefix: '> mem check .... ', status: 'OK', statusClass: 'ok', speed: 9 },
    { prefix: '> modulos: adx.core / fb.ads / mcp.moodlr .... ', status: 'OK', statusClass: 'ok', speed: 7 },
    { prefix: '> handshake moodlr-ops ......... ', status: 'AUTH PENDING', statusClass: 'pending', speed: 11 },
    { prefix: '> iniciando cortex sintetico...', instant: true }
  ];

  function runTerminalSequence() {
    var idx = 0;
    function next() {
      if (idx >= TERMINAL_LINES.length) {
        runProgressBar(function () { /* terminal sequence complete */ });
        return;
      }
      var line = TERMINAL_LINES[idx];
      idx++;
      runLine(line, next);
    }
    next();
  }

  schedule(runTerminalSequence, 600);

  /* ---------------- phase 2: data-stream (particles) ---------------- */

  function spawnParticles() {
    var host = document.getElementById('boot-particles');
    if (!host) return;
    var colors = ['', 'pink', 'purple'];
    var count = 20;
    for (var i = 0; i < count; i++) {
      var el = document.createElement('div');
      var colorClass = colors[Math.floor(Math.random() * colors.length)];
      el.className = 'boot-particle' + (colorClass ? ' ' + colorClass : '');
      var angle = Math.random() * Math.PI * 2;
      var dist = 38 + Math.random() * 18; // vmin-ish spread from center
      var sx = (Math.cos(angle) * dist).toFixed(1) + 'vmin';
      var sy = (Math.sin(angle) * dist).toFixed(1) + 'vmin';
      el.style.setProperty('--sx', sx);
      el.style.setProperty('--sy', sy);
      el.style.setProperty('--pd', Math.round(Math.random() * 1100) + 'ms');
      host.appendChild(el);
    }
  }

  schedule(function () {
    overlay.classList.add('boot-phase-2');
    spawnParticles();
  }, 2000);

  /* ---------------- phase 3: the brain (climax) ---------------- */

  schedule(function () {
    overlay.classList.add('boot-phase-3');
  }, 3200);

  var brainWrap = document.getElementById('boot-brain-wrap');
  schedule(function () {
    if (brainWrap) brainWrap.classList.add('brain-alive');
  }, 4000);

  /* ---------------- phase 4: logo reveal + wipe ---------------- */

  var TAGLINE_TEXT = 'CENTRO DE COMANDO // MBZ MEDIA';

  function typeTagline() {
    var el = document.getElementById('boot-tagline');
    if (!el) return;
    var cursor = document.createElement('span');
    cursor.className = 'cursor';
    el.appendChild(cursor);
    var i = 0;
    function step() {
      if (i >= TAGLINE_TEXT.length) return;
      el.insertBefore(document.createTextNode(TAGLINE_TEXT.charAt(i)), cursor);
      i++;
      schedule(step, 12);
    }
    step();
  }

  schedule(function () {
    overlay.classList.add('boot-phase-4');
    schedule(typeTagline, 340);
  }, 4400);

  // tagline finishes typing ~5100ms (starts 4740, ~30 chars @12ms); give it
  // a little headroom before the wipe-out so it doesn't get cut mid-word.
  schedule(finish, 5150);
})();
