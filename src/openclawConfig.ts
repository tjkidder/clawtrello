import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from './types.js';

const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function fromConfig(): Agent[] {
  if (!fs.existsSync(configPath)) {
    return [
      { agentId: 'deep-researcher', name: 'Ultron', emoji: '🧠', theme: 'deep research AI', isOrchestrator: false },
      { agentId: 'researcher', name: 'JARVIS', emoji: '🧩', theme: 'pragmatic research assistant', isOrchestrator: false },
      { agentId: 'notion-expert', name: 'Skynet', emoji: '🗂️', theme: 'Notion systems architect', isOrchestrator: false }
    ];
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const list = raw?.agents?.list ?? [];
  return list.map((a: any) => ({
    agentId: a.id,
    name: a.identity?.name || a.id,
    emoji: a.identity?.emoji || '🤖',
    theme: a.identity?.theme,
    isOrchestrator: a.id === 'main' || a.id === 'orchestrator'
  }));
}

export function loadAgents(): Agent[] {
  return fromConfig();
}

export function getConfigPath(): string {
  return configPath;
}
