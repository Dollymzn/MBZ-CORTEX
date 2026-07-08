
# MBZ::CORTEX

**CENTRO DE COMANDO // MBZ MEDIA**

Centro de comando da operação de tráfego/arbitragem da **Moodlr LLC**. Combina um agente de IA conversacional (Claude, com tool use multi-turn contra DOIS servidores MCP: `moodlr-ops`, o lado da COMPRA — campanhas, ROI, fadiga — e `ruler-mcp`, o lado da VENDA — price floors AdX/ActiveView) com um dashboard visual, num modelo de **snapshot + cache**: consulta os dados em lote uma vez, salva, responde do cache — e só reabre uma conexão pontual quando o gestor pede algo granular ou manda atualizar. Estética cyberpunk neon MBZ.

---

## // ARQUITETURA

- **Split chat + dashboard**: à esquerda o agente conversacional, à direita os cards/tabelas/alertas da operação — tudo servido como frontend estático em `public/` (vanilla JS/HTML/CSS, sem build).
- **Snapshot + cache**: ao abrir (ou clicar "atualizar"), o backend dispara em paralelo `resumo_usuarios`, `saude_contas_fb`, `fadiga_criativo` e `listar_projetos`, monta um snapshot com timestamp e devolve pro frontend, que guarda em `localStorage`. Perguntas cobertas pelo snapshot são respondidas na hora, sem nova chamada.
- **Proxy MCP stateless** (`mcp-core.js` + wrappers `moodlr.js`/`ruler.js`): cada chamada aos MCPs abre, consulta e fecha — sem socket vivo, sem sessão persistente entre requests. O núcleo (parsing SSE/JSON, retry, sanitização de credenciais) é compartilhado pelos dois.
- **Price floors com trava de segurança**: `aplicar_floor` mexe em receita real — o backend **rejeita** `confirm=true` sem um preview recente do mesmo gestor+network+domínio (guarda server-side, à prova de prompt injection; um preview autoriza UMA aplicação).
- **Streaming SSE**: `/api/chat` transmite a resposta do agente em tempo real (backend → browser) via Server-Sent Events, incluindo os eventos das rodadas de tool use.
- **Multi-gestor via localStorage**: cada gestor guarda no próprio navegador seu nome, a key do `moodlr-ops`, a versão do agente escolhida e o histórico de chat — tudo isolado por dispositivo/gestor.

---

## // VARIÁVEIS DE AMBIENTE

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sim | — | Key da Anthropic. Fica **só no servidor**; os gestores não precisam de conta Anthropic própria. |
| `MOODLR_MCP_URL` | Não | `https://api.core.moodlr.digital/api/mcp` | Endpoint do servidor MCP `moodlr-ops`. |
| `MOODLR_COMPANY` | Não | *(vazio)* | Valor do parâmetro `company` injetado em toda tool call. Deixe vazio se o token do gestor já define o escopo. |
| `RULER_MCP_URL` | Não | `https://ruler-mcp-mcping.up.railway.app/api/mcp` | Endpoint do servidor MCP `ruler-mcp` (price floors). Atenção: o path é `/api/mcp`. |
| `PORT` | Não | `3000` | Porta local do servidor Express (Railway injeta a sua automaticamente). |

---

## // RODAR LOCAL

```bash
cp .env.example .env
# edite .env e preencha ANTHROPIC_API_KEY

npm install
npm start
```

Acesse `http://localhost:3000`. No primeiro acesso, o onboarding pede **nome**, **key do moodlr-ops** e **versão do agente** (Claude Sonnet 5 ou Claude Opus 4.8) — e, opcionalmente, a **key do ruler-mcp** + a **key da ActiveView (av_bearer)** para habilitar o módulo de price floors. Tudo salvo em `localStorage` do navegador; sem as keys do ruler, as ferramentas de floor ficam desabilitadas para aquele gestor.

---

## // DEPLOY (RAILWAY)

1. Crie um projeto no Railway e conecte este repositório no GitHub (ou use `railway up` via CLI, direto da raiz do repo).
2. Em **Variables**, defina `ANTHROPIC_API_KEY` (obrigatória) e, se necessário, `MOODLR_COMPANY`.
3. O Railway detecta o build via **NIXPACKS** (`railway.json`) e sobe com `npm start` (`Procfile`), usando a porta injetada automaticamente em `PORT`.
4. Deploy automático a cada push; o Railway gera o domínio público.

> Cada gestor entra com a própria key do `moodlr-ops` direto no navegador (fica em `localStorage`, nunca no servidor). A `ANTHROPIC_API_KEY` é única e fica só nas Variables do Railway.

---

## // ENDPOINTS DA API

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/api/health` | Health check simples (`{"ok":true}`). |
| `POST` | `/api/validate` | Valida a key do `moodlr-ops` do gestor com um `tools/list` de teste. |
| `POST` | `/api/validate-ruler` | Valida a key do `ruler-mcp` do gestor com um `tools/list` de teste. |
| `POST` | `/api/snapshot` | Monta o snapshot do dia (4 chamadas em paralelo ao `moodlr-ops`) para o período pedido (hoje/ontem/7d). O ruler não entra no snapshot — floors são sob demanda. |
| `POST` | `/api/chat` | Chat com o agente — streaming via **SSE**, com tool use multi-turn sobre as 15 ferramentas do `moodlr-ops` + 5 do `ruler-mcp` (estas só quando o gestor configurou as keys). |

---

## // SEGURANÇA

- `ANTHROPIC_API_KEY` nunca é enviada ao frontend nem aparece em log algum — vive só no ambiente do servidor.
- Os tokens de cada gestor (`moodlr-ops`, `ruler-mcp` e o `av_bearer` da ActiveView) ficam no `localStorage` do próprio navegador, viajam em cada request ao backend e **nunca são logados**. O `av_bearer` é injetado pelo backend nos args das tools do ruler e nunca aparece nos schemas expostos ao modelo.
- Todo payload vindo dos MCPs passa por um **sanitizador em profundidade** que remove senhas, api keys, tokens e PII antes de chegar ao navegador ou ao contexto do modelo.
- `aplicar_floor` com `confirm=true` só executa após um preview recente registrado server-side para o mesmo gestor+network+domínio — o modelo (ou uma prompt injection) não tem como pular a etapa de aprovação.
