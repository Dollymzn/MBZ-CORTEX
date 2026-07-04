# MBZ::CORTEX

**CENTRO DE COMANDO // MBZ MEDIA**

Centro de comando da operação de tráfego/arbitragem da **Moodlr LLC**. Combina um agente de IA conversacional (Claude, com tool use multi-turn contra o servidor MCP `moodlr-ops`) com um dashboard visual, num modelo de **snapshot + cache**: consulta os dados em lote uma vez, salva, responde do cache — e só reabre uma conexão pontual quando o gestor pede algo granular ou manda atualizar. Estética cyberpunk neon MBZ.

---

## // ARQUITETURA

- **Split chat + dashboard**: à esquerda o agente conversacional, à direita os cards/tabelas/alertas da operação — tudo servido como frontend estático em `public/` (vanilla JS/HTML/CSS, sem build).
- **Snapshot + cache**: ao abrir (ou clicar "atualizar"), o backend dispara em paralelo `resumo_usuarios`, `saude_contas_fb`, `fadiga_criativo` e `listar_projetos`, monta um snapshot com timestamp e devolve pro frontend, que guarda em `localStorage`. Perguntas cobertas pelo snapshot são respondidas na hora, sem nova chamada.
- **Proxy MCP stateless** (`moodlr.js`): cada chamada ao `moodlr-ops` abre, consulta e fecha — sem socket vivo, sem sessão persistente entre requests.
- **Streaming SSE**: `/api/chat` transmite a resposta do agente em tempo real (backend → browser) via Server-Sent Events, incluindo os eventos das rodadas de tool use.
- **Multi-gestor via localStorage**: cada gestor guarda no próprio navegador seu nome, a key do `moodlr-ops`, a versão do agente escolhida e o histórico de chat — tudo isolado por dispositivo/gestor.

---

## // VARIÁVEIS DE AMBIENTE

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sim | — | Key da Anthropic. Fica **só no servidor**; os gestores não precisam de conta Anthropic própria. |
| `MOODLR_MCP_URL` | Não | `https://api.core.moodlr.digital/api/mcp` | Endpoint do servidor MCP `moodlr-ops`. |
| `MOODLR_COMPANY` | Não | *(vazio)* | Valor do parâmetro `company` injetado em toda tool call. Deixe vazio se o token do gestor já define o escopo. |
| `PORT` | Não | `3000` | Porta local do servidor Express (Railway injeta a sua automaticamente). |

---

## // RODAR LOCAL

```bash
cp .env.example .env
# edite .env e preencha ANTHROPIC_API_KEY

npm install
npm start
```

Acesse `http://localhost:3000`. No primeiro acesso, o onboarding pede **nome**, **key do moodlr-ops** e **versão do agente** (Claude Sonnet 5 ou Claude Opus 4.8) — tudo salvo em `localStorage` do navegador.

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
| `POST` | `/api/snapshot` | Monta o snapshot do dia (4 chamadas em paralelo ao `moodlr-ops`) para o período pedido (hoje/ontem/7d). |
| `POST` | `/api/chat` | Chat com o agente — streaming via **SSE**, com tool use multi-turn sobre as 15 ferramentas do `moodlr-ops`. |

---

## // SEGURANÇA

- `ANTHROPIC_API_KEY` nunca é enviada ao frontend nem aparece em log algum — vive só no ambiente do servidor.
- O token do `moodlr-ops` de cada gestor fica no `localStorage` do próprio navegador, viaja em cada request ao backend e **nunca é logado**.
