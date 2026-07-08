// agent.js — Loop de tool use multi-turn do CORTEX + streaming SSE (backend→browser).
//
// runAgentStream({ res, messages, managerName, moodlrToken, model, snapshot,
//                  rulerToken, avBearer, signal }):
//   - Chama a Anthropic Messages API com streaming e as ferramentas dos DOIS MCPs:
//     sempre as do moodlr-ops (compra); e as do ruler-mcp (venda/price floors) SÓ
//     quando o gestor tem rulerToken configurado.
//   - Enquanto stop_reason === "tool_use": executa TODAS as tools da rodada em
//     paralelo, roteando por nome (RULER_TOOL_NAMES → ruler; senão → moodlr),
//     devolve os tool_result num ÚNICO user message e continua. Máx. 8 rodadas.
//   - Emite eventos SSE do contrato: delta / tool / done / error.
//
// TRAVA DE DINHEIRO (aplicar_floor): a aplicação de floors mexe em receita real.
// Há uma guarda SERVER-SIDE, à prova de prompt injection (é código, não prompt):
// confirm=true só passa se houve um PREVIEW recente (sem confirm) do mesmo
// network+domain, para o MESMO gestor (chaveado por hash SHA-256 do rulerToken).
//
// IMPORTANTE (Messages API):
//   - IDs de modelo exatos: "claude-sonnet-5" | "claude-opus-4-8" (sem sufixo).
//   - NÃO passar temperature/top_p/top_k nem thinking (esses modelos dão 400).
//   - Streaming: client.messages.stream({...}); deltas via stream.on("text");
//     ao final const msg = await stream.finalMessage().

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from './tools.js';
import { RULER_TOOLS, RULER_TOOL_NAMES } from './tools-ruler.js';
import { callTool, McpAuthError, McpTimeoutError, McpNetworkError } from './moodlr.js';
import { callRulerTool } from './ruler.js';
import { McpToolError } from './mcp-core.js';

const MAX_ROUNDS = 8;
const MAX_TOKENS = 8192;
const SNAPSHOT_CHAR_LIMIT = 80_000; // proteção de tamanho do JSON do snapshot no prompt
const MANAGER_NAME_LIMIT = 80;

const VALID_MODELS = new Set(['claude-sonnet-5', 'claude-opus-4-8']);

// Cliente criado uma vez (após o dotenv já ter carregado, pois server.js importa
// 'dotenv/config' antes de agent.js). A ANTHROPIC_API_KEY vem do ambiente e NUNCA
// é exposta ao frontend nem logada.
let _client;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// ────────────────────────────── SSE helper ───────────────────────────────
function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─────────────────────────── datas / snapshot ────────────────────────────
function todaySaoPaulo() {
  // en-CA formata como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function snapshotAgeMinutes(snapshot) {
  const ts = snapshot?.timestamp;
  if (!ts || typeof ts !== 'number') return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60_000));
}

// ═══════════════════════ TRAVA DO APLICAR_FLOOR (server-side) ══════════════
// Registro de previews em memória. Chaveado pelo HASH SHA-256 do rulerToken —
// NUNCA o token cru. Guarda o último preview {network, domain, ts} por gestor.
// TTL 15 min + cap de tamanho (não cresce sem limite). Como é código, o modelo
// não tem como pular a guarda por prompt injection.
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_CAP = 500; // nº máx. de gestores distintos rastreados simultaneamente
const previewRegistry = new Map(); // hash(rulerToken) -> { network, domain, ts }

function tokenHash(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

// Normaliza network/domain para comparação robusta (o modelo pode variar
// caixa/espacos entre o preview e o confirm).
function normKey(s) {
  return String(s ?? '').trim().toLowerCase();
}

function prunePreviews(now = Date.now()) {
  for (const [k, v] of previewRegistry) {
    if (now - v.ts > PREVIEW_TTL_MS) previewRegistry.delete(k);
  }
  if (previewRegistry.size > PREVIEW_CAP) {
    // Descarta os mais antigos até voltar ao teto.
    const oldestFirst = [...previewRegistry.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < oldestFirst.length - PREVIEW_CAP; i++) {
      previewRegistry.delete(oldestFirst[i][0]);
    }
  }
}

function registerPreview(rulerToken, network, domain) {
  previewRegistry.set(tokenHash(rulerToken), {
    network: normKey(network),
    domain: normKey(domain),
    ts: Date.now(),
  });
  // Poda DEPOIS de inserir → garante a pós-condição size <= PREVIEW_CAP a cada
  // registro (podar antes deixaria o Map estabilizar em CAP+1).
  prunePreviews();
}

function hasValidPreview(rulerToken, network, domain) {
  const key = tokenHash(rulerToken);
  const rec = previewRegistry.get(key);
  if (!rec) return false;
  if (Date.now() - rec.ts > PREVIEW_TTL_MS) {
    previewRegistry.delete(key);
    return false;
  }
  return rec.network === normKey(network) && rec.domain === normKey(domain);
}

function consumePreview(rulerToken) {
  previewRegistry.delete(tokenHash(rulerToken));
}

// ─────────────────────────── system prompt ───────────────────────────────
// Bloco ESTÁVEL (persona + regras). É igual byte-a-byte para TODOS os gestores e
// TODAS as requisições → é o que colocamos no cache de prompt. Nada de nome do
// gestor, data ou snapshot aqui (isso invalidaria o cache). O bloco de floors
// TAMBÉM é estável: descreve as tools de venda para todo mundo, mas instrui o
// modelo a só USÁ-LAS/MENCIONÁ-LAS quando elas aparecerem na lista de tools (ou
// seja, quando o gestor configurou a key do ruler). Assim mantemos UM único
// prefixo cacheável, e a disponibilidade real é decidida pela lista `tools`.
const STABLE_SYSTEM = `Você é o CORTEX, braço direito operacional da Moodlr LLC — o cérebro central da operação de tráfego e arbitragem de display.

ESTILO: português do Brasil, direto e informal, pegada cyberpunk/hacker sem exagero. Fala como um trafficker experiente que vive de mídia paga (Facebook Ads, Google Ads), arbitragem de display (AdX/AdSense) e monetização de blog. Chama o gestor pelo nome.

POSTURA: analítico e honesto. Aponta o que está ruim sem dourar a pílula, sugere o que ESCALAR e o que CORTAR. Lê ROI, eCPM, CPR e fadiga de criativo como quem faz isso o dia inteiro. Quando os números pedem ação, recomenda a ação — não fica em cima do muro. Respostas em markdown, objetivas. NUNCA inventa números: quando faltar dado, diz o que falta e qual ferramenta pode buscar.

COMO USAR OS DADOS (regra central):
- Você recebe um SNAPSHOT do dia (no bloco "CONTEXTO DESTA SESSÃO", logo abaixo) com: receita/gasto/lucro/ROI por projeto (resumo_usuarios), saúde das contas de anúncio do Facebook (saude_contas_fb), fadiga de criativos (fadiga_criativo) e a lista de projetos (listar_projetos).
- Perguntas COBERTAS pelo snapshot (visão geral do dia, um blog específico da lista, alertas de conta/fadiga) → RESPONDA DIRETO do snapshot, SEM chamar ferramenta. É instantâneo.
- Dados GRANULARES ou de PERÍODO DIFERENTE do snapshot (campanhas de um projeto, receita por artigo, redirects, yield por hora, ROAS cross, fechamento, sequência de dias, período que não é o do snapshot) → USE as ferramentas.
- resumo_usuarios é PESADO: só chame com intervalos curtos e prefira o snapshot sempre que a pergunta for sobre o período já carregado.
- Você PODE ENCADEAR ferramentas: ex. resolver um id e depois analisar (analise_campanhas).
- PROJETOS DO GESTOR: você NÃO tem lista fixa de projetos. Os projetos deste gestor vêm do próprio moodlr-ops, escopados pelo token dele — resolva nome→id pela lista "projetos" do snapshot; se não estiver lá, chame listar_projetos. NUNCA mencione, assuma ou invente projetos que não estejam nos dados retornados para este gestor.
- Se o snapshot vier vazio/ausente, avise rapidamente e apoie-se nas ferramentas.
- Datas em YYYY-MM-DD (analise_campanhas aceita hora: "YYYY-MM-DD HH:MM:SS" — use 00:00:00 e 23:59:59 pro dia cheio).

REGRAS DE OURO DOS DADOS (moodlr-ops):
- REVSHARE: toda tool devolve receita/revenue/gam_revenue/adx BRUTA (antes do revshare, ~10%). Os campos lucro, net_profit, real_profit, roi_percentage e revshare_revenue já são LÍQUIDOS — use esses pro número real. NUNCA recalcule ROI/lucro a partir da receita bruta (não bate). Sempre diga se o valor citado é BRUTO ou LÍQUIDO.
- BREAK-EVEN: ROAS bruto de break-even ≈ 1,11x (efeito do revshare). Abaixo disso o projeto SANGRA mesmo com "receita > gasto".
- FORMATO DOS NÚMEROS: ROAS SEMPRE como multiplicador ("ROAS 1,24x"), NUNCA em porcentagem — "ROAS 123,98%" confunde com ROI. Quando quiser %, use ROI e rotule como ROI (ROI bruto = ROAS − 1; ex.: ROAS 1,24x = ROI bruto +23,98%). Ao citar lucro bruto, deixe claro que NÃO é dinheiro no bolso: confronte com o break-even 1,11x e diga a folga/déficit (ex.: "1,24x vs break-even 1,11x — folga de 0,13x"); o líquido oficial sai no resumo_financeiro do dia seguinte.
- DIA CORRENTE vs FECHADO: o dia de hoje só sai nas tools AO VIVO (roas_cross, resumo_usuarios, analise_campanhas). resumo_financeiro e fechamento_mensal só trazem períodos FECHADOS — hoje vem vazio e fecha ~1 dia depois.
- Linha truncada/sem valor: deixa de fora. Nunca preencha célula com estimativa como se fosse dado real.
- NUNCA afirme que "a API caiu" ou "está retornando lixo" a menos que TODAS as chamadas tenham falhado com erro de rede/timeout. O moodlr-ops costuma grudar avisos em texto (revshare/ROAS bruto) antes do JSON — isso é esperado e o backend já trata; falha de UMA tool não significa API fora do ar.

WORKFLOWS PADRÃO (encadeamentos que funcionam):
- "Resumo do dia" → roas_cross(hoje, group_by=project) → aplicar break-even 1,11x → destacar quem está acima/abaixo.
- "Projeto ruim, corto?" → sequencia_dias(id) pra separar dia ruim de projeto quebrado → se streak negativo longo, analise_campanhas(id, hoje) pra achar adsets zumbi (idade alta, receita zero) → fadiga_criativo(id) pra ver se é criativo cansado.
- "Fechamento real de ontem" → resumo_financeiro(ontem, ontem) → usar net_profit/roi_percentage (líquidos).
- "Onde/quando escalar" → yield_por_hora(id, pivot=day) → best_hour.
- "Conta com problema?" → saude_contas_fb (total_alerts 0 = tudo ok).

━━━━━━━━ PRICE FLOORS — LADO DA VENDA (ruler-mcp / ActiveView) ━━━━━━━━
Enquanto o moodlr-ops é o lado da COMPRA (quanto você paga em mídia), o ruler-mcp é o lado da VENDA: o piso de preço (floor) que a ActiveView usa nos leilões de display. Tools: resumo_floors, listar_price_rules, sugerir_floor, historico_ajustes, aplicar_floor.

DISPONIBILIDADE: essas tools SÓ existem se o gestor configurou as chaves do ruler (key do ruler-mcp + bearer da ActiveView). Se você NÃO vê as tools de floor na sua lista de ferramentas, elas não estão disponíveis para este gestor — NÃO as mencione como opção nem prometa usá-las; no máximo diga que dá pra habilitar o módulo de floors na config.

SEM DESCOBERTA AUTOMÁTICA: não existe "listar domínios/networks" — network e domain são informados pelo GESTOR. Se ele pedir algo de floor sem dizer qual network/domínio, PERGUNTE antes de chamar qualquer tool.

⚠️ REGRA DE OURO DOS FLOORS: aplicar_floor faz upsert REAL na ActiveView — mexe em RECEITA de verdade. NUNCA aplique sem aprovação. O fluxo é sagrado: (1) rode aplicar_floor SEM confirm para gerar um PREVIEW; (2) mostre ao gestor o antes→depois REGRA POR REGRA (floor atual → novo); (3) só confirme (confirm=true) após aprovação EXPLÍCITA dele na conversa. O backend reforça isso: confirm=true sem um preview recente do mesmo network+domain é BLOQUEADO — não tente "pular" o preview.

FLUXO RECOMENDADO DE CALIBRAÇÃO:
1. resumo_floors(network, domain) → panorama + regras problemáticas.
2. listar_price_rules(network, domain) → detalhe regra a regra (match_rate vs desired, eCPM, floor atual).
3. CRUZE com o lado da COMPRA (moodlr-ops): roas_cross / analise_campanhas / fadiga_criativo do mesmo projeto.
4. sugerir_floor(network, domain) → sugestões SUBIR/DESCER (não aplica).
5. aplicar_floor SEM confirm (preview) → aprovação do gestor → aplicar_floor confirm=true.
6. historico_ajustes(domain) depois → medir o efeito do ajuste.

CROSS-ANALYSIS COMPRA × VENDA (o pulo do gato): quando o eCPM de um projeto cai, a causa pode estar nos DOIS lados — é fadiga de criativo (COMPRA: fadiga_criativo / analise_campanhas) OU floor mal calibrado (VENDA: listar_price_rules / resumo_floors)? Use os dois MCPs para separar. Leitura de floor: match_rate MUITO abaixo do desired_match_rate = floor ALTO demais (está recusando impressão e perdendo volume); match_rate colado no teto com eCPM baixo = floor BAIXO demais (está vendendo barato, queimando yield). Recomende subir/descer com base nesse trade-off, sempre confrontando com o ROI do lado da compra.`;

function sanitizeManagerName(name) {
  const clean = String(name || 'gestor').replace(/[\r\n]+/g, ' ').trim();
  return (clean || 'gestor').slice(0, MANAGER_NAME_LIMIT);
}

function buildSessionBlock(managerName, snapshot) {
  const date = todaySaoPaulo();
  const name = sanitizeManagerName(managerName);

  let snapLine;
  let snapJson;
  if (snapshot && typeof snapshot === 'object') {
    const age = snapshotAgeMinutes(snapshot);
    const p = snapshot.period || {};
    const ageTxt = age == null ? 'idade desconhecida' : `${age} min atrás`;
    snapLine = `Snapshot: ${ageTxt} — período ${p.label || '?'} (${p.start_date || '?'}→${p.end_date || '?'}).`;
    let raw = JSON.stringify(snapshot);
    if (raw.length > SNAPSHOT_CHAR_LIMIT) {
      raw = raw.slice(0, SNAPSHOT_CHAR_LIMIT) + ' …[SNAPSHOT TRUNCADO POR TAMANHO — use as ferramentas para detalhes que faltarem]';
    }
    snapJson = raw;
  } else {
    snapLine = 'Snapshot: AUSENTE nesta sessão — avise o gestor e responda usando as ferramentas.';
    snapJson = 'null';
  }

  return `CONTEXTO DESTA SESSÃO
Gestor: ${name}
Data de hoje (America/Sao_Paulo): ${date}
${snapLine}

Dados do snapshot (JSON):
${snapJson}`;
}

/**
 * Monta o system como array de 2 blocos:
 *  [0] ESTÁVEL, com cache_control ephemeral → prefixo cacheável (persona+regras+floors).
 *  [1] VOLÁTIL (nome, data, snapshot) → depois do breakpoint, não invalida o cache.
 * Ver DESIGN.md → "Snapshot no system prompt e prompt cache".
 */
function buildSystem(managerName, snapshot) {
  return [
    { type: 'text', text: STABLE_SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildSessionBlock(managerName, snapshot) },
  ];
}

// ─────────────────────────── histórico de chat ───────────────────────────
function normalizeMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    if (!content.trim()) continue;
    out.push({ role: m.role, content });
  }
  // A Messages API exige que a primeira mensagem seja "user" — descarta
  // assistants líderes (ex.: saudação de UI persistida no histórico do chat).
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

// ─────────────────────────── mensagens de erro ───────────────────────────
function friendlyError(err) {
  if (err instanceof McpAuthError) return 'Sua chave do moodlr-ops foi recusada. Confira a config e entre de novo.';
  if (err instanceof McpTimeoutError) return 'O moodlr-ops demorou demais pra responder. Tenta de novo daqui a pouco.';
  if (err instanceof McpNetworkError) return 'Não consegui falar com o moodlr-ops agora. Tenta novamente em instantes.';
  // Erros do SDK da Anthropic (APIError tem .status)
  const status = err?.status;
  if (status === 401 || status === 403) return 'Erro de configuração do servidor de IA. Avise o time.';
  if (status === 429) return 'Muita gente perguntando ao mesmo tempo. Espera uns segundos e manda de novo.';
  if (status === 529 || status === 500 || status === 503) return 'O serviço de IA está sobrecarregado. Tenta de novo daqui a pouco.';
  return 'Deu um problema aqui no CORTEX. Tenta reformular ou repetir a pergunta.';
}

// ──────────────────── execução/roteamento de uma tool ─────────────────────
/**
 * Aplica a TRAVA server-side do aplicar_floor. Retorna o payload da tool.
 * Lança McpToolError (vira tool_result is_error) quando a guarda barra a operação.
 */
async function applyFloorGuarded(input, ctx) {
  const network = input?.network;
  const domain = input?.domain;
  // Fail-safe: SÓ o booleano `true` conta como confirmação. String "true",
  // 1, "1", {} etc. caem no caminho de PREVIEW (nunca aplicam por engano).
  const wantsConfirm = input?.confirm === true;

  // Permite injetar o transporte no teste; em produção usa o callRulerTool real.
  const callRuler = ctx.callRuler || callRulerTool;

  // O modelo nunca deve injetar `actor` — é o backend que define quem aprovou.
  const base = { ...(input || {}) };
  delete base.actor;

  if (!wantsConfirm) {
    // PREVIEW: roda sem confirm (o servidor devolve o preview, não aplica) e
    // REGISTRA o preview para destravar um confirm subsequente.
    const args = { ...base, confirm: false };
    const data = await callRuler('aplicar_floor', args, ctx.rulerToken, ctx.avBearer);
    registerPreview(ctx.rulerToken, network, domain);
    return data;
  }

  // CONFIRM: só passa com preview recente do mesmo gestor + network + domain.
  if (!hasValidPreview(ctx.rulerToken, network, domain)) {
    throw new McpToolError(
      'TRAVA DE SEGURANÇA: aplicar_floor com confirm=true foi BLOQUEADO — não há um preview recente ' +
        '(últimos 15 min) para este network+domain neste gestor. Rode aplicar_floor SEM confirm primeiro, ' +
        'mostre o antes→depois ao gestor, colha a aprovação explícita e só então confirme. ' +
        'Não há como pular esta etapa.',
    );
  }
  const args = { ...base, confirm: true, actor: sanitizeManagerName(ctx.managerName) };
  const data = await callRuler('aplicar_floor', args, ctx.rulerToken, ctx.avBearer);
  consumePreview(ctx.rulerToken); // one-shot: um preview autoriza UMA aplicação
  return data;
}

// Exportado APENAS para testes da trava (não usar em produção).
export const __floorGuardTestApi = { applyFloorGuarded, previewRegistry, PREVIEW_TTL_MS };

/** Roteia a execução de UMA tool para o MCP certo, aplicando as guardas do ruler. */
async function executeTool(name, input, ctx) {
  if (RULER_TOOL_NAMES.has(name)) {
    // Guarda de configuração: o modelo pode ter as tools de floor na lista (elas
    // só entram quando há rulerToken), mas por segurança confirmamos aqui também.
    if (!ctx.rulerToken) {
      throw new McpToolError(
        'As ferramentas de price floor exigem as chaves do ruler-mcp configuradas (key do ruler-mcp + ' +
          'bearer da ActiveView). Peça ao gestor para habilitar o módulo de floors em "trocar config".',
      );
    }
    if (name === 'aplicar_floor') return applyFloorGuarded(input, ctx);
    return callRulerTool(name, input, ctx.rulerToken, ctx.avBearer);
  }
  // Default: moodlr-ops (comportamento inalterado).
  return callTool(name, input, ctx.moodlrToken);
}

// ──────────────────────────── loop principal ─────────────────────────────
/**
 * Roda o agente e faz streaming SSE para `res`. Escreve os eventos do contrato
 * (delta/tool/done/error) e ENCERRA a conexão ao final.
 */
export async function runAgentStream({ res, messages, managerName, moodlrToken, model, snapshot, rulerToken, avBearer, signal }) {
  const chosenModel = VALID_MODELS.has(model) ? model : 'claude-sonnet-5';
  const client = getClient();
  const system = buildSystem(managerName, snapshot);
  const convo = normalizeMessages(messages);

  // As tools de floor só entram na lista quando o gestor configurou o ruler.
  const tools = rulerToken ? [...TOOLS, ...RULER_TOOLS] : TOOLS;

  // Contexto de execução repassado a cada tool (tokens NUNCA são logados).
  const ctx = { moodlrToken, rulerToken, avBearer, managerName };

  let finalStop = null;
  let hitCap = true;

  try {
    if (convo.length === 0) {
      sse(res, 'delta', { text: 'Manda a pergunta que eu puxo os dados. 🚀' });
      sse(res, 'done', { stopReason: 'end_turn' });
      return;
    }

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // Cliente desconectou (fechou a aba): para de gastar Anthropic/moodlr-ops.
      if (signal?.aborted) return;

      const stream = client.messages.stream(
        {
          model: chosenModel,
          max_tokens: MAX_TOKENS,
          system,
          messages: convo,
          tools,
        },
        { signal },
      );

      // Deltas de texto de TODAS as rodadas (inclusive texto antes de tool calls).
      stream.on('text', (delta) => sse(res, 'delta', { text: delta }));

      const msg = await stream.finalMessage();

      if (msg.stop_reason !== 'tool_use') {
        finalStop = msg.stop_reason || 'end_turn';
        hitCap = false;
        break;
      }

      // Preserva o turn do assistant (texto + blocos tool_use) no histórico.
      convo.push({ role: 'assistant', content: msg.content });

      const toolUses = msg.content.filter((b) => b.type === 'tool_use');

      // stop_reason "tool_use" sem blocos tool_use: um user message vazio de
      // tool_result seria rejeitado pela API — encerra a rodada aqui.
      if (toolUses.length === 0) {
        finalStop = 'end_turn';
        hitCap = false;
        break;
      }

      // Executa TODAS as tools da rodada em paralelo. Erro de tool NÃO derruba o
      // chat: vira tool_result com is_error e o agente segue. O roteamento
      // (moodlr vs ruler) e as guardas de floor ficam em executeTool.
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          sse(res, 'tool', { name: tu.name, status: 'start' });
          try {
            const data = await executeTool(tu.name, tu.input || {}, ctx);
            sse(res, 'tool', { name: tu.name, status: 'end', ok: true });
            return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(data) };
          } catch (err) {
            sse(res, 'tool', { name: tu.name, status: 'end', ok: false });
            return {
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify({ error: err?.message || 'falha na ferramenta' }),
              is_error: true,
            };
          }
        }),
      );

      // Um ÚNICO user message com todos os tool_result da rodada.
      convo.push({ role: 'user', content: toolResults });
    }

    if (hitCap) {
      sse(res, 'delta', {
        text: '\n\n_(Cheguei no limite de rodadas de ferramentas — parei por aqui. Se faltou detalhe, refaz a pergunta mais específica.)_',
      });
      finalStop = 'max_rounds';
    }

    sse(res, 'done', { stopReason: finalStop || 'end_turn' });
  } catch (err) {
    // Cliente abortou: não há mais ninguém para receber eventos.
    if (signal?.aborted) return;
    // Erros de tool já são tratados dentro do loop; aqui caem erros da Anthropic
    // API ou falhas inesperadas. Nunca vaza a ANTHROPIC_API_KEY nem os tokens.
    sse(res, 'error', { message: friendlyError(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
