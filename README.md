# OpenClaw Kanban (Initial Scaffold)

Runnable Phase-2 baseline:
- Node.js + TypeScript + Express
- Socket.io realtime updates
- OpenClaw config agent discovery (`~/.openclaw/openclaw.json`)
- Supports both strict JSON and JSON5-style OpenClaw config formatting
- Specialist-only assignment dropdown (hides `main` / `orchestrator`)
- Postgres-backed cards + event timeline persistence
- Core card workflow: create, assign, move, approve
- Timeline endpoint and normalized event keys for auditability
- Background policy worker for stale review / overdue auto-blocking
- OpenClaw websocket gateway bootstrap (protocol-v3 handshake + reconnect)

## Run

```bash
docker compose up -d
npm install
npm run dev
```

Open: http://localhost:3000

## APIs
- `GET /api/agents`
- `GET /api/cards`
- `POST /api/cards`
- `POST /api/cards/:id/assign`
- `POST /api/cards/:id/delegate`
- `POST /api/cards/:id/move`
- `POST /api/cards/:id/approve`
- `GET /api/cards/:id/timeline`
- `POST /api/delegations/:sessionKey/resume`

## Database

On boot, the API runs SQL migrations from `migrations/*.sql` against:
- `DATABASE_URL` (if provided), otherwise
- `postgresql://claw:claw@127.0.0.1:5432/clawtrello`

Current schema includes:
- `cards`
- `agents`
- `card_delegations`
- `card_events`
- `schema_migrations`


## OpenClaw gateway env vars

- `OPENCLAW_WS_URL`: gateway websocket endpoint.
- `OPENCLAW_TOKEN`: token used for `connect` auth.
- `OPENCLAW_WS_ORIGIN` (optional): explicit `Origin` header for the websocket handshake.
- `OPENCLAW_WS_SUBPROTOCOL` (optional): websocket subprotocol value.
- `OPENCLAW_WS_HEADERS_JSON` (optional): JSON object string with extra handshake headers.
