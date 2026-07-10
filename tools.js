// tools.js — Definição das ferramentas do moodlr-ops no formato Anthropic (tool use).
//
// Cada tool: { name, description (PT, explicando QUANDO usar), input_schema }.
// O campo "company" NÃO aparece em nenhum schema — é injetado pelo backend
// (moodlr.js) em toda tool call. Datas em YYYY-MM-DD (analise_campanhas aceita
// hora: "YYYY-MM-DD HH:MM:SS").
//
// As descriptions incorporam o guia operacional do moodlr-ops: o que cada tool
// devolve de fato (bruto vs líquido), pegadinhas e quando preferir outra tool.
//
// NOTA sobre a contagem: a spec original falava em "16 ferramentas" mas
// enumerava 15 concretas; depois foram acrescentadas mais 13, totalizando as
// 28 ferramentas implementadas abaixo.

/** @type {Array<{name:string, description:string, input_schema:object}>} */
export const TOOLS = [
  // ─────────────────────────────── FINANCEIRO ───────────────────────────────
  {
    name: 'roas_cross',
    description:
      'O CARRO-CHEFE do dia a dia: gasto FB × receita AdX BRUTA, lucro/ROAS bruto ' +
      'por projeto + totais, breakdown por plataforma (facebook/instagram/' +
      'audience_network), impressões/viewable/clicks. Use para "resumo do dia" e ' +
      'ROAS ao vivo — com group_by=project. ⚠️ ROAS BRUTO: break-even ≈ 1,11x ' +
      '(revshare) — abaixo disso o projeto sangra mesmo com receita > gasto.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
        country: { type: 'string', description: 'Opcional. Código do país (ex.: BR, US).' },
        group_by: { type: 'string', description: 'Opcional. Agrupamento (ex.: project, country).' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'resumo_financeiro',
    description:
      'O número LÍQUIDO oficial, por gestor e por blog: spend, revenue (bruta), ' +
      'revshare_revenue, real_profit, net_profit, commission e roi_percentage ' +
      '(líquidos), + linha "Company" com contingência. ⚠️ Só PERÍODOS FECHADOS — ' +
      'o dia de hoje vem VAZIO (fecha ~1 dia depois). Use para fechamento real; ' +
      'para hoje use roas_cross ou resumo_usuarios.',
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
      'Como resumo_financeiro mas AO VIVO por gestor/projeto (receita, gasto, ' +
      'lucro, ROI). ⚠️ CONSULTA PESADA: use SEMPRE range curto (idealmente 1 dia) ' +
      'e, se a pergunta for sobre o período do snapshot, responda do snapshot em ' +
      'vez de chamar de novo. Para "resumo do dia" prefira roas_cross (mais leve).',
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
    name: 'fechamento_mensal',
    description:
      'Histórico mês a mês do ciclo de fechamento: spend, revenue, comission, ' +
      'reference, closed, paid (pago vs em aberto). Bom para tendência de longo ' +
      'prazo e perguntas de repasse. Só períodos fechados. Sem id_blog traz todos.',
    input_schema: {
      type: 'object',
      properties: {
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para focar o fechamento.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'receita_diaria_site',
    description:
      'Receita BRUTA (antes do revshare) dia a dia. Com id, foca em UM projeto; ' +
      'sem id, agrega por dia TODOS os projetos do gestor. Use para ver a curva ' +
      'diária de receita de um blog específico ou o total diário da operação. ' +
      '⚠️ Valor BRUTO — para o número líquido real (pós-revshare) use ' +
      'resumo_financeiro ou resumo_usuarios.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: ['integer', 'string'],
          description: 'Opcional. ID do projeto/blog. Sem id, agrega por dia todos os projetos do gestor.',
        },
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'cotacao_dolar',
    description:
      'Cotação USD/BRL de uma data específica. Use para converter valores em ' +
      'dólar (ex.: gasto/receita de contas que operam em USD) para reais em ' +
      'análises e comparações.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Data de referência (YYYY-MM-DD).' },
      },
      required: ['date'],
      additionalProperties: false,
    },
  },

  // ─────────────────────────────── CAMPANHAS ────────────────────────────────
  {
    name: 'analise_campanhas',
    description:
      'Raio-x de adsets de um projeto (UTM + POSTID) — base do Auto Scale: gasto, ' +
      'receita, ROI, IDADE do adset, CPR, eCPM e viewability por país. Use para ' +
      'decidir o que escalar/cortar dentro de UM blog. ⚠️ Retorno GRANDE: foque ' +
      'nos piores por lucro e nos de idade alta com receita zero (adsets zumbi). ' +
      'Datas aceitam hora ("YYYY-MM-DD HH:MM:SS" — use 00:00:00 e 23:59:59 pro ' +
      'dia cheio). Resolva o id pela lista de projetos do snapshot (ou via ' +
      'listar_projetos) antes de chamar.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'ID do projeto/blog.' },
        start_date: { type: 'string', description: 'Data/hora inicial ("YYYY-MM-DD HH:MM:SS" ou YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data/hora final ("YYYY-MM-DD HH:MM:SS" ou YYYY-MM-DD).' },
      },
      required: ['id', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'receita_por_artigo',
    description:
      'Receita agrupada por artigo (id_post) de um projeto numa data, comparando ' +
      'com ontem. Use para "qual post rende mais" e para descobrir quais artigos ' +
      'estão puxando/derrubando a receita do blog.',
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
      'Campanhas do Google Ads por artigo de um projeto numa data (receita, gasto, ' +
      'ROI, eCPM vs ontem). SÓ para projetos que rodam Google Ads — confira o flag ' +
      'googleads na lista de projetos antes de chamar.',
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
      'Performance dos short-links/redirects de um projeto por slug, país e ' +
      'id_post numa data. Use para analisar cliques e conversão dos redirects ' +
      '(funil de entrada do tráfego).',
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
    name: 'campanhas_utm',
    description:
      'Relatório de um projeto agrupado por UTM (origem/campanha) e país numa ' +
      'data, comparando com ontem: gasto, receita, revshare e ROI. Use para ver ' +
      'qual UTM/origem de tráfego está performando melhor ou pior dentro de um ' +
      'blog. ⚠️ revenue é BRUTA; revshare e lucro/roi já vêm pós-revshare (líquidos).',
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
    name: 'relatorio_chatbot',
    description:
      'Funil de CHATBOT de um projeto numa data: campanhas que alimentam o ' +
      'chatbot (gasto, receita, ROI), comparando com ontem e com a média dos ' +
      'últimos 30 dias. SÓ para projetos com chatbot=true na lista de projetos — ' +
      'confira o flag antes de chamar. ⚠️ revenue é BRUTA; lucro e roi_percentage ' +
      'já vêm pós-revshare (líquidos).',
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
    name: 'ranking_volume',
    description:
      'Ranking dos projetos por VOLUME de campanhas criadas no período (não é ' +
      'ranking de lucro/receita). Use para ver onde a operação está mais ativa ' +
      'em criação de campanhas — bom para identificar blogs com baixo volume que ' +
      'poderiam escalar mais.',
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

  // ─────────────────────────────── INTELIGÊNCIA ─────────────────────────────
  {
    name: 'fadiga_criativo',
    description:
      'Adsets com FADIGA de criativo (CPR do FB subindo + eCPM caindo + frequência ' +
      'alta), janela automática 7d vs 7d. Retorna fatigue_score, status ' +
      '(ok/attention/fatigued), projected_savings_3d e ROI LÍQUIDO. Use para ' +
      '"quais criativos trocar" e quanto economiza cortando. Sem filtro traz ' +
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
      'Alertas de saúde das contas de anúncio do Facebook/BMs (checkpoint, conta ' +
      'restrita, problema de token). Responde "alguma conta com problema?" — ' +
      'total_alerts: 0 significa tudo ok. Também já vem no snapshot do dia; ' +
      'responda do snapshot se a pergunta for geral.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'yield_por_hora',
    description:
      'eCPM por hora do dia (heatmap) — retorna best_hour, a melhor hora para ' +
      'escalar. Use quando perguntarem QUANDO escalar / em que horário o yield ' +
      'rende mais. pivot aceita ex.: day, project. Base para decidir horário de escala.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Data inicial (YYYY-MM-DD).' },
        end_date: { type: 'string', description: 'Data final (YYYY-MM-DD).' },
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
        pivot: { type: 'string', description: 'Opcional. Dimensão do heatmap (ex.: day, project).' },
        top_n: { type: 'integer', description: 'Opcional. Quantidade de linhas de topo a retornar.' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequencia_dias',
    description:
      'Streak de dias positivos/negativos (LÍQUIDO) nos últimos 365 dias. É o ' +
      'FILTRO DE SINAL vs RUÍDO: separa "dia ruim" de "projeto quebrado". Rode ' +
      'SEMPRE antes de recomendar corte de projeto — um streak negativo longo é ' +
      'padrão, um dia isolado é ruído.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'Opcional. ID do projeto/blog.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'rotacoes_criativo',
    description:
      'Histórico de ROTAÇÕES de criativo já executadas: CPR e eCPM antes/depois ' +
      'da troca e o resultado. Complementa fadiga_criativo — use para conferir ' +
      'se uma troca de criativo já feita realmente melhorou o desempenho do ' +
      'adset. Sem id_blog traz todas as rotações.',
    input_schema: {
      type: 'object',
      properties: {
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'adsets_pausados',
    description:
      'Adsets atualmente PAUSADOS pelo Auto Scale: projeto, campanha e quando ' +
      'reativam. Use para "o que está pausado agora" e para saber quando um ' +
      'adset volta a rodar. Também já vem no snapshot do dia — responda do ' +
      'snapshot se a pergunta for geral.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'historico_facebook',
    description:
      'Timeline de ALTERAÇÕES feitas no Facebook (mudança de budget, status, ' +
      'etc.). Use para investigar "o que mudou nessa conta/adset" e quando. ' +
      'Pode filtrar por blog (id_blog), por adset específico (adset), pelos ' +
      'dois, ou nenhum (traz tudo).',
    input_schema: {
      type: 'object',
      properties: {
        id_blog: { type: ['integer', 'string'], description: 'Opcional. ID do blog para filtrar.' },
        adset: { type: 'string', description: 'Opcional. Nome ou ID do adset para filtrar.' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // ───────────────────────────────── INFRA ──────────────────────────────────
  {
    name: 'listar_projetos',
    description:
      'Lista de blogs/projetos DESTE GESTOR: id, blog, domínio, nicho, se tem ' +
      'chatbot e se roda Google Ads. A lista normalmente já vem no snapshot ' +
      '(campo projetos) — chame esta tool se o snapshot estiver ausente, ' +
      'desatualizado ou sem os campos necessários (é dela que saem os id_blog ' +
      'das outras tools).',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'contas_facebook',
    description:
      'Contas de anúncio (BMs) do Facebook: nome, act_id, status e gasto. Use ' +
      'quando perguntarem sobre as contas em si (quais existem, status, quanto gastaram).',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'conteudo_writing',
    description:
      'Fila de artigos do WRITING (bulk_post): status, título, projeto, persona. ' +
      'Use quando o gestor perguntar sobre a produção de conteúdo (o que está ' +
      'sendo/foi escrito). Aceita uma data opcional.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Opcional. Data de referência (YYYY-MM-DD).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'contas_google_ads',
    description:
      'Contas do Google Ads do gestor: customer_id, status e vínculo com o ' +
      'projeto. Análogo a contas_facebook mas do lado Google Ads. Use quando ' +
      'perguntarem sobre as contas Google Ads em si (quais existem, status, ' +
      'qual projeto).',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'conteudo_writing_plus',
    description:
      'Fila de conteúdos do WRITING PLUS (mirb/acervo/card/botões) — linha de ' +
      'produção separada de conteudo_writing. Use quando o gestor perguntar ' +
      'sobre produção de mirb, acervo, card ou botões. Aceita uma data opcional.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Opcional. Data de referência (YYYY-MM-DD).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'posts_wordpress',
    description:
      'Últimos posts publicados no WordPress dos sites informados (título, data ' +
      'de publicação, URL). Use para conferir se o conteúdo programado já foi ao ' +
      'ar ou para ver a publicação recente de um ou mais blogs.',
    input_schema: {
      type: 'object',
      properties: {
        sites: {
          type: 'string',
          description:
            'Domínio(s) dos sites a consultar. Aceita um domínio único ou uma ' +
            'lista separada por vírgula (ex.: "miawzy.com,glooum.com").',
        },
      },
      required: ['sites'],
      additionalProperties: false,
    },
  },
  {
    name: 'tickets',
    description:
      'Tickets de suporte abertos na operação: status, data e gestor ' +
      'responsável. Use quando perguntarem sobre chamados/tickets de suporte em ' +
      'aberto ou histórico.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'status_coletores_fb',
    description:
      'Progresso dos coletores/scripts que puxam dados do Facebook: status da ' +
      'coleta, se está rodando, atrasada ou concluída. Use para diagnosticar se ' +
      'um dado do FB pode estar desatualizado por falha/atraso na coleta.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

/** Conjunto de nomes válidos — usado para validar tool calls antes de executar. */
export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
