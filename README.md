# OpenClaw Kanban (Initial Scaffold)

Initial runnable implementation:
- Node.js + TypeScript + Express
- Socket.io realtime updates
- OpenClaw config agent discovery (`~/.openclaw/openclaw.json`)
- Specialist-only assignment dropdown (hides `main` / `orchestrator`)
- Core card workflow: create, assign, move, approve

## Run

```bash
npm install
npm run dev
```

Open: http://localhost:3000

## APIs
- `GET /api/agents`
- `GET /api/cards`
- `POST /api/cards`
- `POST /api/cards/:id/assign`
- `POST /api/cards/:id/move`
- `POST /api/cards/:id/approve`

## Infra (next)

```bash
docker compose up -d
```

Brings up Postgres + Redis for upcoming persistence/queue steps.
