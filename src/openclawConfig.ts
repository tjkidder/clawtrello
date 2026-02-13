import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSON5 from 'json5';
import { Agent } from './types.js';

const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

const fallbackAgents: Agent[] = [
  { agentId: 'deep-researcher', name: 'Ultron', emoji: '🧠', theme: 'deep research AI', isOrchestrator: false },
  { agentId: 'researcher', name: 'JARVIS', emoji: '🧩', theme: 'pragmatic research assistant', isOrchestrator: false },
  { agentId: 'notion-expert', name: 'Skynet', emoji: '🗂️', theme: 'Notion systems architect', isOrchestrator: false }
];

function parseOpenClawConfig(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return JSON5.parse(content);
  }
}

function fromConfig(): Agent[] {
  if (!fs.existsSync(configPath)) {
    return fallbackAgents;
  }

  try {
    const raw = parseOpenClawConfig(fs.readFileSync(configPath, 'utf8'));
    const list = raw?.agents?.list ?? [];
    const agents = list.map((a: any) => ({
      agentId: a.id,
      name: a.identity?.name || a.id,
      emoji: a.identity?.emoji || '🤖',
      theme: a.identity?.theme,
      isOrchestrator: a.id === 'main' || a.id === 'orchestrator'
    }));

    return agents.length > 0 ? agents : fallbackAgents;
  } catch (error) {
    console.warn(`[openclaw] Failed to parse ${configPath}. Falling back to default specialists.`, error);
    return fallbackAgents;
  }
}

export function loadAgents(): Agent[] {
  return fromConfig();
}

export function getConfigPath(): string {
  return configPath;
}
