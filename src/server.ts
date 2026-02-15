import fs from 'node:fs';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { getConfigPath, loadAgents, loadGatewayRuntimeConfig } from './openclawConfig.js';
import {
  approveCard,
  assignCard,
  createCard,
  createDelegation,
  getCard,
  listCards,
  listCardTimeline,
  listCardEvents,
  findLatestDelegationForCard,
  upsertAgents,
  appendEvent,
  moveCard
} from './store.js';
import { Stage } from './types.js';
import { runMigrations } from './db.js';
import { OpenClawGateway } from './openclawGateway.js';
import { startPolicyWorker } from './policyWorker.js';


process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException', err);
});

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let agents = loadAgents();
const configPath = getConfigPath();
let lastMtime = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;

function getSpecialists() {
  return agents.filter((a) => !a.isOrchestrator);
}


function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
}

const runtimeConfig = loadGatewayRuntimeConfig();

function stringifyErr(err: any): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err?.error?.message) return err.error.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const openclawGateway = new OpenClawGateway({
  endpoint: runtimeConfig.endpoint,
  token: runtimeConfig.token,
  onCardChanged: async (cardId) => {
    const card = await getCard(cardId);
    if (card) io.emit('card.moved', card);
  }
});

setInterval(async () => {
  if (!fs.existsSync(configPath)) return;
  const mtime = fs.statSync(configPath).mtimeMs;
  if (mtime !== lastMtime) {
    lastMtime = mtime;
    const previous = new Set(agents.map((a) => a.agentId));
    agents = loadAgents();
    await upsertAgents(agents);
    const next = new Set(agents.map((a) => a.agentId));
    const changed = previous.size !== next.size || [...next].some((id) => !previous.has(id));
    if (changed) {
      io.emit('agents.updated', getSpecialists());
    }
  }
}, 5000);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: getSpecialists() });
});

app.get('/api/openclaw/status', (_req, res) => {
  res.json(openclawGateway.getStatus());
});

app.get('/api/openclaw/health', (_req, res) => {
  res.json({
    ok: true,
    gateway: openclawGateway.getStatus ? openclawGateway.getStatus() : undefined
  });
});

app.post('/api/agents/refresh', asyncHandler(async (_req, res) => {
  agents = loadAgents();
  await upsertAgents(agents);
  io.emit('agents.updated', getSpecialists());
  res.json({ agents: getSpecialists() });
}));

app.get('/api/cards', asyncHandler(async (_req, res) => {
  res.json({ cards: await listCards() });
}));

app.get(['/api/cards/:id/timeline', '/cards/:id/timeline'], asyncHandler(async (req, res) => {
  const cardId = routeParam(req.params.id);
  const card = await getCard(cardId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  res.json({ cardId, events: await listCardTimeline(cardId) });
}));

app.post('/api/cards', asyncHandler(async (req, res) => {
  const { title, description, dueAt } = req.body ?? {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const card = await createCard({ title, description, dueAt });
  io.emit('card.created', card);
  res.status(201).json(card);
}));

app.post('/api/cards/:id/assign', asyncHandler(async (req, res) => {
  const { agentId } = req.body ?? {};
  const invalid = !agentId || !getSpecialists().find((a) => a.agentId === agentId);
  if (invalid) return res.status(400).json({ error: 'invalid specialist agentId' });

  const cardId = routeParam(req.params.id);
  const card = await assignCard(cardId, agentId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  io.emit('card.assigned', card);
  res.json(card);
}));

app.post('/api/cards/:id/delegate', asyncHandler(async (req, res) => {
  const { agentId, taskDescription } = req.body ?? {};
  const invalid = !agentId || !getSpecialists().find((a) => a.agentId === agentId);
  if (invalid) return res.status(400).json({ error: 'invalid specialist agentId' });

  const cardId = routeParam(req.params.id);
  const card = await getCard(cardId);
  if (!card) return res.status(404).json({ error: 'card not found' });

  const delegation = await createDelegation({ cardId, agentId, taskDescription });
  await appendEvent({
    cardId,
    eventType: 'delegation.created',
    eventKey: 'card.delegated',
    source: 'app',
    actorAgentId: agentId,
    payload: { delegation }
  });

  let spawnResult:
    | {
        ok: boolean;
        reason?: string;
        methodUsed?: string;
        sessionKey?: string;
        runId?: string;
        sessionId?: string;
        sessionKeyFormat?: string;
      }
    | undefined;
  try {
    spawnResult = await openclawGateway.spawnDelegation({
      delegationId: delegation.id,
      cardId,
      agentId,
      taskDescription
    });
  } catch (error) {
    console.error('[delegate] agent start failed:', error);
    spawnResult = { ok: false, reason: stringifyErr(error) };
    await appendEvent({
      cardId,
      eventType: 'delegation.spawn_failed',
      eventKey: 'card.blocked',
      source: 'openclaw',
      actorAgentId: agentId,
      payload: { error: stringifyErr(error) }
    });
  }

  io.emit('card.delegated', { cardId, delegation });
  res.status(201).json({ delegation, spawn: spawnResult ?? { ok: false, reason: 'unknown' } });
}));

app.post('/api/delegations/:id/resume', asyncHandler(async (req, res) => {
  const delegationId = Number(req.params.id);
  const message = req.body?.message ?? '';
  if (!Number.isFinite(delegationId)) return res.status(400).json({ ok: false, error: 'invalid delegation id' });
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });

  try {
    const result = await openclawGateway.resumeDelegation(delegationId, message);
    res.json({ ok: true, result });
  } catch (error: any) {
    const msg = stringifyErr(error);
    if (error?.code === 'UNSUPPORTED' || msg.includes('not supported')) {
      return res.status(501).json({ ok: false, error: msg });
    }
    throw error;
  }
}));

app.get('/api/cards/:id/transcript', asyncHandler(async (req, res) => {
  const cardId = routeParam(req.params.id);
  const events = await listCardEvents(cardId);
  const delegation = await findLatestDelegationForCard(cardId);

  let transcript: any[] = [];
  if (delegation?.sessionKey) {
    transcript = await openclawGateway.getTranscript(delegation.sessionKey).catch(() => []);
  }

  res.json({ ok: true, cardId, events, transcript });
}));

app.post('/api/cards/:id/move', asyncHandler(async (req, res) => {
  const { stage } = req.body as { stage?: Stage };
  const allowed: Stage[] = ['backlog', 'in_progress', 'review', 'blocked', 'done'];
  if (!stage || !allowed.includes(stage)) return res.status(400).json({ error: 'invalid stage' });

  const cardId = routeParam(req.params.id);
  const card = await moveCard(cardId, stage);
  if (!card) return res.status(404).json({ error: 'card not found' });
  io.emit('card.moved', card);
  res.json(card);
}));

app.post('/api/cards/:id/approve', asyncHandler(async (req, res) => {
  const cardId = routeParam(req.params.id);
  const card = await approveCard(cardId);
  if (!card) return res.status(400).json({ error: 'card must be in review and exist' });
  io.emit('card.approved', card);
  res.json(card);
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err: any, req: any, res: any, _next: any) => {
  console.error('[error]', err);
  const msg = String(err?.message ?? err);
  if (req.path.startsWith('/api/')) {
    res.status(500).json({ ok: false, error: msg });
    return;
  }
  res.status(500).send(msg);
});

io.on('connection', async (socket) => {
  socket.emit('init', { cards: await listCards(), agents: getSpecialists() });
});

const PORT = Number(process.env.PORT || 3000);

async function bootstrap() {
  await runMigrations();
  await upsertAgents(agents);
  openclawGateway.start();
  startPolicyWorker();
  httpServer.listen(PORT, () => {
    console.log(`kanban server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('failed to bootstrap server', error);
  process.exit(1);
});
