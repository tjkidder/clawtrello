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

function readConfig(): any | undefined {
  if (!fs.existsSync(configPath)) {
    return;
  }

  try {
    return parseOpenClawConfig(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn(`[openclaw] Failed to parse ${configPath}. Falling back to defaults.`, error);
    return;
  }
}

function fromConfig(): Agent[] {
  const raw = readConfig();
  const list = raw?.agents?.list ?? [];
  const agents = list.map((a: any) => ({
    agentId: a.id,
    name: a.identity?.name || a.id,
    emoji: a.identity?.emoji || '🤖',
    theme: a.identity?.theme,
    isOrchestrator: a.id === 'main' || a.id === 'orchestrator'
  }));

  return agents.length > 0 ? agents : fallbackAgents;
}

export function loadGatewayRuntimeConfig(): { endpoint?: string; token?: string } {
  const raw = readConfig();
  const port = raw?.gateway?.port;
  const token = raw?.gateway?.auth?.token;
  const endpoint = typeof port === 'number' ? `ws://127.0.0.1:${port}` : undefined;

  return {
    endpoint: process.env.OPENCLAW_WS_URL ?? endpoint,
    token: process.env.OPENCLAW_TOKEN ?? token
  };
}

export function loadAgents(): Agent[] {
  return fromConfig();
}

export function getConfigPath(): string {
  return configPath;
}
