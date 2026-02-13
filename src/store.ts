import { v4 as uuidv4 } from 'uuid';
import { pool } from './db.js';
import { Agent, Card, CardDelegation, CardTimelineEvent, Stage } from './types.js';

function mapCard(row: any): Card {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    stage: row.stage,
    assigneeAgentId: row.assignee_agent_id ?? undefined,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : undefined,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapEvent(row: any): CardTimelineEvent {
  return {
    id: row.id,
    cardId: row.card_id,
    eventType: row.event_type,
    eventKey: row.event_key ?? row.event_type,
    source: row.source,
    actorAgentId: row.actor_agent_id ?? undefined,
    payload: row.payload ?? {},
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapDelegation(row: any): CardDelegation {
  return {
    id: row.id,
    cardId: row.card_id,
    agentId: row.agent_id,
    runId: row.run_id ?? undefined,
    sessionKey: row.session_key ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    externalStatus: row.external_status ?? undefined,
    taskDescription: row.task_description ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined
  };
}

export async function appendEvent(input: {
  cardId: string;
  eventType: string;
  eventKey?: string;
  source?: string;
  actorAgentId?: string;
  payload?: unknown;
}) {
  await pool.query(
    `INSERT INTO card_events(card_id, event_type, event_key, source, actor_agent_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.cardId,
      input.eventType,
      input.eventKey ?? input.eventType,
      input.source ?? 'app',
      input.actorAgentId ?? null,
      JSON.stringify(input.payload ?? {})
    ]
  );
}

export async function hasRecentEvent(cardId: string, eventKey: string, windowMinutes: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM card_events
      WHERE card_id = $1
        AND event_key = $2
        AND created_at >= NOW() - ($3::text || ' minutes')::interval
      LIMIT 1`,
    [cardId, eventKey, String(windowMinutes)]
  );
  return result.rowCount > 0;
}

export async function hasEvent(cardId: string, eventKey: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM card_events
      WHERE card_id = $1 AND event_key = $2
      LIMIT 1`,
    [cardId, eventKey]
  );
  return result.rowCount > 0;
}

export async function listCards(): Promise<Card[]> {
  const result = await pool.query('SELECT * FROM cards ORDER BY created_at DESC');
  return result.rows.map(mapCard);
}

export async function getCard(id: string): Promise<Card | undefined> {
  const result = await pool.query('SELECT * FROM cards WHERE id = $1', [id]);
  return result.rowCount ? mapCard(result.rows[0]) : undefined;
}

export async function listCardTimeline(cardId: string): Promise<CardTimelineEvent[]> {
  const result = await pool.query('SELECT * FROM card_events WHERE card_id = $1 ORDER BY created_at ASC, id ASC', [cardId]);
  return result.rows.map(mapEvent);
}

export async function createCard(input: { title: string; description?: string; dueAt?: string }): Promise<Card> {
  const id = uuidv4();
  const now = new Date().toISOString();
  const result = await pool.query(
    `INSERT INTO cards(id, title, description, stage, due_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'backlog', $4, $5, $5)
     RETURNING *`,
    [id, input.title, input.description ?? null, input.dueAt ?? null, now]
  );

  const card = mapCard(result.rows[0]);
  await appendEvent({ cardId: card.id, eventType: 'card.created', eventKey: 'card.created', payload: { card } });
  return card;
}

export async function moveCard(id: string, stage: Stage): Promise<Card | undefined> {
  const result = await pool.query('UPDATE cards SET stage = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [id, stage]);
  if (!result.rowCount) return;
  const card = mapCard(result.rows[0]);
  await appendEvent({ cardId: card.id, eventType: 'card.moved', eventKey: 'card.moved', payload: { stage: card.stage } });
  return card;
}

export async function assignCard(id: string, assigneeAgentId: string): Promise<Card | undefined> {
  const result = await pool.query(
    'UPDATE cards SET assignee_agent_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id, assigneeAgentId]
  );
  if (!result.rowCount) return;
  const card = mapCard(result.rows[0]);
  await appendEvent({
    cardId: card.id,
    eventType: 'card.assigned',
    eventKey: 'card.assigned',
    actorAgentId: assigneeAgentId,
    payload: { assigneeAgentId: card.assigneeAgentId }
  });
  return card;
}

export async function approveCard(id: string): Promise<Card | undefined> {
  const result = await pool.query(
    `UPDATE cards
      SET stage = 'done', approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND stage = 'review'
      RETURNING *`,
    [id]
  );
  if (!result.rowCount) return;
  const card = mapCard(result.rows[0]);
  await appendEvent({ cardId: card.id, eventType: 'approval.accepted', eventKey: 'approval.accepted', payload: { approvedAt: card.approvedAt } });
  return card;
}

export async function upsertAgents(agents: Agent[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (agents.length) {
      for (const agent of agents) {
        await client.query(
          `INSERT INTO agents(agent_id, name, emoji, theme, is_orchestrator, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT(agent_id) DO UPDATE
           SET name = EXCLUDED.name,
               emoji = EXCLUDED.emoji,
               theme = EXCLUDED.theme,
               is_orchestrator = EXCLUDED.is_orchestrator,
               updated_at = NOW()`,
          [agent.agentId, agent.name, agent.emoji, agent.theme ?? null, agent.isOrchestrator]
        );
      }
    }

    await client.query(
      `DELETE FROM agents
       WHERE agent_id NOT IN (SELECT unnest($1::text[]))`,
      [agents.map((a) => a.agentId)]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createDelegation(input: { cardId: string; agentId: string; taskDescription?: string }): Promise<CardDelegation> {
  const result = await pool.query(
    `INSERT INTO card_delegations(card_id, agent_id, task_description, status, updated_at)
     VALUES($1,$2,$3,'pending',NOW())
     RETURNING *`,
    [input.cardId, input.agentId, input.taskDescription ?? null]
  );
  return mapDelegation(result.rows[0]);
}

export async function attachDelegationSession(
  delegationId: number,
  input: { runId?: string; sessionKey?: string; sessionId?: string; status?: string; externalStatus?: string }
): Promise<CardDelegation | undefined> {
  const result = await pool.query(
    `UPDATE card_delegations
      SET run_id = COALESCE($2, run_id),
          session_key = COALESCE($3, session_key),
          session_id = COALESCE($4, session_id),
          status = COALESCE($5, status),
          external_status = COALESCE($6, external_status),
          last_activity_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [delegationId, input.runId ?? null, input.sessionKey ?? null, input.sessionId ?? null, input.status ?? null, input.externalStatus ?? null]
  );
  if (!result.rowCount) return;
  return mapDelegation(result.rows[0]);
}

export async function findDelegationByRunId(runId: string): Promise<CardDelegation | undefined> {
  const result = await pool.query('SELECT * FROM card_delegations WHERE run_id = $1', [runId]);
  return result.rowCount ? mapDelegation(result.rows[0]) : undefined;
}

export async function findDelegationBySessionKey(sessionKey: string): Promise<CardDelegation | undefined> {
  const result = await pool.query('SELECT * FROM card_delegations WHERE session_key = $1', [sessionKey]);
  return result.rowCount ? mapDelegation(result.rows[0]) : undefined;
}

export async function listPolicyCandidates(): Promise<Card[]> {
  const result = await pool.query("SELECT * FROM cards WHERE stage NOT IN ('done')");
  return result.rows.map(mapCard);
}
