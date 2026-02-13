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
