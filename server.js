// server.js — MBZ::CORTEX backend. Express + rotas + static + dotenv.
//
// Contrato de API (CONGELADO — o frontend é construído contra isto):
//   GET  /api/health   -> 200 {"ok":true}
//   POST /api/validate -> {moodlrToken} -> 200 {ok,toolCount} | 401 | 502
//   POST /api/snapshot -> {moodlrToken, period} -> 200 {ok,snapshot} | 502
//   POST /api/chat     -> {messages,managerName,moodlrToken,model,snapshot} -> SSE
//
// Segurança: ANTHROPIC_API_KEY fica só no servidor (nunca vai ao frontend nem a
// logs). O token do moodlr-ops do gestor vem em cada request e NUNCA é logado.
//
// Layout de deploy: este arquivo (e moodlr.js/tools.js/agent.js) roda na RAIZ do
// repo, ao lado da pasta public/ (frontend estático). Ver DESIGN.md.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTools, callTool, McpAuthError } from './moodlr.js';
import { runAgentStream } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const VALID_MODELS = new Set(['claude-sonnet-5', 'claude-opus-4-8']);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// ───────────────────────────── datas (America/Sao_Paulo) ─────────────────
function todaySaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // YYYY-MM-DD
}

function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // meio-dia UTC evita bordas de DST
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function periodToDates(period) {
  const today = todaySaoPaulo();
  if (period === 'ontem') {
    const y = addDays(today, -1);
    return { label: 'ontem', start_date: y, end_date: y };
  }
  if (period === '7d') {
    return { label: '7d', start_date: addDays(today, -6), end_date: today };
  }
  return { label: 'hoje', start_date: today, end_date: today };
}

// ─────────────────────────────── rotas ───────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Valida a chave do gestor com um tools/list de teste no moodlr-ops.
app.post('/api/validate', async (req, res) => {
  const token = req.body?.moodlrToken;
  try {
    const tools = await listTools(token);
    res.status(200).json({ ok: true, toolCount: Array.isArray(tools) ? tools.length : 0 });
  } catch (err) {
    if (err instanceof McpAuthError) {
      res.status(401).json({ ok: false, error: 'Chave do moodlr-ops inválida.' });
    } else {
      res.status(502).json({ ok: false, error: 'moodlr-ops inacessível no momento.' });
    }
  }
});

// Monta o snapshot do dia: 4 chamadas em PARALELO (Promise.allSettled). Falha
// parcial não derruba o snapshot (campo null + entrada em errors). 502 só se as 4 falharem.
app.post('/api/snapshot', async (req, res) => {
  const token = req.body?.moodlrToken;
  if (!token) {
    return res.status(400).json({ ok: false, error: 'moodlrToken ausente.' });
  }

  const rawPeriod = req.body?.period;
  const period = ['hoje', 'ontem', '7d'].includes(rawPeriod) ? rawPeriod : 'hoje';
  const { label, start_date, end_date } = periodToDates(period);

  // [ chave no snapshot, nome da tool, função ]
  const tasks = [
    ['resumoUsuarios', 'resumo_usuarios', () => callTool('resumo_usuarios', { start_date, end_date }, token)],
    ['saudeContasFb', 'saude_contas_fb', () => callTool('saude_contas_fb', {}, token)],
    ['fadigaCriativo', 'fadiga_criativo', () => callTool('fadiga_criativo', {}, token)],
    ['projetos', 'listar_projetos', () => callTool('listar_projetos', {}, token)],
  ];

  const settled = await Promise.allSettled(tasks.map(([, , fn]) => fn()));

  const snapshot = {
    timestamp: Date.now(),
    period: { label, start_date, end_date },
    resumoUsuarios: null,
    saudeContasFb: null,
    fadigaCriativo: null,
    projetos: null,
    errors: [],
  };

  settled.forEach((r, i) => {
    const [key, toolName] = tasks[i];
    if (r.status === 'fulfilled') {
      snapshot[key] = r.value;
    } else {
      snapshot.errors.push({ tool: toolName, error: r.reason?.message || 'falha' });
    }
  });

  const allFailed = settled.every((r) => r.status === 'rejected');
  if (allFailed) {
    return res.status(502).json({
      ok: false,
      error: settled[0]?.reason?.message || 'moodlr-ops indisponível para montar o snapshot.',
    });
  }

  res.status(200).json({ ok: true, snapshot });
});

// Chat com o agente. Resposta em SSE (delta/tool/done/error).
app.post('/api/chat', async (req, res) => {
  const { messages, managerName, moodlrToken, model, snapshot } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages inválido.' });
  }
  if (!moodlrToken) {
    return res.status(400).json({ ok: false, error: 'moodlrToken ausente.' });
  }
  const chosenModel = model || 'claude-sonnet-5';
  if (!VALID_MODELS.has(chosenModel)) {
    return res.status(400).json({ ok: false, error: 'model inválido.' });
  }

  // Cabeçalhos SSE (flush por evento; sem buffering em proxies).
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': ok\n\n'); // comentário SSE inicial → abre o stream / força flush

  // Cliente fechou a aba/conexão no meio do stream: aborta o loop do agente
  // (para de gastar Anthropic + moodlr-ops num socket morto).
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    await runAgentStream({
      res,
      messages,
      managerName,
      moodlrToken,
      model: chosenModel,
      snapshot,
      signal: abort.signal,
    });
  } catch (err) {
    // runAgentStream já trata seus próprios erros; este catch é só rede de segurança.
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Falha inesperada no CORTEX.' })}\n\n`);
      res.end();
    }
  }
});

// Fallback SPA: qualquer rota não-API serve o index do frontend.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

// ─────────────────────────── boot / guard-rails ──────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[cortex] AVISO: ANTHROPIC_API_KEY não definida — /api/chat vai falhar até configurar.');
}

// Não derruba o processo em rejeições não tratadas (sem vazar tokens/keys).
process.on('unhandledRejection', (reason) => {
  console.error('[cortex] unhandledRejection:', reason?.message || reason);
});

app.listen(PORT, () => {
  console.log(`[cortex] online na porta ${PORT} — MBZ::CORTEX // MBZ MEDIA`);
});

export default app;
