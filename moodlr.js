// moodlr.js — Wrapper FINO do moodlr-ops sobre o mcp-core.
//
// Toda a máquina genérica (parsing SSE/JSON, retry/backoff, initialize on-demand,
// unwrap, sanitize, taxonomia de erros) vive em mcp-core.js. Aqui fica SÓ o que é
// específico do moodlr-ops:
//   - injeção automática de `company` em toda tool call;
//   - HEAVY_TOOL_OPTS (resumo_usuarios 90s/2, analise_campanhas 60s/2);
//   - recuperação de lazy-load: se tools/call falhar com "not loaded", roda
//     tool_search pelas 4 palavras-chave dos grupos e repete UMA vez no mesmo ciclo.
//
// API pública (INALTERADA — server.js e agent.js importam daqui):
//   callTool(toolName, args, moodlrToken) -> objeto já parseado ({status,data,cache} …)
//   listTools(moodlrToken)               -> array de tools (para /api/validate)
//   + re-exporta sanitizePayload, extractJsonPayload e a taxonomia de erros
//     (MoodlrError é o alias legado de McpError).

import {
  createMcpClient,
  finishToolCall,
  McpError,
  McpAuthError,
} from './mcp-core.js';

// Re-exports para preservar a superfície pública histórica do moodlr.js.
// (McpAuthError é importado acima e re-exportado aqui para servir aos dois usos.)
export { McpAuthError };
export {
  sanitizePayload,
  extractJsonPayload,
  McpError as MoodlrError,
  McpHttpError,
  McpNetworkError,
  McpTimeoutError,
  McpProtocolError,
  McpToolError,
  McpSessionError,
} from './mcp-core.js';

// ───────────────────────────── configuração ──────────────────────────────
const DEFAULT_MCP_URL = 'https://api.core.moodlr.digital/api/mcp';

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

// Cliente MCP dedicado ao moodlr-ops.
const client = createMcpClient({ url: mcpUrl, label: 'moodlr-ops' });

// ─────────────────────────────── específicos ─────────────────────────────
function injectCompany(args) {
  const c = company();
  if (c && (args == null || args.company === undefined)) {
    return { ...(args || {}), company: c };
  }
  return args || {};
}

function looksLikeNotLoadedError(err) {
  if (!(err instanceof McpError)) return false;
  return /not\s*loaded|n[aã]o\s*(foi\s*)?carregad|tool_search/i.test(err.message || '');
}

// ──────────────────────────────── API pública ────────────────────────────
/**
 * Chama uma ferramenta do moodlr-ops. Abre → consulta → fecha. Injeta company.
 * Em caso de lazy-load ("not loaded"), destrava com tool_search e repete UMA vez.
 * @returns objeto já com JSON.parse aplicado (tipicamente { status, data, cache }).
 */
export async function callTool(toolName, args, moodlrToken) {
  if (!moodlrToken) throw new McpAuthError('Token do moodlr-ops ausente.', 401);
  const injected = injectCompany(args);
  const opts = HEAVY_TOOL_OPTS[toolName] || {};
  try {
    return await client.callTool(toolName, injected, moodlrToken, opts);
  } catch (err) {
    if (!looksLikeNotLoadedError(err)) throw err;
    // Lazy load do servidor: destrava com tool_search pelas palavras-chave dos
    // grupos e repete a chamada UMA vez, no mesmo ciclo (mesma sessão, se houver).
    const sessionId = await client.initializeSession(moodlrToken).catch(() => null);
    for (const kw of LAZY_LOAD_KEYWORDS) {
      try {
        await client.rpc('tools/call', { name: 'tool_search', arguments: { query: kw } }, moodlrToken, sessionId);
      } catch { /* best-effort: se a busca falhar, a retentativa abaixo decide */ }
    }
    const { result } = await client.rpc('tools/call', { name: toolName, arguments: injected }, moodlrToken, sessionId, opts);
    return finishToolCall(result, toolName);
  }
}

/**
 * Lista as ferramentas expostas pelo moodlr-ops. Usado por /api/validate para
 * provar que a chave do gestor é válida antes de liberar o app.
 */
export async function listTools(moodlrToken) {
  if (!moodlrToken) throw new McpAuthError('Token do moodlr-ops ausente.', 401);
  return client.listTools(moodlrToken);
}
