export type Stage = 'backlog' | 'in_progress' | 'review' | 'blocked' | 'done';

export interface Agent {
  agentId: string;
  name: string;
  emoji: string;
  theme?: string;
  isOrchestrator: boolean;
}

export interface Card {
  id: string;
  title: string;
  description?: string;
  stage: Stage;
  assigneeAgentId?: string;
  dueAt?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type CardEventKey =
  | 'card.created'
  | 'card.assigned'
  | 'card.moved'
  | 'approval.accepted'
  | 'approval.requested'
  | 'card.delegated'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.error'
  | 'agent.progress'
  | 'card.completed'
  | 'card.blocked'
  | 'card.due_soon'
  | 'card.overdue'
  | 'card.review_stale';

export interface CardTimelineEvent {
  id: number;
  cardId: string;
  eventType: string;
  eventKey: CardEventKey | string;
  source: 'app' | 'openclaw' | 'policy' | string;
  actorAgentId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CardDelegation {
  id: number;
  cardId: string;
  agentId: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionKeyFormat?: string;
  status: string;
  externalStatus?: string;
  taskDescription?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
