// tools-ruler.js — Ferramentas do ruler-mcp (price floors ActiveView) no formato
// Anthropic (tool use). Lado da VENDA da operação: calibra o piso de preço (floor)
// que a ActiveView usa nos leilões de display.
//
// Cada tool: { name, description (PT, explicando QUANDO usar), input_schema }.
//
// INJETADOS PELO BACKEND, NUNCA expostos ao modelo (não aparecem em schema):
//   - av_bearer  → credencial de escrita da ActiveView (ruler.js injeta em todas
//                  exceto historico_ajustes);
//   - actor      → nome do gestor, injetado SÓ quando confirm=true (agent.js).
//
// NO schema (o GESTOR informa na conversa — NÃO há descoberta automática):
//   - network e domain. As descriptions deixam explícito que, se o gestor não
//     disser network/domain, o agente deve PERGUNTAR (não há como listar sozinho).

/** @type {Array<{name:string, description:string, input_schema:object}>} */
export const RULER_TOOLS = [
  {
    name: 'resumo_floors',
    description:
      'PANORAMA de price floors de um domínio (lado da VENDA/ActiveView): revenue ' +
      'total, impressões, eCPM médio PONDERADO, nº de regras ativas, TOP regras por ' +
      'revenue e — o mais importante — as REGRAS PROBLEMÁTICAS (floor mal calibrado, ' +
      'match_rate longe do desejado). É o ponto de partida do diagnóstico de floors. ' +
      '⚠️ network e domain NÃO têm descoberta automática: se o gestor não informar, ' +
      'PERGUNTE qual network e qual domínio antes de chamar.',
    input_schema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'Rede/SSP na ActiveView (o gestor informa; sem descoberta automática).' },
        domain: { type: 'string', description: 'Domínio a analisar, ex.: blog.miawzy.com (o gestor informa).' },
      },
      required: ['network', 'domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'listar_price_rules',
    description:
      'DETALHE regra a regra do domínio: floor atual (rule), eCPM, revenue, ' +
      'impressões, match_rate vs desired_match_rate, aggressiveness, país, device, ' +
      'request_uri, utm, ad_unit e se está enabled. Use depois do resumo_floors para ' +
      'ver exatamente ONDE mexer e para montar o array de regras do aplicar_floor. ' +
      'Leitura de floor: match_rate muito abaixo do desired = floor ALTO demais ' +
      '(perdendo impressão); match_rate colado no teto com eCPM baixo = floor BAIXO ' +
      'demais (queimando yield). network e domain são informados pelo gestor.',
    input_schema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'Rede/SSP na ActiveView (o gestor informa).' },
        domain: { type: 'string', description: 'Domínio a detalhar (o gestor informa).' },
      },
      required: ['network', 'domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'sugerir_floor',
    description:
      'SUGESTÕES de ajuste (SUBIR/DESCER o floor) por regra, SEM aplicar nada — é ' +
      'só recomendação, não escreve na ActiveView. Use para propor um plano de ' +
      'calibração ao gestor antes de qualquer aplicação. As sugestões viram a base ' +
      'do array `rules` do aplicar_floor. network e domain informados pelo gestor.',
    input_schema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'Rede/SSP na ActiveView (o gestor informa).' },
        domain: { type: 'string', description: 'Domínio para gerar sugestões (o gestor informa).' },
      },
      required: ['network', 'domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'historico_ajustes',
    description:
      'AUDITORIA dos ajustes de floor já aplicados (log: quando, o que mudou e por ' +
      'quem foi aplicado). Use para MEDIR O EFEITO de um ajuste depois de aplicado, ou ' +
      'para checar o que já foi mexido. É só leitura — NÃO exige a credencial de escrita ' +
      'da ActiveView, então funciona mesmo sem essa credencial configurada. Pode filtrar ' +
      'por domínio e limitar a quantidade.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Opcional. Filtra o histórico por domínio.' },
        limit: { type: 'integer', description: 'Opcional. Máximo de entradas a retornar (mais recentes primeiro).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'aplicar_floor',
    description:
      'APLICA (upsert REAL na ActiveView) um conjunto de regras de floor. ⚠️ MEXE EM ' +
      'RECEITA DE VERDADE. FLUXO OBRIGATÓRIO: 1) chame SEM confirm (ou confirm=false) ' +
      'para receber um PREVIEW do que mudaria (floor atual → novo, regra a regra) — ' +
      'NADA é aplicado; 2) mostre o preview ao gestor e obtenha aprovação EXPLÍCITA na ' +
      'conversa; 3) só então chame de novo com confirm=true. A trava do preview é ' +
      'reforçada no backend: confirm=true sem um preview recente do MESMO network+domain ' +
      'é REJEITADO. `rules` é um array de objetos no formato ActiveView (pass-through): ' +
      'cada objeto pode ter rule (o valor do floor), country, device, request_uri, ' +
      'utm_source, ad_unit, enabled, entre outros — monte a partir do listar_price_rules/' +
      'sugerir_floor. network e domain são informados pelo gestor.',
    input_schema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'Rede/SSP na ActiveView (o gestor informa).' },
        domain: { type: 'string', description: 'Domínio alvo do upsert (o gestor informa).' },
        rules: {
          type: 'array',
          description:
            'Regras a aplicar, formato ActiveView (pass-through). Cada item é um objeto ' +
            'livre; os campos abaixo são os comuns, mas outros são aceitos.',
          items: {
            type: 'object',
            properties: {
              rule: { type: ['number', 'string'], description: 'Valor do floor (piso de preço) desta regra.' },
              country: { type: 'string', description: 'País-alvo (ex.: BR, US).' },
              device: { type: 'string', description: 'Device-alvo (ex.: mobile, desktop).' },
              request_uri: { type: 'string', description: 'URI/caminho da regra.' },
              utm_source: { type: 'string', description: 'utm_source da regra.' },
              ad_unit: { type: 'string', description: 'Ad unit da regra.' },
              enabled: { type: 'boolean', description: 'Se a regra fica ativa.' },
            },
            additionalProperties: true,
          },
        },
        confirm: {
          type: 'boolean',
          description:
            'false/omitido = PREVIEW (não aplica). true = APLICA DE VERDADE — só use após ' +
            'preview + aprovação explícita do gestor. Sem preview recente, o backend recusa.',
        },
      },
      required: ['network', 'domain', 'rules'],
      additionalProperties: false,
    },
  },
];

/** Conjunto de nomes das tools do ruler — usado pelo agent.js para rotear a execução. */
export const RULER_TOOL_NAMES = new Set(RULER_TOOLS.map((t) => t.name));
