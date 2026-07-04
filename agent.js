// agent.js — Loop de tool use multi-turn do CORTEX + streaming SSE (backend→browser).
//
// runAgentStream({ res, messages, managerName, moodlrToken, model, snapshot }):
//   - Chama a Anthropic Messages API com streaming e as 16 ferramentas do moodlr-ops.
//   - Enquanto stop_reason === "tool_use": executa TODAS as tools da rodada em
//     paralelo (via moodlr.callTool, injetando o token do gestor), devolve os
//     tool_result num ÚNICO user message e continua. Máx. 8 rodadas.
//   - Emite eventos SSE do contrato: delta / tool / done / error.
//
// IMPORTANTE (Messages API):
//   - IDs de modelo exatos: "claude-sonnet-5" | "claude-opus-4-8" (sem sufixo).
//   - NÃO passar temperature/top_p/top_k nem thinking (esses modelos dão 400).
//   - Streaming: client.messages.stream({...}); deltas via stream.on("text");
//     ao final const msg = await stream.finalMessage().

import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from './tools.js';
import { callTool, McpAuthError, McpTimeoutError, McpNetworkError } from './moodlr.js';

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

// ─────────────────────────── system prompt ───────────────────────────────
// Bloco ESTÁVEL (persona + regras). É igual byte-a-byte para
// TODOS os gestores e TODAS as requisições → é o que colocamos no cache de prompt.
// Nada de nome do gestor, data ou snapshot aqui (isso invalidaria o cache).
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
- "Conta com problema?" → saude_contas_fb (total_alerts 0 = tudo ok).`;

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
 *  [0] ESTÁVEL, com cache_control ephemeral → prefixo cacheável (tools+persona+mapa).
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

// ──────────────────────────── loop principal ─────────────────────────────
/**
 * Roda o agente e faz streaming SSE para `res`. Escreve os eventos do contrato
 * (delta/tool/done/error) e ENCERRA a conexão ao final.
 */
export async function runAgentStream({ res, messages, managerName, moodlrToken, model, snapshot, signal }) {
  const chosenModel = VALID_MODELS.has(model) ? model : 'claude-sonnet-5';
  const client = getClient();
  const system = buildSystem(managerName, snapshot);
  const convo = normalizeMessages(messages);

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
          tools: TOOLS,
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
      // chat: vira tool_result com is_error e o agente segue.
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          sse(res, 'tool', { name: tu.name, status: 'start' });
          try {
            const data = await callTool(tu.name, tu.input || {}, moodlrToken);
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
    // API ou falhas inesperadas. Nunca vaza a ANTHROPIC_API_KEY nem o token.
    sse(res, 'error', { message: friendlyError(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
