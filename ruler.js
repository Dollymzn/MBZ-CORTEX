// ruler.js — Wrapper FINO do ruler-mcp (price floors ActiveView, lado da VENDA).
//
// Espelha o moodlr.js, mas o específico daqui é:
//   - injeção de `av_bearer` (bearer da ActiveView, arg de tool) em TODA tool
//     EXCETO historico_ajustes, que é auditoria e não exige credencial de escrita;
//   - NÃO injeta company (o ruler-mcp não usa company).
//
// Segurança: av_bearer é um SEGREDO — entra só nos args da chamada, NUNCA é logado.
// Se o servidor ecoar av_bearer de volta num preview de aplicar_floor, o
// sanitizePayload do core (que agora derruba chaves com "bearer") o remove antes
// de qualquer coisa chegar ao modelo.
//
// API pública:
//   callRulerTool(toolName, args, rulerToken, avBearer) -> objeto já parseado
//   listRulerTools(rulerToken)                          -> array (para /api/validate-ruler)

import { createMcpClient, McpAuthError, McpToolError } from './mcp-core.js';

// ───────────────────────────── configuração ──────────────────────────────
// Fato verificado em produção: o path é /api/mcp (o /mcp dá 404).
const DEFAULT_RULER_URL = 'https://ruler-mcp-mcping.up.railway.app/api/mcp';

// Auditoria: única tool que NÃO recebe av_bearer (não mexe/consulta a ActiveView
// com credencial de escrita — só lê o log de ajustes já feitos).
const NO_AV_BEARER_TOOLS = new Set(['historico_ajustes']);

// Lido de forma preguiçosa (dotenv já carregado quando a 1ª chamada acontece).
const rulerUrl = () => process.env.RULER_MCP_URL || DEFAULT_RULER_URL;

// Cliente MCP dedicado ao ruler-mcp (timeout 30s / 4 tentativas — padrão do core).
const client = createMcpClient({ url: rulerUrl, label: 'ruler-mcp' });

// ─────────────────────────────── específicos ─────────────────────────────
function injectAvBearer(toolName, args, avBearer) {
  if (NO_AV_BEARER_TOOLS.has(toolName)) return { ...(args || {}) };
  if (!avBearer) {
    throw new McpToolError(
      `A ferramenta ${toolName} precisa do bearer da ActiveView (av_bearer), que não está configurado. ` +
        'Peça ao gestor para preencher a chave da ActiveView em "trocar config" antes de usar os price floors.',
    );
  }
  return { ...(args || {}), av_bearer: avBearer };
}

// ──────────────────────────────── API pública ────────────────────────────
/**
 * Chama uma ferramenta do ruler-mcp. Abre → consulta → fecha. Injeta av_bearer
 * (exceto historico_ajustes). O rulerToken é o Bearer de auth do MCP; o avBearer
 * é a credencial da ActiveView que vai NO CORPO da tool.
 * @returns objeto já parseado (tipicamente { status, data, count/cache }).
 */
export async function callRulerTool(toolName, args, rulerToken, avBearer) {
  if (!rulerToken) throw new McpAuthError('Token do ruler-mcp ausente.', 401);
  const finalArgs = injectAvBearer(toolName, args, avBearer);
  return client.callTool(toolName, finalArgs, rulerToken);
}

/**
 * Lista as ferramentas do ruler-mcp. Usado por /api/validate-ruler para provar
 * que a chave do gestor é válida antes de liberar as tools de floor.
 */
export async function listRulerTools(rulerToken) {
  if (!rulerToken) throw new McpAuthError('Token do ruler-mcp ausente.', 401);
  return client.listTools(rulerToken);
}
