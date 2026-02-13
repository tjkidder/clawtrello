# OpenClaw Kanban Orchestrator — Implementation Plan (Execution-Ready)

## 0) Status
This plan is now aligned to your provided OpenClaw integration contract, Discord channel configuration, and UI target design.

---

## 1) Core Product Behavior

### 1.1 Lifecycle
`backlog -> in_progress -> review -> done` (+ `blocked`)

### 1.2 Roles
- **Human Orchestrator (you):** final approval authority, reassignment, comments.
- **Main Agent (`main` / Cortana):** delegates to specialist agents and follows through.
- **Specialist Agents:** `deep-researcher` (Ultron), `researcher` (JARVIS), `notion-expert` (Skynet), and future agents discovered dynamically.

### 1.3 Assignment modes
1. Manual assignment from dynamic agent dropdown (specialist agents only; orchestrator hidden).
2. Main-agent delegation.
3. Auto-routing by labels/skills.

### 1.4 Approval governance
- Agents can move to `review`.
- Only human can complete `review -> done`.
- Reject returns to `in_progress` with structured feedback.

### 1.5 Due-date and SLA behavior
- Cards support `due_at`.
- Alerts:
  - **Stale review (R):** 60 min in `review`
  - **Due soon (D):** 24h before `due_at`
  - **No progress (X):** 30 min inactivity in `in_progress` => blocked
  - **Overdue:** immediate overdue alert when `now > due_at`

---

## 2) OpenClaw Integration Contract (Locked)

## 2.1 Config source of truth
- Primary config path: `~/.openclaw/openclaw.json`
- Parse at startup and validate:
  - `gateway.port`, `gateway.auth.token`
  - `agents.list`
  - `channels.discord.enabled`
  - `channels.discord.groupPolicy`
  - `channels.discord.guilds[*].channels[*].allow`
  - `channels.discord.guilds[*].channels[*].requireMention`

### 2.2 Gateway connection
- WebSocket base URL: `ws://127.0.0.1:18789` (default)
- Protocol: version `3`
- Handshake flow:
  1. connect socket
  2. receive `connect.challenge`
  3. send `connect` request with auth token
  4. receive `hello-ok`

### 2.3 Methods to implement
- `sessions_spawn` (delegate work; non-blocking)
- `sessions_list` (status polling fallback)
- `sessions_history` (timeline/transcript)
- `sessions_send` (guidance/resume/progress prompts)
- `agents_list` if exposed; otherwise use config-file discovery

### 2.4 Required run/session identifiers
On spawn, persist:
- `runId`
- `childSessionKey`
- `sessionId`

### 2.5 Events to ingest and normalize
- `session.created`
- `session.updated`
- `session.completed`
- `session.error`
- `session.announce`
- `exec.approval.requested`

### 2.6 Human-help resume
- `exec.approval.requested` moves card to `blocked` or `review` (policy-driven).
- Resume with `sessions_send` against same `sessionKey` / `runId`.

---

## 3) Discord Integration Contract (Locked)

### 3.1 Commands
Primary: slash-style `/kb` command set
- `/kb create <title> [due:YYYY-MM-DD] [agent:<agentId>]`
- `/kb assign <cardId> <agentRole|agentId>`
- `/kb move <cardId> <backlog|in_progress|review|blocked|done>`
- `/kb approve <cardId>`
- `/kb reject <cardId> <reason>`
- `/kb status <cardId>`
- `/kb list [stage:<stage>] [agent:<agent>] [overdue:true]`
- `/kb help`

Fallback: `!kb` text commands.

### 3.2 Channel policy and routing
Use `allowlist` and `requireMention=true` behavior exactly from config.

Guild: `1471182637983993971`
- `1471182638529122533` -> main/general + primary notifications
- `1471223892239454425` -> deep-researcher channel
- `1471223939186298880` -> researcher channel
- `1471223963983286426` -> notion-expert channel

### 3.3 Notifications (required)
Send notifications for:
1. Ready for review
2. Needs approval
3. Completed
4. Blocked / needs help
5. Due soon
6. Overdue
7. Stale review

Include card id/title, assignee, stage, due status, deep link.

### 3.4 Routing policy (final)
- **General channel first** (`1471182638529122533`) is the single monitoring surface for human oversight.
- Send to General:
  - overdue/stale review/blocked system alerts
  - ready-for-review
  - approval-needed
  - completion announcements
- Send to agent channels:
  - assignment pings
  - agent-specific follow-up questions and responses


---

## 4) Dynamic Agent Discovery (Locked)

### 4.1 Watch strategy
- Watch `~/.openclaw/openclaw.json` with polling (5s default).
- Detect change by mtime + file size.
- Parse `agents.list` and diff by `agentId`.

### 4.2 Change actions
On add/remove/update:
- Upsert `agents` cache table
- Broadcast websocket `agents.updated` to UI
- Optionally post Discord “new agent available” notification

### 4.3 API endpoints
- `GET /api/agents`
- `POST /api/agents/refresh`
- `GET /api/agents/:agentId`

---

## 5) System Architecture (Local-First)

Services:
1. `kanban-web` (Next.js + Tailwind + dnd-kit)
2. `kanban-api` (Node.js + TypeScript + Express)
3. `kanban-worker` (policy checks + reminders)
4. `openclaw-gateway-client` (ws integration module)
5. `discord-bridge`
6. `postgres`
7. `redis`

Realtime:
- Socket.io for board changes, card logs, presence, agent updates (with fallback transport support).

---

## 6) Data Model (MVP)

### 6.1 Core tables
- `projects`, `boards`, `pipelines`, `pipeline_stages`
- `cards`, `card_assignments`, `comments`, `attachments`
- `agents` (cached from config/discovery)
- `card_delegations`
- `card_events` (append-only)
- `notification_rules`, `notification_deliveries`

### 6.2 `card_delegations` (required fields)
- `card_id`
- `agent_id`, `agent_name`
- `run_id`, `session_key`, `session_id`
- `status` (`pending|active|in_progress|review|blocked|completed|error|timeout`)
- `task_description`, `label`
- `started_at`, `completed_at`, `last_activity_at`
- `result_summary`, `result_status`, `artifacts`
- `due_at`, `timeout_seconds`
- `openclaw_payload` (raw payload retention)

### 6.3 `card_events` required event types
- `card.created`, `card.assigned`, `card.delegated`, `card.moved`
- `agent.started`, `agent.progress`, `agent.requested_help`
- `approval.requested`, `approval.accepted`, `approval.rejected`
- `card.completed`, `card.blocked`, `card.due_soon`, `card.overdue`, `card.review_stale`
- `discord.command_received`, `notification.sent`

---

## 7) UI Alignment (Provided Mockups)

### 7.1 Board layout
Must match provided visual direction:
- Left sidebar (Board / Agents / Reports / Settings)
- Top header (project switcher, search, filter, new task)
- Horizontal kanban columns with card counts
- Footer with live status summary

### 7.2 Card design signals
- Role badges
- Agent avatar + status (idle/working/wait/done)
- Progress bar on active tasks
- Review warning box when manual approval needed

### 7.3 Slide-over detail panel
- Stage badge + card id
- Agent assignment dropdown
- Description block
- Activity feed/timeline
- Sticky comment composer with attachment button

---

## 8) Reminder & Escalation Policies (Implementation Values)

- `staleReviewMinutes = 60`
- `dueSoonHours = 24`
- `noProgressMinutes = 30`
- `heartbeatIntervalSeconds = 300`
- `overdueCheckIntervalMinutes = 15`
- `escalationAfterBlocks = 3`

Policy outcomes:
- stale review reminder
- due soon warning
- auto-block for no progress
- overdue alert

---

## 9) Build Plan (First 2 Weeks)

### Week 1
1. Scaffold apps + docker compose
2. Implement config loader/validator for `~/.openclaw/openclaw.json`
3. Implement gateway websocket client + protocol handshake
4. Implement DB migrations (`cards`, `agents`, `card_delegations`, `card_events`)
5. Implement `GET /api/agents`, `POST /api/agents/refresh`

### Week 2
6. Implement `sessions_spawn` delegation flow from card
7. Ingest websocket events into `card_events`
8. Build board UI shell matching provided design
9. Build detail drawer with activity feed
10. Implement Discord command intake + notification output
11. Implement stale/due/overdue worker policies

---

## 10) Definition of Done for Vertical Slice v1
A card can:
1. be created in board UI or `/kb create`
2. be assigned to `main` then delegated via `sessions_spawn`
3. persist `runId + sessionKey`
4. stream progress via `session.updated`
5. transition to `review` on completion
6. notify Discord “ready for review”
7. be approved by human (`/kb approve` or UI)
8. transition to `done`
9. send completion notification
10. show full card timeline from `card_events`

---

## 11) Security and Ops Notes
- Do **not** hardcode gateway auth token in repo; load from config/env.
- Mask secrets in logs.
- Persist raw OpenClaw payloads for debugging, but redact sensitive fields where needed.
- Implement websocket reconnect with exponential backoff.

---

## 12) Missing Information Check
You have now provided enough information to start implementation.

Decisions are now finalized and implementation should proceed with:
1. **Backend stack:** Node.js 20+ + TypeScript + Express + Socket.io + PostgreSQL + Redis + Prisma/Drizzle.
2. **Agent dropdown:** hide orchestrator/main (`main`/Cortana); show only specialist worker agents.
3. **Notification routing:**
   - General channel `1471182638529122533` for system alerts, ready-for-review, completion, approvals.
   - Agent-dedicated channels for assignment notices and agent-specific questions.

No additional required information is needed to begin coding.

Optional (nice-to-have) confirmations only:
- ORM preference: Prisma vs Drizzle
- UI component library preference beyond Tailwind (if any)
- Whether to seed sample demo data on first boot


---

## 13) Immediate Execution Start

Begin implementation now with this sequence:
1. Bootstrap Express + TypeScript monorepo services and Docker Compose.
2. Add OpenClaw gateway client (protocol v3 handshake + reconnect).
3. Implement agents watcher from `~/.openclaw/openclaw.json` and specialist-only dropdown API payload.
4. Add delegation/event persistence (`card_delegations`, `card_events`).
5. Ship first Socket.io board feed + `/kb create`, `/kb assign`, `/kb approve` Discord flow.

This plan is implementation-ready.
