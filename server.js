// server.js — MBZ::CORTEX backend. Express + rotas + static + dotenv.
//
// Contrato de API (CONGELADO — o frontend é construído contra isto):
//   GET  /api/health         -> 200 {"ok":true}
//   POST /api/validate       -> {moodlrToken} -> 200 {ok,toolCount} | 401 | 502
//   POST /api/validate-ruler -> {rulerToken}  -> 200 {ok,toolCount} | 401 | 502
//   POST /api/snapshot       -> {moodlrToken, period} -> 200 {ok,snapshot} | 502
//   POST /api/chat           -> {messages,managerName,moodlrToken,model,snapshot,rulerToken?,avBearer?} -> SSE
//
// Segurança: ANTHROPIC_API_KEY fica só no servidor (nunca vai ao frontend nem a
// logs). Os tokens do gestor (moodlr-ops, ruler-mcp) e o av_bearer da ActiveView
// vêm em cada request e NUNCA são logados.
//
// O ruler-mcp (price floors, lado da venda) NÃO entra no snapshot: floors são
// consultados sob demanda pelo agente. O snapshot segue idêntico (só moodlr-ops).
//
// Layout de deploy: este arquivo (e mcp-core.js/moodlr.js/ruler.js/tools*.js/
// agent.js) roda na RAIZ do repo, ao lado da pasta public/. Ver DESIGN.md.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTools, callTool, McpAuthError } from './moodlr.js';
import { listRulerTools, callRulerTool } from './ruler.js';
import { guardedApplyFloor, redactSecrets } from './floor-guard.js';
import { runAgentStream } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const VALID_MODELS = new Set(['claude-sonnet-5', 'claude-opus-4-8']);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// ───────────────────────────── datas (America/Sao_Paulo) ─────────────────
function todaySaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // YYYY-MM-DD
}

function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // meio-dia UTC evita bordas de DST
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function periodToDates(period) {
  const today = todaySaoPaulo();
  if (period === 'ontem') {
    const y = addDays(today, -1);
    return { label: 'ontem', start_date: y, end_date: y };
  }
  if (period === '7d') {
    return { label: '7d', start_date: addDays(today, -6), end_date: today };
  }
  return { label: 'hoje', start_date: today, end_date: today };
}

// ─────────────────────────────── rotas ───────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Valida a chave do gestor com um tools/list de teste no moodlr-ops.
app.post('/api/validate', async (req, res) => {
  const token = req.body?.moodlrToken;
  try {
    const tools = await listTools(token);
    res.status(200).json({ ok: true, toolCount: Array.isArray(tools) ? tools.length : 0 });
  } catch (err) {
    if (err instanceof McpAuthError) {
      res.status(401).json({ ok: false, error: 'Chave do moodlr-ops inválida.' });
    } else {
      res.status(502).json({ ok: false, error: 'moodlr-ops inacessível no momento.' });
    }
  }
});

// Valida a chave do gestor com um tools/list de teste no ruler-mcp (price floors).
// Espelha /api/validate. Só precisa do rulerToken (o av_bearer não é usado no
// tools/list). Mesma taxonomia: 200 ok | 401 chave inválida | 502 inacessível.
app.post('/api/validate-ruler', async (req, res) => {
  const token = req.body?.rulerToken;
  try {
    const tools = await listRulerTools(token);
    res.status(200).json({ ok: true, toolCount: Array.isArray(tools) ? tools.length : 0 });
  } catch (err) {
    if (err instanceof McpAuthError) {
      res.status(401).json({ ok: false, error: 'Chave do ruler-mcp inválida.' });
    } else {
      res.status(502).json({ ok: false, error: 'ruler-mcp inacessível no momento.' });
    }
  }
});

// Monta o snapshot do dia: 4 chamadas em PARALELO (Promise.allSettled). Falha
// parcial não derruba o snapshot (campo null + entrada em errors). 502 só se as 4 falharem.
// (O ruler-mcp NÃO participa do snapshot — floors são sob demanda.)
app.post('/api/snapshot', async (req, res) => {
  const token = req.body?.moodlrToken;
  if (!token) {
    return res.status(400).json({ ok: false, error: 'moodlrToken ausente.' });
  }

  const rawPeriod = req.body?.period;
  const period = ['hoje', 'ontem', '7d'].includes(rawPeriod) ? rawPeriod : 'hoje';
  const { label, start_date, end_date } = periodToDates(period);

  // [ chave no snapshot, nome da tool, função ]
  const tasks = [
    ['resumoUsuarios', 'resumo_usuarios', () => callTool('resumo_usuarios', { start_date, end_date }, token)],
    ['saudeContasFb', 'saude_contas_fb', () => callTool('saude_contas_fb', {}, token)],
    ['fadigaCriativo', 'fadiga_criativo', () => callTool('fadiga_criativo', {}, token)],
    ['adsetsPausados', 'adsets_pausados', () => callTool('adsets_pausados', {}, token)],
    ['projetos', 'listar_projetos', () => callTool('listar_projetos', {}, token)],
  ];

  const settled = await Promise.allSettled(tasks.map(([, , fn]) => fn()));

  const snapshot = {
    timestamp: Date.now(),
    period: { label, start_date, end_date },
    resumoUsuarios: null,
    saudeContasFb: null,
    fadigaCriativo: null,
    adsetsPausados: null,
    projetos: null,
    errors: [],
  };

  settled.forEach((r, i) => {
    const [key, toolName] = tasks[i];
    if (r.status === 'fulfilled') {
      snapshot[key] = r.value;
    } else {
      snapshot.errors.push({ tool: toolName, error: r.reason?.message || 'falha' });
    }
  });

  const allFailed = settled.every((r) => r.status === 'rejected');
  if (allFailed) {
    return res.status(502).json({
      ok: false,
      error: settled[0]?.reason?.message || 'moodlr-ops indisponível para montar o snapshot.',
    });
  }

  res.status(200).json({ ok: true, snapshot });
});

// Chat com o agente. Resposta em SSE (delta/tool/done/error).
app.post('/api/chat', async (req, res) => {
  const { messages, managerName, moodlrToken, model, snapshot, rulerToken, avBearer } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages inválido.' });
  }
  if (!moodlrToken) {
    return res.status(400).json({ ok: false, error: 'moodlrToken ausente.' });
  }
  const chosenModel = model || 'claude-sonnet-5';
  if (!VALID_MODELS.has(chosenModel)) {
    return res.status(400).json({ ok: false, error: 'model inválido.' });
  }

  // Cabeçalhos SSE (flush por evento; sem buffering em proxies).
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': ok\n\n'); // comentário SSE inicial → abre o stream / força flush

  // Cliente fechou a aba/conexão no meio do stream: aborta o loop do agente
  // (para de gastar Anthropic + moodlr-ops/ruler-mcp num socket morto).
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    await runAgentStream({
      res,
      messages,
      managerName,
      moodlrToken,
      model: chosenModel,
      snapshot,
      // ruler-mcp: opcionais. Sem rulerToken, o agente nem expõe as tools de floor.
      rulerToken: rulerToken || null,
      avBearer: avBearer || null,
      signal: abort.signal,
    });
  } catch (err) {
    // runAgentStream já trata seus próprios erros; este catch é só rede de segurança.
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Falha inesperada no CORTEX.' })}\n\n`);
      res.end();
    }
  }
});

// ══════════════════ DASHBOARD DE FLOORS (ruler-mcp, sob demanda) ═══════════
// Rotas HTTP que o dashboard usa pra carregar e EDITAR price floors direto na UI,
// sem passar pelo chat. A edição (apply) roteia pela MESMA trava do chat
// (floor-guard.js): preview→confirm. av_bearer nunca é logado nem devolvido.

// Carrega o panorama + as regras de um domínio (resumo_floors + listar_price_rules).
app.post('/api/ruler/rules', async (req, res) => {
  const { rulerToken, avBearer, network, domain } = req.body || {};
  if (!rulerToken) return res.status(400).json({ ok: false, error: 'rulerToken ausente.' });
  if (!network || !domain) return res.status(400).json({ ok: false, error: 'network e domain são obrigatórios.' });

  const [resumo, rules] = await Promise.allSettled([
    callRulerTool('resumo_floors', { network, domain }, rulerToken, avBearer),
    callRulerTool('listar_price_rules', { network, domain }, rulerToken, avBearer),
  ]);

  const secrets = { avBearer, rulerToken };
  if (resumo.status === 'rejected' && rules.status === 'rejected') {
    const authErr = [resumo, rules].some((r) => r.reason instanceof McpAuthError);
    return res.status(authErr ? 401 : 502).json({
      ok: false,
      error: redactSecrets(resumo.reason?.message || 'ruler-mcp indisponível.', secrets),
    });
  }

  const errors = [];
  if (resumo.status === 'rejected') errors.push({ tool: 'resumo_floors', error: redactSecrets(resumo.reason?.message || 'falha', secrets) });
  if (rules.status === 'rejected') errors.push({ tool: 'listar_price_rules', error: redactSecrets(rules.reason?.message || 'falha', secrets) });

  res.status(200).json({
    ok: true,
    network,
    domain,
    resumo: resumo.status === 'fulfilled' ? resumo.value : null,
    rules: rules.status === 'fulfilled' ? rules.value : null,
    errors,
  });
});

// Sugestões de ajuste (sugerir_floor) — não aplica nada.
app.post('/api/ruler/sugestoes', async (req, res) => {
  const { rulerToken, avBearer, network, domain } = req.body || {};
  if (!rulerToken || !network || !domain) {
    return res.status(400).json({ ok: false, error: 'rulerToken, network e domain são obrigatórios.' });
  }
  try {
    const data = await callRulerTool('sugerir_floor', { network, domain }, rulerToken, avBearer);
    res.status(200).json({ ok: true, data });
  } catch (err) {
    const status = err instanceof McpAuthError ? 401 : 502;
    res.status(status).json({ ok: false, error: redactSecrets(err?.message || 'falha ao sugerir floor.', { avBearer, rulerToken }) });
  }
});

// Edição manual de floor. SEM confirm → preview (diff antes→depois); COM confirm →
// aplica de verdade, mas SÓ se houve um preview recente do mesmo network/domain
// (trava server-side compartilhada com o chat). actor = managerName (definido aqui).
app.post('/api/ruler/apply', async (req, res) => {
  const { rulerToken, avBearer, network, domain, rules, confirm, managerName } = req.body || {};
  if (!rulerToken) return res.status(400).json({ ok: false, error: 'rulerToken ausente.' });
  if (!network || !domain) return res.status(400).json({ ok: false, error: 'network e domain são obrigatórios.' });
  if (!Array.isArray(rules) || rules.length === 0) return res.status(400).json({ ok: false, error: 'rules[] vazio.' });

  try {
    const { mode, data } = await guardedApplyFloor(
      { network, domain, rules, confirm: confirm === true },
      { rulerToken, avBearer, managerName, callRuler: callRulerTool },
    );
    res.status(200).json({ ok: true, mode, data });
  } catch (err) {
    if (err instanceof McpAuthError) return res.status(401).json({ ok: false, error: 'Chave do ruler-mcp inválida.' });
    // Confirm barrado pela trava (sem preview) → 409, sinaliza que precisa do preview.
    if (/TRAVA DE SEGURAN/i.test(err?.message || '')) {
      return res.status(409).json({ ok: false, needsPreview: true, error: err.message });
    }
    res.status(502).json({ ok: false, error: redactSecrets(err?.message || 'falha ao aplicar floor.', { avBearer, rulerToken }) });
  }
});

// Fallback SPA: qualquer rota não-API serve o index do frontend.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

// ─────────────────────────── boot / guard-rails ──────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[cortex] AVISO: ANTHROPIC_API_KEY não definida — /api/chat vai falhar até configurar.');
}

// Não derruba o processo em rejeições não tratadas (sem vazar tokens/keys).
process.on('unhandledRejection', (reason) => {
  console.error('[cortex] unhandledRejection:', reason?.message || reason);
});

app.listen(PORT, () => {
  console.log(`[cortex] online na porta ${PORT} — MBZ::CORTEX // MBZ MEDIA`);
});

export default app;
