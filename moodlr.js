// moodlr.js — Proxy MCP STATELESS para o moodlr-ops.
//
// Cada chamada: abre → consulta → FECHA. Sem socket vivo, sem sessão persistente
// entre requests do frontend. JSON-RPC 2.0 por POST no MOODLR_MCP_URL.
//
// API pública:
//   callTool(toolName, args, moodlrToken) -> objeto já parseado ({status,data,cache} …)
//   listTools(moodlrToken)               -> array de tools (para /api/validate)
//
// Regras críticas:
//   - Headers: Authorization Bearer (token do gestor, NUNCA logado), Content-Type
//     application/json, Accept application/json, text/event-stream.
//   - Timeout ~30s (AbortController). Retry com backoff exponencial + jitter em
//     429/500/502/503/504/529 e erros de rede, até 4 tentativas. NUNCA retry em 401/403.
//   - A resposta pode vir como JSON puro OU como SSE ("data: {...}"). Parseamos os dois.
//   - O resultado real vem em result.content[0].text como STRING JSON → JSON.parse.
//   - initialize é ON-DEMAND: tentamos a chamada direta; se o servidor reclamar de
//     sessão não inicializada, fazemos initialize + a chamada no mesmo ciclo.
//   - company é injetado automaticamente em toda tool call (se MOODLR_COMPANY != "").

// ───────────────────────────── configuração ──────────────────────────────
const DEFAULT_MCP_URL = 'https://api.core.moodlr.digital/api/mcp';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8_000;
// Superset da lista da spec (429/500/503/529): 502/504 são erros de gateway
// transientes e merecem retry. Ver DESIGN.md → "Retry / backoff".
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

// Tools analíticas pesadas: mais tempo por tentativa e MENOS retries —
// re-executar uma query pesada que estourou só empilha carga no moodlr-ops.
const HEAVY_TOOL_OPTS = {
  resumo_usuarios: { timeoutMs: 90_000, maxAttempts: 2 },
  analise_campanhas: { timeoutMs: 60_000, maxAttempts: 2 },
};

// O moodlr-ops carrega as tools sob demanda (lazy load): sem um tool_search
// prévio, tools/call pode falhar com "not loaded". Estas 4 buscas carregam
// todos os grupos de tools (guia operacional do moodlr-ops).
const LAZY_LOAD_KEYWORDS = [
  'resumo financeiro',
  'campanhas fadiga contas',
  'listar projetos redirects',
  'writing sequencia analise',
];

// Lidas de forma preguiçosa para não depender da ordem de import do dotenv.
const mcpUrl = () => process.env.MOODLR_MCP_URL || DEFAULT_MCP_URL;
const company = () => (process.env.MOODLR_COMPANY || '').trim();

// ─────────────────────────── taxonomia de erros ──────────────────────────
export class MoodlrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoodlrError';
  }
}
/** Autenticação recusada pelo moodlr-ops (401/403). Nunca é retentada. */
export class McpAuthError extends MoodlrError {
  constructor(message, status) {
    super(message);
    this.name = 'McpAuthError';
    this.status = status;
    this.auth = true;
  }
}
/** HTTP não-2xx que não é auth. Carrega o status e o corpo (para diagnóstico). */
export class McpHttpError extends MoodlrError {
  constructor(message, status, body) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
    this.body = body;
  }
}
/** Falha de rede / conexão. */
export class McpNetworkError extends MoodlrError {
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
export class McpProtocolError extends MoodlrError {
  constructor(message) {
    super(message);
    this.name = 'McpProtocolError';
  }
}
/** A ferramenta rodou mas retornou erro (result.isError ou JSON-RPC error). */
export class McpToolError extends MoodlrError {
  constructor(message) {
    super(message);
    this.name = 'McpToolError';
  }
}
/** Sinaliza "sessão não inicializada" — dispara o fallback de initialize. */
export class McpSessionError extends MoodlrError {
  constructor(message) {
    super(message);
    this.name = 'McpSessionError';
  }
}

// ─────────────────────────────── utilidades ──────────────────────────────
let _rpcId = 0;
const nextId = () => ++_rpcId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffDelay(retryIndex /* 1-based */) {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (retryIndex - 1), MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

function buildHeaders(moodlrToken, sessionId) {
  const h = {
    Authorization: `Bearer ${moodlrToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    h['Mcp-Session-Id'] = sessionId;
    h['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION;
  }
  return h;
}

function injectCompany(args) {
  const c = company();
  if (c && (args == null || args.company === undefined)) {
    return { ...(args || {}), company: c };
  }
  return args || {};
}

function mapNetworkError(err) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new McpTimeoutError('Tempo esgotado ao contatar o moodlr-ops.');
  }
  return new McpNetworkError(`Falha de rede ao contatar o moodlr-ops: ${err?.message || 'erro desconhecido'}.`);
}

// ─────────────────────── parsing SSE vs JSON puro ────────────────────────
/**
 * Extrai as mensagens JSON-RPC do corpo, detectando SSE ou JSON puro.
 * SSE: eventos separados por linha em branco; concatena todas as linhas `data:`.
 * JSON: objeto único ou array (batch).
 */
function parseRpcBody(rawText, contentType) {
  const ct = (contentType || '').toLowerCase();
  const trimmed = (rawText || '').trim();
  if (!trimmed) return [];

  const looksSse = ct.includes('text/event-stream') || (!ct.includes('application/json') && /^\s*(event|data):/m.test(trimmed));

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
function pickResponse(messages, id) {
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

function looksLikeNotLoadedError(err) {
  if (!(err instanceof MoodlrError)) return false;
  return /not\s*loaded|n[aã]o\s*(foi\s*)?carregad|tool_search/i.test(err.message || '');
}

function looksLikeSessionError(err) {
  if (err instanceof McpSessionError) return true;
  if (err instanceof McpHttpError && err.status === 400) {
    return /session|initiali[sz]/i.test(err.body || '');
  }
  return false;
}

// ─────────────────────────── camada de transporte ────────────────────────
async function postOnce(body, moodlrToken, sessionId, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers: buildHeaders(moodlrToken, sessionId),
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
async function postWithRetry(body, moodlrToken, sessionId, opts = {}) {
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoffDelay(attempt - 1));

    let out;
    try {
      out = await postOnce(body, moodlrToken, sessionId, opts.timeoutMs);
    } catch (err) {
      lastErr = mapNetworkError(err); // rede/timeout → retentável
      continue;
    }

    const { res, text } = out;
    if (res.status === 401 || res.status === 403) {
      throw new McpAuthError(`Chave do moodlr-ops recusada (HTTP ${res.status}).`, res.status);
    }
    if (RETRYABLE_STATUS.has(res.status)) {
      lastErr = new McpHttpError(`moodlr-ops instável (HTTP ${res.status}).`, res.status, text);
      continue;
    }
    if (!res.ok) {
      throw new McpHttpError(`moodlr-ops respondeu HTTP ${res.status}.`, res.status, text);
    }
    return { res, text };
  }
  throw lastErr || new McpNetworkError('Não foi possível contatar o moodlr-ops.');
}

/** Uma requisição JSON-RPC completa (com id). Retorna { result, sessionId }. */
async function rpcRequest(method, params, moodlrToken, sessionId, opts = {}) {
  const id = nextId();
  const { res, text } = await postWithRetry({ jsonrpc: '2.0', id, method, params }, moodlrToken, sessionId, opts);
  const returnedSession = res.headers.get('mcp-session-id') || sessionId || null;
  const messages = parseRpcBody(text, res.headers.get('content-type'));
  const msg = pickResponse(messages, id);
  if (!msg) throw new McpProtocolError(`Resposta do moodlr-ops sem corpo JSON-RPC reconhecível (método ${method}).`);
  if (msg.error) throw mapJsonRpcError(msg.error);
  return { result: msg.result, sessionId: returnedSession };
}

/** Handshake de sessão no mesmo ciclo (initialize + notifications/initialized). */
async function initializeSession(moodlrToken) {
  const { sessionId } = await rpcRequest(
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mbz-cortex', version: '0.1.0' },
    },
    moodlrToken,
    null,
  );
  // Notificação fire-and-forget (sem id, sem resposta). Best-effort.
  try {
    await postWithRetry({ jsonrpc: '2.0', method: 'notifications/initialized' }, moodlrToken, sessionId);
  } catch {
    /* servidores stateless podem nem exigir; ignoramos falha aqui */
  }
  return sessionId;
}

/** Executa method com fallback de initialize se o servidor exigir sessão. */
async function rpcWithSessionFallback(method, params, moodlrToken, opts = {}) {
  try {
    return await rpcRequest(method, params, moodlrToken, null, opts);
  } catch (err) {
    if (looksLikeSessionError(err)) {
      const sessionId = await initializeSession(moodlrToken);
      return await rpcRequest(method, params, moodlrToken, sessionId, opts);
    }
    throw err;
  }
}

// ──────────────────── desembrulho do resultado da tool ────────────────────
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
 * texto puro — o moodlr-ops gruda avisos tipo "ATENÇÃO (ROAS bruto)..." ou
 * "COMO LER O DINHEIRO (revshare)..." antes do JSON. Exportada para testes.
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

function unwrapToolResult(result, toolName) {
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

// ──────────────────────────────── API pública ────────────────────────────
/**
 * Chama uma ferramenta do moodlr-ops. Abre → consulta → fecha. Injeta company.
 * @returns objeto já com JSON.parse aplicado (tipicamente { status, data, cache }).
 */
export async function callTool(toolName, args, moodlrToken) {
  if (!moodlrToken) throw new McpAuthError('Token do moodlr-ops ausente.', 401);
  const params = { name: toolName, arguments: injectCompany(args) };
  const opts = HEAVY_TOOL_OPTS[toolName] || {};
  try {
    const { result } = await rpcWithSessionFallback('tools/call', params, moodlrToken, opts);
    return unwrapToolResult(result, toolName);
  } catch (err) {
    if (!looksLikeNotLoadedError(err)) throw err;
    // Lazy load do servidor: destrava com tool_search pelas palavras-chave dos
    // grupos e repete a chamada UMA vez, no mesmo ciclo (mesma sessão, se houver).
    const sessionId = await initializeSession(moodlrToken).catch(() => null);
    for (const kw of LAZY_LOAD_KEYWORDS) {
      try {
        await rpcRequest('tools/call', { name: 'tool_search', arguments: { query: kw } }, moodlrToken, sessionId);
      } catch { /* best-effort: se a busca falhar, a retentativa abaixo decide */ }
    }
    const { result } = await rpcRequest('tools/call', params, moodlrToken, sessionId, opts);
    return unwrapToolResult(result, toolName);
  }
}

/**
 * Lista as ferramentas expostas pelo moodlr-ops. Usado por /api/validate para
 * provar que a chave do gestor é válida antes de liberar o app.
 * @returns array de tools do servidor (pode diferir das nossas 15 locais).
 */
export async function listTools(moodlrToken) {
  if (!moodlrToken) throw new McpAuthError('Token do moodlr-ops ausente.', 401);
  const { result } = await rpcWithSessionFallback('tools/list', {}, moodlrToken);
  return Array.isArray(result?.tools) ? result.tools : [];
}
