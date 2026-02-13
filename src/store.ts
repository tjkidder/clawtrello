import { v4 as uuidv4 } from 'uuid';
import { pool } from './db.js';
import { Card, Stage } from './types.js';

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

async function appendEvent(cardId: string, eventType: string, payload: unknown) {
  await pool.query('INSERT INTO card_events(card_id, event_type, payload) VALUES ($1, $2, $3::jsonb)', [
    cardId,
    eventType,
    JSON.stringify(payload ?? {})
  ]);
}

export async function listCards(): Promise<Card[]> {
  const result = await pool.query('SELECT * FROM cards ORDER BY created_at DESC');
  return result.rows.map(mapCard);
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
  await appendEvent(card.id, 'card.created', { card });
  return card;
}

export async function moveCard(id: string, stage: Stage): Promise<Card | undefined> {
  const result = await pool.query('UPDATE cards SET stage = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [id, stage]);
  if (!result.rowCount) return;
  const card = mapCard(result.rows[0]);
  await appendEvent(card.id, 'card.moved', { stage: card.stage });
  return card;
}

export async function assignCard(id: string, assigneeAgentId: string): Promise<Card | undefined> {
  const result = await pool.query(
    'UPDATE cards SET assignee_agent_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id, assigneeAgentId]
  );
  if (!result.rowCount) return;
  const card = mapCard(result.rows[0]);
  await appendEvent(card.id, 'card.assigned', { assigneeAgentId: card.assigneeAgentId });
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
  await appendEvent(card.id, 'approval.accepted', { approvedAt: card.approvedAt });
  return card;
}
