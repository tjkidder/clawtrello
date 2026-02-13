import { v4 as uuidv4 } from 'uuid';
import { Card, Stage } from './types.js';

const cards = new Map<string, Card>();

export function listCards(): Card[] {
  return Array.from(cards.values());
}

export function createCard(input: { title: string; description?: string; dueAt?: string }): Card {
  const now = new Date().toISOString();
  const card: Card = {
    id: uuidv4(),
    title: input.title,
    description: input.description,
    dueAt: input.dueAt,
    stage: 'backlog',
    createdAt: now,
    updatedAt: now
  };
  cards.set(card.id, card);
  return card;
}

export function moveCard(id: string, stage: Stage): Card | undefined {
  const card = cards.get(id);
  if (!card) return;
  card.stage = stage;
  card.updatedAt = new Date().toISOString();
  cards.set(id, card);
  return card;
}

export function assignCard(id: string, assigneeAgentId: string): Card | undefined {
  const card = cards.get(id);
  if (!card) return;
  card.assigneeAgentId = assigneeAgentId;
  card.updatedAt = new Date().toISOString();
  cards.set(id, card);
  return card;
}

export function approveCard(id: string): Card | undefined {
  const card = cards.get(id);
  if (!card || card.stage !== 'review') return;
  card.stage = 'done';
  card.approvedAt = new Date().toISOString();
  card.updatedAt = card.approvedAt;
  cards.set(id, card);
  return card;
}
