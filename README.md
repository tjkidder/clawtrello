# OpenClaw Kanban (Initial Scaffold)

Initial runnable implementation:
- Node.js + TypeScript + Express
- Socket.io realtime updates
- OpenClaw config agent discovery (`.openclaw/openclaw.json` in repo, or `~/.openclaw/openclaw.json`)
- Supports both strict JSON and JSON5-style OpenClaw config formatting
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

## OpenClaw config path resolution

The server loads OpenClaw config in this order:
1. `OPENCLAW_CONFIG_PATH` (if set)
2. `<repo>/.openclaw/openclaw.json`
3. `~/.openclaw/openclaw.json`

This makes local project testing and CI easier without modifying your global home config.

## Troubleshooting

- If you see `zsh: command not found: docker`, install Docker Desktop first; Docker is optional for this in-memory stage.
- If your OpenClaw config contains comments or trailing commas, JSON5 parsing is supported.
