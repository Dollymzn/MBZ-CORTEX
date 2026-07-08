// mcp-core.js — Máquina genérica de cliente MCP STATELESS, compartilhada pelos
// dois servidores (moodlr-ops e ruler-mcp). Extraída do moodlr.js original.
//
// O que vive AQUI (server-independente): parsing SSE vs JSON puro, seleção da
// resposta JSON-RPC por id, extração de JSON com preâmbulo/sufixo em texto,
// sanitização em profundidade de chaves sensíveis, taxonomia de erros, retry/
// backoff, initialize on-demand, desembrulho do result.content[0].text, e a
// FÁBRICA createMcpClient({url,label,...}) que devolve um cliente parametrizado
// por endpoint (rpc / callTool / listTools / initializeSession / finishToolCall).
//
// O que NÃO vive aqui (fica nos wrappers finos): injeção de `company` (moodlr),
// injeção de `av_bearer` (ruler), HEAVY_TOOL_OPTS (moodlr), lazy-load recovery
// via tool_search (moodlr). Cada wrapper compõe as primitivas deste core.
//
// Regras críticas preservadas do original:
//   - Cada chamada abre → consulta → FECHA (fetch é one-shot). Sem socket vivo.
//   - Headers: Authorization Bearer (token do gestor, NUNCA logado), Content-Type
//     application/json, Accept application/json, text/event-stream.
//   - Timeout (AbortController). Retry com backoff exponencial + jitter em
//     429/500/502/503/504/529 e erros de rede. NUNCA retry em 401/403.
//   - A resposta pode vir como JSON puro OU como SSE ("data: {...}"). Parseamos os dois.
//   - O resultado real vem em result.content[0].text como STRING JSON → JSON.parse
//     (com tolerância a preâmbulo/sufixo em texto).
//   - initialize é ON-DEMAND: tenta a chamada direta; se o servidor reclamar de
//     sessão não inicializada, faz initialize + a chamada no mesmo ciclo.

// ───────────────────────────── configuração padrão ───────────────────────────
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8_000;
// Superset da lista da spec (429/500/503/529): 502/504 são erros de gateway
// transientes e merecem retry. Ver DESIGN.md → "Retry / backoff".
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

// ─────────────────────────── sanitização de payload ──────────────────────────
// Os servidores MCP podem devolver credenciais e PII EMBUTIDAS nos payloads
// (admin_pass, user_pass, rest_api_key, cpf, pix, e-mail, e — no ruler — o
// av_bearer da ActiveView ecoado nos previews). Nada disso pode sair do proxy:
// nem pro localStorage do gestor, nem pro contexto do modelo. Chaves que casarem
// são removidas em profundidade de todo resultado de tool.
//
// ⚠️ ENDURECIMENTO (ruler): adicionado `bearer` à lista — cobre `av_bearer` que o
// ruler-mcp pode ecoar de volta nos args de um preview de aplicar_floor. É uma
// mudança estritamente aditiva (só remove MAIS chaves; não afeta o moodlr).
const SENSITIVE_KEY_RE = /(pass|secret|api_?key|token|bearer|authorization|credential|cpf|pix|mobile|e-?mail)/i;
const SENSITIVE_KEYS_EXACT = new Set(['admin_user', 'user_admin', 'rest_username']);

/** Remove chaves sensíveis em profundidade. Vale para os DOIS MCPs. Exportada para testes. */
export function sanitizePayload(value, depth = 0) {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizePayload(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k) || SENSITIVE_KEYS_EXACT.has(k)) continue;
    out[k] = sanitizePayload(v, depth + 1);
  }
  return out;
}

// ─────────────────────────── taxonomia de erros ──────────────────────────────
// Nomes genéricos (Mcp*), compartilhados pelos dois MCPs. moodlr.js re-exporta
// `McpError` como `MoodlrError` para não quebrar importadores legados.
export class McpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpError';
  }
}
/** Autenticação recusada pelo servidor MCP (401/403). Nunca é retentada. */
export class McpAuthError extends McpError {
  constructor(message, status) {
    super(message);
    this.name = 'McpAuthError';
    this.status = status;
    this.auth = true;
  }
}
/** HTTP não-2xx que não é auth. Carrega o status e o corpo (para diagnóstico). */
export class McpHttpError extends McpError {
  constructor(message, status, body) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
    this.body = body;
  }
}
/** Falha de rede / conexão. */
export class McpNetworkError extends McpError {
  constructor(message) {
    super(message);
    this.name = 'McpNetworkError';
  }
}
/** Timeout (AbortController disparou). */
export class McpTimeoutError extends McpNetworkError {
  constructor(message) {
    super(message);
    this.name = 'McpTimeoutError';
  }
}
/** Corpo JSON-RPC ausente/irreconhecível ou content não-JSON. */
export class McpProtocolError extends McpError {
  constructor(message) {
    super(message);
    this.name = 'McpProtocolError';
  }
}
/** A ferramenta rodou mas retornou erro (result.isError ou JSON-RPC error). */
export class McpToolError extends McpError {
  constructor(message) {
    super(message);
    this.name = 'McpToolError';
  }
}
/** Sinaliza "sessão não inicializada" — dispara o fallback de initialize. */
export class McpSessionError extends McpError {
  constructor(message) {
    super(message);
    this.name = 'McpSessionError';
  }
}

// ─────────────────────────────── utilidades ──────────────────────────────────
let _rpcId = 0;
const nextId = () => ++_rpcId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffDelay(retryIndex /* 1-based */) {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (retryIndex - 1), MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

// ─────────────────────── parsing SSE vs JSON puro (genérico) ──────────────────
/**
 * Extrai as mensagens JSON-RPC do corpo, detectando SSE ou JSON puro.
 * SSE: eventos separados por linha em branco; concatena todas as linhas `data:`.
 * JSON: objeto único ou array (batch). Exportada para testes.
 */
export function parseRpcBody(rawText, contentType) {
  const ct = (contentType || '').toLowerCase();
  const trimmed = (rawText || '').trim();
  if (!trimmed) return [];

  const looksSse =
    ct.includes('text/event-stream') ||
    (!ct.includes('application/json') && /^\s*(event|data):/m.test(trimmed));

  if (looksSse) {
    const messages = [];
    for (const evt of trimmed.split(/\r?\n\r?\n/)) {
      const dataLines = [];
      for (const line of evt.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      if (!payload || payload === '[DONE]') continue;
      try {
        messages.push(JSON.parse(payload));
      } catch {
        /* keepalive / evento não-JSON — ignora */
      }
    }
    return messages;
  }

  // JSON puro
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Última tentativa: talvez seja SSE mal rotulado
    if (/^\s*data:/m.test(trimmed)) return parseRpcBody(rawText, 'text/event-stream');
    return [];
  }
}

/** Escolhe a resposta JSON-RPC com o id correspondente (ou a última com result/error). */
export function pickResponse(messages, id) {
  if (!messages.length) return null;
  const byId = messages.find(
    (m) => m && String(m.id) === String(id) && ('result' in m || 'error' in m),
  );
  if (byId) return byId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && ('result' in m || 'error' in m)) return m;
  }
  return null;
}

function mapJsonRpcError(error) {
  const msg = error?.message || 'erro JSON-RPC';
  if (/session|initiali[sz]/i.test(msg)) return new McpSessionError(msg);
  // Alguns servidores sinalizam auth como erro JSON-RPC (HTTP 200) em vez de 401.
  if (/unauthori[sz]ed|forbidden|invalid token|token inv/i.test(msg)) return new McpAuthError(msg, 401);
  return new McpToolError(msg);
}

function looksLikeSessionError(err) {
  if (err instanceof McpSessionError) return true;
  if (err instanceof McpHttpError && err.status === 400) {
    return /session|initiali[sz]/i.test(err.body || '');
  }
  return false;
}

// ──────────────────── desembrulho do resultado da tool (genérico) ─────────────
function extractText(content) {
  if (!Array.isArray(content)) return '';
  // Concatena TODOS os blocos de texto — o payload pode vir dividido em vários.
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Extrai o payload JSON de um texto que pode vir com preâmbulo E/OU sufixo em
 * texto puro — os servidores grudam avisos (ex. "ATENÇÃO (ROAS bruto)...") antes
 * do JSON. Exportada para testes.
 * @returns o valor parseado, ou undefined se não houver JSON balanceado.
 */
export function extractJsonPayload(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;

  // Caminho feliz: o texto inteiro é JSON.
  try {
    return JSON.parse(text);
  } catch {
    /* segue pro scan */
  }

  // Localiza cada '{' ou '[' candidato e varre até o fechamento correspondente,
  // ignorando chaves/colchetes dentro de strings (com consciência de escapes).
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // candidato desbalanceado/inválido — tenta o próximo abridor
          }
        }
      }
    }
  }
  return undefined;
}

/** Desembrulha result.content[0].text → objeto. Exportada para wrappers/testes. */
export function unwrapToolResult(result, toolName) {
  if (!result || !Array.isArray(result.content)) {
    // Alguns servidores devolvem só structuredContent
    if (result && result.structuredContent !== undefined) return result.structuredContent;
    throw new McpProtocolError(`Ferramenta ${toolName}: resposta sem content.`);
  }
  if (result.isError) {
    const t = extractText(result.content);
    throw new McpToolError(`Ferramenta ${toolName} retornou erro: ${t || 'sem detalhes'}.`);
  }
  const text = extractText(result.content);
  if (text) {
    const parsed = extractJsonPayload(text); // normalmente { status, data, cache }
    if (parsed !== undefined) return parsed;
    throw new McpProtocolError(
      `Ferramenta ${toolName}: nenhum JSON balanceado no texto retornado — erro de parsing DESTA tool, não indica API fora do ar. Início do texto: "${text.slice(0, 180)}"`,
    );
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  throw new McpProtocolError(`Ferramenta ${toolName} não retornou texto JSON.`);
}

/** Desembrulha + sanitiza. Ponto único de finalização de um resultado de tool. */
export function finishToolCall(result, toolName) {
  return sanitizePayload(unwrapToolResult(result, toolName));
}

// ───────────────────────────── FÁBRICA DE CLIENTE ────────────────────────────
/**
 * Cria um cliente MCP stateless parametrizado por endpoint.
 *
 * @param {object} cfg
 * @param {string|(()=>string)} cfg.url  Endpoint /api/mcp (string ou getter lazy — use
 *   getter para ler process.env depois do dotenv carregar).
 * @param {string} cfg.label             Rótulo humano nas mensagens de erro ("moodlr-ops"/"ruler-mcp").
 * @param {string} [cfg.clientName]      clientInfo.name no initialize.
 * @param {string} [cfg.clientVersion]   clientInfo.version no initialize.
 * @param {string} [cfg.protocolVersion]
 * @param {number} [cfg.timeoutMs]       Timeout padrão por tentativa.
 * @param {number} [cfg.maxAttempts]     Tentativas padrão (retry/backoff).
 * @returns cliente: { rpc, initializeSession, callTool, listTools, finishToolCall, label }
 */
export function createMcpClient(cfg) {
  const resolveUrl = typeof cfg.url === 'function' ? cfg.url : () => cfg.url;
  const label = cfg.label || 'servidor MCP';
  const clientName = cfg.clientName || 'mbz-cortex';
  const clientVersion = cfg.clientVersion || '0.1.0';
  const protocolVersion = cfg.protocolVersion || MCP_PROTOCOL_VERSION;
  const clientTimeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const clientMaxAttempts = cfg.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  function buildHeaders(token, sessionId) {
    const h = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
      h['Mcp-Session-Id'] = sessionId;
      h['MCP-Protocol-Version'] = protocolVersion;
    }
    return h;
  }

  function mapNetworkError(err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return new McpTimeoutError(`Tempo esgotado ao contatar o ${label}.`);
    }
    return new McpNetworkError(`Falha de rede ao contatar o ${label}: ${err?.message || 'erro desconhecido'}.`);
  }

  async function postOnce(body, token, sessionId, timeoutMs = clientTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(resolveUrl(), {
        method: 'POST',
        headers: buildHeaders(token, sessionId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST com retry/backoff. Fecha a conexão a cada tentativa (fetch é one-shot). */
  async function postWithRetry(body, token, sessionId, opts = {}) {
    const maxAttempts = opts.maxAttempts || clientMaxAttempts;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(backoffDelay(attempt - 1));

      let out;
      try {
        out = await postOnce(body, token, sessionId, opts.timeoutMs);
      } catch (err) {
        lastErr = mapNetworkError(err); // rede/timeout → retentável
        continue;
      }

      const { res, text } = out;
      if (res.status === 401 || res.status === 403) {
        throw new McpAuthError(`Chave do ${label} recusada (HTTP ${res.status}).`, res.status);
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        lastErr = new McpHttpError(`${label} instável (HTTP ${res.status}).`, res.status, text);
        continue;
      }
      if (!res.ok) {
        throw new McpHttpError(`${label} respondeu HTTP ${res.status}.`, res.status, text);
      }
      return { res, text };
    }
    throw lastErr || new McpNetworkError(`Não foi possível contatar o ${label}.`);
  }

  /**
   * Uma requisição JSON-RPC completa (com id), numa sessão específica (ou sem).
   * NÃO faz fallback de initialize — é a primitiva de baixo nível que os wrappers
   * usam em recuperações pontuais (ex. lazy-load do moodlr).
   * @returns { result, sessionId }
   */
  async function rpc(method, params, token, sessionId = null, opts = {}) {
    const id = nextId();
    const { res, text } = await postWithRetry({ jsonrpc: '2.0', id, method, params }, token, sessionId, opts);
    const returnedSession = res.headers.get('mcp-session-id') || sessionId || null;
    const messages = parseRpcBody(text, res.headers.get('content-type'));
    const msg = pickResponse(messages, id);
    if (!msg) throw new McpProtocolError(`Resposta do ${label} sem corpo JSON-RPC reconhecível (método ${method}).`);
    if (msg.error) throw mapJsonRpcError(msg.error);
    return { result: msg.result, sessionId: returnedSession };
  }

  /** Handshake de sessão no mesmo ciclo (initialize + notifications/initialized). */
  async function initializeSession(token) {
    const { sessionId } = await rpc(
      'initialize',
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: clientName, version: clientVersion },
      },
      token,
      null,
    );
    // Notificação fire-and-forget (sem id, sem resposta). Best-effort.
    try {
      await postWithRetry({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, sessionId);
    } catch {
      /* servidores stateless podem nem exigir; ignoramos falha aqui */
    }
    return sessionId;
  }

  /** Executa method com fallback de initialize se o servidor exigir sessão. */
  async function rpcWithSessionFallback(method, params, token, opts = {}) {
    try {
      return await rpc(method, params, token, null, opts);
    } catch (err) {
      if (looksLikeSessionError(err)) {
        const sessionId = await initializeSession(token);
        return await rpc(method, params, token, sessionId, opts);
      }
      throw err;
    }
  }

  /**
   * Chama uma ferramenta. Abre → consulta → fecha. Session fallback + unwrap +
   * sanitize. NÃO injeta company/av_bearer — isso é responsabilidade do wrapper,
   * que já deve ter transformado `args` antes de chamar.
   * @returns objeto já com JSON.parse aplicado (tipicamente { status, data, cache }).
   */
  async function callTool(toolName, args, token, opts = {}) {
    if (!token) throw new McpAuthError(`Token do ${label} ausente.`, 401);
    const params = { name: toolName, arguments: args || {} };
    const { result } = await rpcWithSessionFallback('tools/call', params, token, opts);
    return finishToolCall(result, toolName);
  }

  /** Lista as ferramentas expostas pelo servidor (para as rotas /api/validate*). */
  async function listTools(token) {
    if (!token) throw new McpAuthError(`Token do ${label} ausente.`, 401);
    const { result } = await rpcWithSessionFallback('tools/list', {}, token);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  return { rpc, initializeSession, callTool, listTools, finishToolCall, label };
}
