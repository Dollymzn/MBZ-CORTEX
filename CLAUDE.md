# MBZ::CORTEX — Centro de Comando da Operação Moodlr

## Orchestration workflow
You (Fable) are the orchestrator. Plan, decompose, synthesize.
Reasoning-heavy phases (arquitetura, fluxo de tool use, parsing do MCP, streaming, cache/snapshot) → deep-reasoner (Opus 4.8)
Mechanical work (CSS cyberpunk, componentes de UI, boilerplate de rotas, schemas das tools) → fast-worker (Sonnet 5)
Codex (/codex:rescue --background) is a cracked engineer on par with deep-reasoner, from a different perspective. Treat as a peer, not a reviewer.

**Architecture & high-stakes phases run dual-track:** task Opus 4.8 AND Codex on the same problem IN PARALLEL, each blind to the other's answer. Then you (Fable) synthesize the best of both into the final design. This applies to:
- A arquitetura geral (estrutura de arquivos, contratos entre server.js / moodlr.js / agent.js)
- O proxy MCP stateless (parsing SSE vs JSON, o parse do result.content[0].text, retry/backoff, ciclo abre-consulta-fecha)
- O loop de tool use multi-turn do agente
- O modelo snapshot + cache (o que entra no snapshot, injeção no contexto, invalidação/refresh)

Para essas fases: rode os dois, compare as abordagens, e escolha/combine a mais robusta — sem mostrar a resposta de um para o outro. Keep your own context lean.
Mechanical phases (UI, CSS, boilerplate) ficam com fast-worker sozinho.

---

## O QUE É
MBZ::CORTEX é o cérebro central da operação de tráfego arbitragem da Moodlr LLC, usado por vários gestores. Combina:
- Um **AGENTE DE IA conversacional** que responde qualquer pergunta sobre a operação, puxando dados de um servidor MCP próprio (moodlr-ops)
- Um **DASHBOARD VISUAL** ao lado (cards, tabelas, alertas)
- Modelo **snapshot + cache**: consulta em lote 1x, salva, responde do cache; só reabre conexão pontual quando pede realtime/refresh

Estética cyberpunk neon MBZ (mesma família do MBZ::FORGE e MBZ::VAULT).

## STACK & DEPLOY
- Node.js + Express (backend), vanilla JS + HTML/CSS puro (frontend, SEM framework, SEM build step)
- Pronto pra Railway: package.json (type: module), Procfile ("web: npm start"), railway.json (NIXPACKS), .gitignore (node_modules, .env), .env.example, README com passo a passo de deploy
- Porta via process.env.PORT || 3000, servir /public estático
- Backend modular: server.js (rotas), moodlr.js (proxy MCP), agent.js (lógica do agente/Claude API)

## VARIÁVEIS DE AMBIENTE (servidor)
- ANTHROPIC_API_KEY — fixa no servidor. Os gestores NÃO precisam de conta Anthropic; o agente usa essa key pra todos.
- MOODLR_MCP_URL — default: https://api.core.moodlr.digital/api/mcp
- MOODLR_COMPANY — valor do parâmetro "company" (se o token já define escopo, pode ser vazio; senão, valor conhecido)

---

## TELA INICIAL (onboarding — localStorage, por gestor)
Modal cyberpunk na primeira vez, pedindo:
1. **Seu nome** — o agente te chama por ele
2. **Sua key do moodlr-ops** — Bearer token do gestor, define o escopo de dados dele
3. **Versão do agente** — seletor: "Claude Sonnet 5" (claude-sonnet-5) ou "Claude Opus 4.8" (claude-opus-4-8)

- Tudo salvo em localStorage (dados por dispositivo, cada gestor no seu navegador)
- Botão "Entrar" valida a key fazendo um tools/list de teste ANTES de liberar
- Próximas vezes entra direto; botão discreto "trocar config" que limpa localStorage
- A versão do agente é editável depois (dropdown no header)

---

## LAYOUT PRINCIPAL (split: chat + dashboard)
Split view: ESQUERDA o CHAT com o agente, DIREITA o DASHBOARD. Em mobile, viram abas (Chat / Dashboard).

### AGENTE IA (esquerda — o coração)
- Chat conversacional, histórico salvo em localStorage por gestor
- Te chama pelo nome ("E aí, {nome}, bora ver a operação?")
- Anthropic Messages API com STREAMING, usando a versão escolhida (Sonnet 5 ou Opus 4.8)
- **Tool use nativo**: o agente recebe as 16 ferramentas do moodlr-ops e decide sozinho quando chamar
- Sugestões rápidas (chips): "Resumo de hoje", "Conta FB com problema?", "Adsets com fadiga?", "Melhor hora pra escalar?"
- Markdown renderizado nas respostas; indicador de "digitando" com dots neon

### DASHBOARD VISUAL (direita)
- Cards de métrica: Receita, Gasto, Lucro, ROI consolidado (do snapshot do dia)
- Tabela de blogs ordenada por lucro (nome, receita, gasto, eCPM, lucro, ROI) com pills verde/vermelho
- Seção Alertas: saude_contas_fb + fadiga_criativo (glow vermelho pulsante se houver problema)
- Botão "↻ Atualizar" + seletor de período (hoje/ontem/7d)
- Indicador "dados de há X min" (idade do snapshot)

---

## MODELO DE DADOS — SNAPSHOT + CACHE (CRÍTICO)
O CORTEX NÃO mantém conexão viva com o moodlr-ops. Funciona por snapshot com cache:

1. **SNAPSHOT AO ABRIR**: ao entrar (ou clicar atualizar), o backend faz um lote de chamadas pontuais (resumo_usuarios do dia, saude_contas_fb, fadiga_criativo, listar_projetos), monta um objeto "snapshot" com timestamp, retorna pro frontend, que salva em localStorage. Cada chamada é request-response isolada: abre, consulta, FECHA. Sem socket vivo.

2. **AGENTE RESPONDE DO CACHE**: o snapshot é injetado no contexto do agente. Perguntas cobertas pelo snapshot (visão geral, um blog da lista, alertas) são respondidas direto dos dados salvos, SEM nova chamada. Instantâneo.

3. **CONSULTA SOB DEMANDA (realtime pontual)**: se a pergunta é granular e NÃO está no snapshot (receita_por_artigo, analise_campanhas de um id, redirects_performance, yield_por_hora, período diferente), o agente usa a tool via tool use — backend abre UMA chamada pontual, pega, fecha, responde. Opcionalmente incorpora ao snapshot.

4. **REFRESH**: botão "↻ Atualizar" e comandos como "atualiza os dados"/"puxa de novo" refazem o snapshot.

5. **IDADE DO DADO**: "dados de há X min" no topo. Se >30min, sugerir atualizar.

Resumo: consulta em lote 1x, salva, responde do cache; só reabre conexão pontual quando pede realtime ou refresh. NUNCA mantém link pendurado com o moodlr-ops.

---

## CAMADA MCP (moodlr.js — proxy stateless)
- JSON-RPC 2.0 POST ao MOODLR_MCP_URL
- Headers: "Authorization: Bearer ${moodlrToken}" (token do gestor, vem no request), "Content-Type: application/json", "Accept: application/json, text/event-stream"
- Cada chamada abre, consulta e FECHA. Timeout curto (~30s). Retry com backoff exponencial (429/500/503/529), até 4 tentativas, sempre fechando ao fim.
- **PARSING CRÍTICO**: a resposta pode vir como JSON puro OU como SSE (linhas "data: {...}"). Parsear os dois casos. E o resultado real de cada tool vem em `result.content[0].text` como STRING JSON — fazer JSON.parse desse text pra obter `{ status, data, cache }`.
- Injetar `company` automaticamente em toda tool call.
- Se o servidor exigir `initialize`, fazer no mesmo ciclo e encerrar junto (sem sessão persistente).
- Função central: `callTool(toolName, args, moodlrToken)` → abre, chama, parseia, fecha, retorna o objeto já com JSON.parse aplicado.

## AGENTE (agent.js — tool use multi-turn)
- POST /api/chat recebe {messages, managerName, moodlrToken, model, snapshot}
- Chama Anthropic Messages API passando as 16 tools no parâmetro "tools"
- Loop de tool use: enquanto stop_reason === "tool_use", executa as tools pedidas (via moodlr.js, injetando o token do gestor), devolve os tool_result, continua até resposta final
- Suporta MÚLTIPLAS tools numa mesma resposta e MÚLTIPLAS rodadas (encadear: listar_projetos → pegar id → analise_campanhas)
- Streaming da resposta final pro frontend via SSE (backend→browser; isso é SEPARADO do moodlr-ops)
- System prompt: "Você é o CORTEX, braço direito operacional da Moodlr. Fala português BR, direto e informal, estética cyberpunk. Chama o gestor de {nome}. Tem os dados do snapshot do dia já disponíveis: {snapshot}. Pra perguntas cobertas pelo snapshot, responde direto. Pra dados granulares ou período diferente, USA as ferramentas. É analítico e honesto — aponta o que tá ruim, sugere o que escalar/cortar. Interpreta ROI/eCPM/fadiga como trafficker experiente. IDs dos blogs conhecidos: {mapa id→nome}."

## AS 16 FERRAMENTAS DO MOODLR-OPS
Formato Anthropic: {name, description (PT, explicando quando usar), input_schema}. Todas recebem "company" (injetado pelo backend, não expor ao gestor). Datas em YYYY-MM-DD.

FINANCEIRO:
- resumo_financeiro(start_date, end_date) — fechamento: receita ADX, gasto FB, lucro, revshare por dia/gestor
- resumo_usuarios(start_date, end_date) — receita/gasto/lucro/ROI por projeto ao vivo (PESADO, range curto)
- roas_cross(start_date, end_date, id_blog?, country?, group_by?) — ROAS cross-channel FB×AdX
- fechamento_mensal(id_blog?) — fechamento mensal (pago/em aberto)

CAMPANHAS:
- analise_campanhas(id, start_date, end_date) — campanhas de um projeto (UTM+POSTID), base do Auto Scale
- receita_por_artigo(id, date) — receita por artigo (id_post) vs ontem
- google_ads_projeto(id, date) — campanhas Google Ads por artigo vs ontem
- redirects_performance(id, date) — performance dos short-links por slug/país/post

INTELIGÊNCIA:
- fadiga_criativo(id_blog?, country?) — adsets com fadiga (CPR FB subindo + eCPM caindo + freq alta), score + ROI líquido, 7d vs 7d
- saude_contas_fb() — alertas de saúde das contas de anúncio (checkpoint, restrição, token)
- yield_por_hora(start_date, end_date, id_blog?, pivot?, top_n?) — eCPM por hora (heatmap) + melhor hora
- sequencia_dias(id?) — streak de dias positivos/negativos (365d)

INFRA:
- listar_projetos() — lista de blogs (id, blog, domain, niche, chatbot, googleads)
- contas_facebook() — contas de anúncio (BMs): nome, act_id, status, gasto
- conteudo_writing(data?) — fila de artigos do Writing

## MAPA DE PROJETOS (referência interna — ⚠️ NUNCA injetar no agente nem no frontend)
ISOLAMENTO POR GESTOR: cada gestor só pode ver os projetos que o moodlr-ops retorna pro token DELE. O agente resolve nome→id pela lista "projetos" do snapshot (listar_projetos escopado) ou chamando listar_projetos; o dashboard monta o mapa id→nome dinamicamente do snapshot. Esta lista abaixo é só documentação da operação, não entra em código nem em prompt:
- 66 Blog Gloo | blog.glooum.com | direto
- 59 Blog GoA | blog.goappsx.com | direto
- 49 Blog Hak | blog.hakatt.com | direto
- 52 Blog Lig | blog.lignets.com | direto
- 36 Blog Manji | blog.manjirax.com | chatbot
- 32 Blog Miaw | blog.miawzy.com | chatbot (Shein/roupas grátis, carro-chefe)
- 78 Droppyg | droppyg.com | direto
- 18 Glooum | glooum.com | direto
- 19 Hakatt | hakatt.com | direto
- 20 Lignets | lignets.com | direto
- 138 Manjirax | manjirax.com | chatbot (tarot/carta de amor)
- 16 Miawzy | miawzy.com | direto
- 41 News Gloo | news.glooum.com | chatbot
- 61 SeoW | seo-w.com | chatbot (bíblia)
- 97 Zigfloo | zigfloo.com | Google Ads (finanças)
- 83 Zintado | zintado.com | direto

---

## ESTÉTICA CYBERPUNK MBZ (obrigatória — família FORGE/VAULT)
- Fontes: Orbitron (display/títulos) + Share Tech Mono (dados) via Google Fonts
- Paleta dark: fundo #04050a/#070912, painéis #0a0e1a/#0d1322, linhas #16243f/#1f3358
- Neon: cyan #00f0ff (primário), pink #ff2b9d, roxo #9d4bff, âmbar #ffcc00, verde #19e68c, vermelho #ff3b5c
- Texto: #d6e8ff (claro), #5a7299 (dim)
- Detalhes: scanlines em overlay (mix-blend-mode overlay, opacity baixa), grid de fundo com linhas, barra superior com gradiente animado correndo (keyframe scan), glow/text-shadow nos neons, cantos arredondados, hover com brilho
- Logo: MBZ::CORTEX — "MBZ" cyan glow, "::" dim, "CORTEX" pink glow. Tagline: "CENTRO DE COMANDO // MBZ MEDIA"
- Chat: bolhas do usuário em cyan sutil, agente em painel escuro; dots neon "digitando"; markdown nas respostas
- Dashboard: cards com barra de topo colorida, valores grandes em Orbitron, pills de status, alertas com glow pulsante
- Indicador de conexão: bolinha verde pulsante = moodlr-ops respondendo
- Responsivo (mobile: chat e dashboard viram abas); scrollbar fina escura; spinners neon nos loadings

---

## REGRAS DE ENGENHARIA
- Streaming real (SSE backend→browser) na resposta do agente
- localStorage por gestor: nome, key moodlr-ops, versão do agente, histórico de chat, último snapshot
- Multi-turn tool use: agente pode encadear várias ferramentas antes de responder
- Tratamento de erro em toda chamada, feedback visual (se moodlr-ops cair, avisa mas não quebra)
- resumo_usuarios é pesado: orientar o agente a usar ranges curtos e preferir o snapshot
- Segurança: ANTHROPIC_API_KEY nunca vai pro frontend; token do moodlr-ops do gestor fica no localStorage dele e vai no request, nunca logado
- README: env vars, rodar local, deploy Railway passo a passo

## ORDEM DE CONSTRUÇÃO SUGERIDA
1. [Opus + Codex EM PARALELO → Fable sintetiza] Arquitetura geral: estrutura de arquivos, contratos entre server.js / moodlr.js / agent.js, e o desenho do proxy MCP stateless (parsing SSE/JSON, parse do content[0].text, retry, abre-consulta-fecha). Testar com listar_projetos.
2. [Opus + Codex EM PARALELO → Fable sintetiza] agent.js: loop de tool use multi-turn + streaming SSE backend→browser.
3. [Opus + Codex EM PARALELO → Fable sintetiza] Modelo snapshot + cache: o que entra no lote inicial, como injetar no contexto do agente, refresh e idade do dado.
4. [fast-worker] Frontend: layout split, CSS cyberpunk, onboarding, localStorage.
5. [fast-worker] Dashboard: cards, tabela de blogs, alertas, a partir do snapshot.
6. [fast-worker] Polish: responsivo, spinners, idade do dado, README + arquivos de deploy.
7. [Opus + Codex EM PARALELO → Fable sintetiza] Revisão final da integração: garantir que snapshot→agente→tool use→cache funcionam juntos sem furos.
