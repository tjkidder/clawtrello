import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { loadAgents, getConfigPath } from './openclawConfig.js';
import { approveCard, assignCard, createCard, listCards, moveCard } from './store.js';
import { Stage } from './types.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let agents = loadAgents();
const configPath = getConfigPath();
let lastMtime = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;

setInterval(() => {
  if (!fs.existsSync(configPath)) return;
  const mtime = fs.statSync(configPath).mtimeMs;
  if (mtime !== lastMtime) {
    lastMtime = mtime;
    agents = loadAgents();
    io.emit('agents.updated', getSpecialists());
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

app.get('/api/cards', (_req, res) => {
  res.json({ cards: listCards() });
});

app.post('/api/cards', (req, res) => {
  const { title, description, dueAt } = req.body ?? {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const card = createCard({ title, description, dueAt });
  io.emit('card.created', card);
  res.status(201).json(card);
});

app.post('/api/cards/:id/assign', (req, res) => {
  const { agentId } = req.body ?? {};
  const invalid = !agentId || !getSpecialists().find((a) => a.agentId === agentId);
  if (invalid) return res.status(400).json({ error: 'invalid specialist agentId' });

  const card = assignCard(req.params.id, agentId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  io.emit('card.assigned', card);
  res.json(card);
});

app.post('/api/cards/:id/move', (req, res) => {
  const { stage } = req.body as { stage?: Stage };
  const allowed: Stage[] = ['backlog', 'in_progress', 'review', 'blocked', 'done'];
  if (!stage || !allowed.includes(stage)) return res.status(400).json({ error: 'invalid stage' });

  const card = moveCard(req.params.id, stage);
  if (!card) return res.status(404).json({ error: 'card not found' });
  io.emit('card.moved', card);
  res.json(card);
});

app.post('/api/cards/:id/approve', (req, res) => {
  const card = approveCard(req.params.id);
  if (!card) return res.status(400).json({ error: 'card must be in review and exist' });
  io.emit('card.approved', card);
  res.json(card);
});

io.on('connection', (socket) => {
  socket.emit('init', { cards: listCards(), agents: getSpecialists() });
});

const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => {
  console.log(`kanban server running on http://localhost:${PORT}`);
});
