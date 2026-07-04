// tools.js — Definição das ferramentas do moodlr-ops no formato Anthropic (tool use).
//
// Cada tool: { name, description (PT, explicando QUANDO usar), input_schema }.
// O campo "company" NÃO aparece em nenhum schema — é injetado pelo backend
// (moodlr.js) em toda tool call. Datas sempre em YYYY-MM-DD.
//
// NOTA sobre a contagem: a spec fala em "16 ferramentas", mas enumera apenas 15
// ferramentas concretas do moodlr-ops. Implementamos exatamente as 15 nomeadas —
// inventar uma 16ª faria o agente chamar uma tool que não existe no servidor MCP.
// Ver DESIGN.md → "Discrepância 15 vs 16".

/** @type {Array<{name:string, description:string, input_schema:object}>} */
export const TOOLS = [
  // ─────────────────────────────── FINANCEIRO ───────────────────────────────
  {
    name: 'resumo_financeiro',
    description:
      'Fechamento financeiro consolidado por dia/gestor: receita ADX, gasto FB, ' +
      'lucro e revshare. Use quando o gestor pedir o FECHAMENTO ou os números ' +
      'contábeis de um período (não os valores ao vivo). Para receita/gasto/lucro ' +
      'ao vivo por projeto prefira resumo_usuarios (ou o snapshot).',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'resumo_usuarios',
    description:
      'Receita, gasto, lucro e ROI por projeto AO VIVO. É a base da visão geral do ' +
      'dia. ⚠️ CONSULTA PESADA: use SEMPRE intervalos curtos (idealmente 1 dia) e, ' +
      'se a pergunta for sobre HOJE/o período do snapshot, prefira o snapshot em vez ' +
      'de chamar esta tool de novo. Só chame para períodos que NÃO estão no snapshot.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD). Mantenha o range curto.' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD). Mantenha o range curto.' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'roas_cross',
    description:
      'ROAS cross-channel cruzando gasto do Facebook Ads com receita do AdX. Use ' +
      'para avaliar a eficiência real do tráfego (retorno sobre o anúncio) num ' +
      'período, opcionalmente filtrando por blog, país ou agrupando por dimensão.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
        country: { type: 'string', description: 'Opcional. Código do país (ex.: BR, US).' },
        group_by: { type: 'string', description: 'Opcional. Dimensão de agrupamento (ex.: dia, pais, blog).' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'fechamento_mensal',
    description:
      'Fechamento mensal (o que já foi pago e o que está em aberto). Use quando o ' +
      'gestor perguntar sobre pagamentos/repasses do mês. Sem id_blog traz todos os ' +
      'projetos; com id_blog foca num só.',
    input_schema: {
      type: 'object',
      properties: {
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para focar o fechamento.' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // ─────────────────────────────── CAMPANHAS ────────────────────────────────
  {
    name: 'analise_campanhas',
    description:
      'Campanhas de um projeto detalhadas por UTM + POSTID — é a base do Auto Scale. ' +
      'Use para decidir o que escalar/cortar dentro de UM blog num período. Se você ' +
      'só tem o nome do blog, resolva o id pela lista de projetos do snapshot ' +
      '(ou via listar_projetos) antes de chamar.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'ID do projeto/blog.' },
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
      },
      required: ['id', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'receita_por_artigo',
    description:
      'Receita por artigo (id_post) de um projeto numa data, comparando com ontem. ' +
      'Use para descobrir quais artigos estão puxando/derrubando a receita do blog.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'ID do projeto/blog.' },
        date: { type: 'string', description: 'Data de referência (YYYY-MM-DD).' },
      },
      required: ['id', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'google_ads_projeto',
    description:
      'Campanhas do Google Ads por artigo de um projeto numa data, comparando com ' +
      'ontem. Use para blogs que rodam Google Ads quando o gestor ' +
      'perguntar sobre performance no GAds.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'ID do projeto/blog.' },
        date: { type: 'string', description: 'Data de referência (YYYY-MM-DD).' },
      },
      required: ['id', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'redirects_performance',
    description:
      'Performance dos short-links/redirects de um projeto por slug, país e post ' +
      'numa data. Use para analisar cliques e conversão dos redirects (funil de ' +
      'entrada do tráfego).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'ID do projeto/blog.' },
        date: { type: 'string', description: 'Data de referência (YYYY-MM-DD).' },
      },
      required: ['id', 'date'],
      additionalProperties: false,
    },
  },

  // ─────────────────────────────── INTELIGÊNCIA ─────────────────────────────
  {
    name: 'fadiga_criativo',
    description:
      'Adsets com FADIGA de criativo (CPR do FB subindo + eCPM caindo + frequência ' +
      'alta), com score de fadiga e ROI líquido, comparando 7d vs 7d. Use quando o ' +
      'gestor perguntar sobre criativos cansados / o que trocar. Sem filtro traz ' +
      'todos; pode filtrar por blog e/ou país. Também já vem no snapshot do dia.',
    input_schema: {
      type: 'object',
      properties: {
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
        country: { type: 'string', description: 'Opcional. Código do país (ex.: BR, US).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'saude_contas_fb',
    description:
      'Alertas de saúde das contas de anúncio do Facebook (checkpoint, restrição, ' +
      'problema de token, etc.). Use quando perguntarem se alguma conta/BM está com ' +
      'problema. Também já vem no snapshot do dia — responda do snapshot se a ' +
      'pergunta for geral.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'yield_por_hora',
    description:
      'eCPM por hora (heatmap) e a melhor hora do dia para escalar. Use quando o ' +
      'gestor perguntar QUANDO escalar / em que horário o yield rende mais. Aceita ' +
      'filtro por blog, um pivot de agrupamento e top_n de resultados.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
        pivot: { type: 'string', description: 'Opcional. Dimensão do heatmap (ex.: pais, blog).' },
        top_n: { type: 'integer', description: 'Opcional. Quantidade de linhas de topo a retornar.' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequencia_dias',
    description:
      'Streak (sequência) de dias positivos/negativos ao longo de 365 dias. Use para ' +
      'entender consistência/tendência de um projeto (ou geral, sem id).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'Opcional. ID do projeto/blog.' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // ───────────────────────────────── INFRA ──────────────────────────────────
  {
    name: 'listar_projetos',
    description:
      'Lista de blogs/projetos DESTE GESTOR: id, blog, domínio, nicho, se tem chatbot ' +
      'e se roda Google Ads. A lista normalmente já vem no snapshot (campo projetos) — ' +
      'chame esta tool se o snapshot estiver ausente, desatualizado ou sem os campos necessários.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'contas_facebook',
    description:
      'Contas de anúncio (BMs) do Facebook: nome, act_id, status e gasto. Use quando ' +
      'perguntarem sobre as contas em si (quais existem, status, quanto gastaram).',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'conteudo_writing',
    description:
      'Fila de artigos do Writing (produção de conteúdo). Use quando o gestor ' +
      'perguntar sobre o que está sendo/foi escrito. Aceita uma data opcional.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Opcional. Data de referência (YYYY-MM-DD).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** Conjunto de nomes válidos — usado para validar tool calls antes de executar. */
export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
