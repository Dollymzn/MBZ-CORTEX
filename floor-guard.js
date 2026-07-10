// floor-guard.js — TRAVA server-side do aplicar_floor (dinheiro real) + utilidades
// de segurança, COMPARTILHADAS entre o chat (agent.js) e as rotas do dashboard de
// floors (server.js). A guarda é CÓDIGO, não prompt: confirm=true só passa se houve
// um PREVIEW recente do mesmo gestor + network + domain. Um preview gerado no chat
// destrava um confirm no dashboard e vice-versa — mas SEMPRE tem que ter havido um
// preview. Nenhuma prompt injection nem clique de UI pula essa etapa.

import { createHash } from 'node:crypto';
import { McpToolError } from './mcp-core.js';

const PREVIEW_TTL_MS = 15 * 60 * 1000; // 15 min
const PREVIEW_CAP = 500; // nº máx. de alvos (gestor+domínio) rastreados ao mesmo tempo
const ACTOR_NAME_LIMIT = 80;

// Registro de previews em memória, ÚNICO pra toda a app (chat + dashboard).
// Chaveado por hash SHA-256 do token (NUNCA o token cru) + network + domain, para
// que um gestor tenha previews de vários domínios ao mesmo tempo sem se sobrescrever,
// o consumo seja cirúrgico (só o alvo confirmado) e não haja race entre chamadas
// paralelas. Valor: { ts }.
const previewRegistry = new Map();

function tokenHash(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

// Normaliza network/domain (o modelo/cliente pode variar caixa/espaços entre o
// preview e o confirm) para uma comparação robusta.
function normKey(s) {
  return String(s ?? '').trim().toLowerCase();
}

function previewKey(rulerToken, network, domain) {
  return `${tokenHash(rulerToken)}:${normKey(network)}:${normKey(domain)}`;
}

// Serialização CANÔNICA (chaves ordenadas em profundidade) → hash estável do
// rules[] independente da ordem das chaves. É o que amarra "confirmar exatamente
// o que foi previsto": o confirm só passa se o rules[] tiver o MESMO hash do preview.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function rulesHash(rules) {
  return createHash('sha256').update(stableStringify(rules ?? [])).digest('hex');
}

function prunePreviews(now = Date.now()) {
  for (const [k, v] of previewRegistry) {
    if (now - v.ts > PREVIEW_TTL_MS) previewRegistry.delete(k);
  }
  if (previewRegistry.size > PREVIEW_CAP) {
    const oldestFirst = [...previewRegistry.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < oldestFirst.length - PREVIEW_CAP; i++) {
      previewRegistry.delete(oldestFirst[i][0]);
    }
  }
}

// O preview guarda o HASH do rules[] revisado. Um confirm com rules[] diferente
// (ex.: o modelo, induzido por prompt-injection num output de tool, muda os
// valores) NÃO casa o hash e é barrado.
export function registerPreview(rulerToken, network, domain, hash) {
  previewRegistry.set(previewKey(rulerToken, network, domain), { ts: Date.now(), hash });
  // Poda DEPOIS de inserir → garante a pós-condição size <= PREVIEW_CAP.
  prunePreviews();
}

// Registro válido (dentro do TTL) para este alvo, ou null (limpando o expirado).
function getValidPreview(rulerToken, network, domain) {
  const key = previewKey(rulerToken, network, domain);
  const rec = previewRegistry.get(key);
  if (!rec) return null;
  if (Date.now() - rec.ts > PREVIEW_TTL_MS) {
    previewRegistry.delete(key);
    return null;
  }
  return rec;
}

export function consumePreview(rulerToken, network, domain) {
  previewRegistry.delete(previewKey(rulerToken, network, domain));
}

// O actor gravado no histórico da ActiveView é definido pelo BACKEND (o gestor
// autenticado), nunca pelo modelo nem pelo cliente.
export function sanitizeActor(name) {
  const clean = String(name || 'gestor').replace(/[\r\n]+/g, ' ').trim();
  return (clean || 'gestor').slice(0, ACTOR_NAME_LIMIT);
}

// Redige VALORES de segredos que possam ter vindo ecoados no TEXTO de uma mensagem
// de erro (o sanitizePayload limpa CHAVES de objetos; isto cuida de strings livres).
export function redactSecrets(text, ctx) {
  let out = String(text ?? '');
  for (const secret of [ctx?.avBearer, ctx?.rulerToken, ctx?.moodlrToken]) {
    if (secret && String(secret).length >= 6) {
      out = out.split(String(secret)).join('[REDIGIDO]');
    }
  }
  return out;
}

/**
 * Núcleo da trava. Roteia aplicar_floor por preview→confirm.
 * @param input  args da tool (network, domain, rules[], confirm?)
 * @param ctx    { rulerToken, avBearer, managerName, callRuler }
 *               callRuler(tool, args, rulerToken, avBearer) → payload (injetável p/ testes)
 * @returns { mode: 'preview' | 'applied', data }
 * @throws McpToolError quando a guarda barra um confirm sem preview válido.
 */
export async function guardedApplyFloor(input, ctx) {
  const network = input?.network;
  const domain = input?.domain;
  // Fail-safe: SÓ o booleano `true` confirma. String "true", 1, "1", {} etc.
  // caem no caminho de PREVIEW — nunca aplicam por engano/coerção.
  const wantsConfirm = input?.confirm === true;
  const callRuler = ctx.callRuler;
  const hash = rulesHash(input?.rules);

  // O modelo/cliente nunca injeta `actor` — é o backend que define quem aprovou.
  const base = { ...(input || {}) };
  delete base.actor;

  if (!wantsConfirm) {
    const data = await callRuler('aplicar_floor', { ...base, confirm: false }, ctx.rulerToken, ctx.avBearer);
    registerPreview(ctx.rulerToken, network, domain, hash);
    return { mode: 'preview', data };
  }

  // CONFIRM: exige um preview recente do MESMO alvo E do MESMO rules[] (hash).
  const rec = getValidPreview(ctx.rulerToken, network, domain);
  if (!rec || rec.hash !== hash) {
    const motivo = !rec
      ? 'não há um preview recente (últimos 15 min) para este network+domain neste gestor'
      : 'as regras a aplicar são DIFERENTES das do preview (o antes→depois aprovado não corresponde)';
    throw new McpToolError(
      `TRAVA DE SEGURANÇA: aplicar_floor com confirm=true foi BLOQUEADO — ${motivo}. Rode o preview ` +
        'primeiro (sem confirm), mostre o antes→depois, colha a aprovação explícita e só então confirme ' +
        'EXATAMENTE o que foi previsto. Não há como pular esta etapa.',
    );
  }

  // One-shot ATÔMICO: consome o preview ANTES do await (reserva). Assim dois
  // confirms concorrentes do mesmo alvo não passam os dois — o 2º já não acha
  // preview. Em falha REAL do upsert, devolve o preview pra permitir retry.
  consumePreview(ctx.rulerToken, network, domain);
  try {
    const args = { ...base, confirm: true, actor: sanitizeActor(ctx.managerName) };
    const data = await callRuler('aplicar_floor', args, ctx.rulerToken, ctx.avBearer);
    return { mode: 'applied', data };
  } catch (err) {
    registerPreview(ctx.rulerToken, network, domain, hash); // reabre a janela p/ retry legítimo
    throw err;
  }
}

// Exportado APENAS para testes da trava (não usar em produção).
export const __floorGuardTestApi = { previewRegistry, PREVIEW_TTL_MS, guardedApplyFloor, redactSecrets, rulesHash };
