import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { loadAgents, getConfigPath } from './openclawConfig.js';
import {
  approveCard,
  assignCard,
  createCard,
  createDelegation,
  getCard,
  listCards,
  listCardTimeline,
  moveCard,
  upsertAgents
} from './store.js';
import { Stage } from './types.js';
import { runMigrations } from './db.js';
import { OpenClawGateway } from './openclawGateway.js';
import { startPolicyWorker } from './policyWorker.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const openclawGateway = new OpenClawGateway();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let agents = loadAgents();
const configPath = getConfigPath();
let lastMtime = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;

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

function getSpecialists() {
  return agents.filter((a) => !a.isOrchestrator);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: getSpecialists() });
});

app.get('/api/cards', async (_req, res) => {
  res.json({ cards: await listCards() });
});

app.get(['/api/cards/:id/timeline', '/cards/:id/timeline'], async (req, res) => {
  const card = await getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });
  res.json({ cardId: req.params.id, events: await listCardTimeline(req.params.id) });
});

app.post('/api/cards', async (req, res) => {
  const { title, description, dueAt } = req.body ?? {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const card = await createCard({ title, description, dueAt });
  io.emit('card.created', card);
  res.status(201).json(card);
});

app.post('/api/cards/:id/assign', async (req, res) => {
  const { agentId } = req.body ?? {};
  const invalid = !agentId || !getSpecialists().find((a) => a.agentId === agentId);
  if (invalid) return res.status(400).json({ error: 'invalid specialist agentId' });

  const card = await assignCard(req.params.id, agentId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  io.emit('card.assigned', card);
  res.json(card);
});

app.post('/api/cards/:id/delegate', async (req, res) => {
  const { agentId, taskDescription } = req.body ?? {};
  const invalid = !agentId || !getSpecialists().find((a) => a.agentId === agentId);
  if (invalid) return res.status(400).json({ error: 'invalid specialist agentId' });

  const card = await getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });

  const delegation = await createDelegation({ cardId: req.params.id, agentId, taskDescription });
  io.emit('card.delegated', { cardId: req.params.id, delegation });
  res.status(201).json({ delegation });
});

app.post('/api/delegations/:sessionKey/resume', async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  await openclawGateway.sendResume(req.params.sessionKey, message);
  res.json({ ok: true });
});

app.post('/api/cards/:id/move', async (req, res) => {
  const { stage } = req.body as { stage?: Stage };
  const allowed: Stage[] = ['backlog', 'in_progress', 'review', 'blocked', 'done'];
  if (!stage || !allowed.includes(stage)) return res.status(400).json({ error: 'invalid stage' });

  const card = await moveCard(req.params.id, stage);
  if (!card) return res.status(404).json({ error: 'card not found' });
  io.emit('card.moved', card);
  res.json(card);
});

app.post('/api/cards/:id/approve', async (req, res) => {
  const card = await approveCard(req.params.id);
  if (!card) return res.status(400).json({ error: 'card must be in review and exist' });
  io.emit('card.approved', card);
  res.json(card);
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
