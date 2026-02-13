import { randomUUID } from 'node:crypto';
import { appendEvent, attachDelegationSession, findDelegationByRunId, findDelegationBySessionKey, moveCard } from './store.js';

interface GatewayOptions {
  endpoint?: string;
  token?: string;
  onCardChanged?: (cardId: string) => void;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface GatewayStatus {
  connected: boolean;
  url?: string;
  lastError?: string;
  lastHandshakeAt?: string;
}

export class OpenClawGateway {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1000;
  private isConnected = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private readonly endpoint?: string;
  private readonly token?: string;
  private readonly onCardChanged?: (cardId: string) => void;
  private lastError?: string;
  private lastHandshakeAt?: string;

  constructor(options: GatewayOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.OPENCLAW_WS_URL;
    this.token = options.token ?? process.env.OPENCLAW_TOKEN;
    this.onCardChanged = options.onCardChanged;
  }

  start() {
    if (!this.endpoint) {
      this.lastError = 'gateway endpoint is not configured';
      console.warn('[openclaw] gateway disabled: no endpoint configured');
      return;
    }
    this.connect();
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  getStatus(): GatewayStatus {
    return {
      connected: this.isConnected,
      url: this.endpoint,
      lastError: this.lastError,
      lastHandshakeAt: this.lastHandshakeAt
    };
  }

  async spawnDelegation(input: {
    delegationId: number;
    cardId: string;
    agentId: string;
    taskDescription?: string;
  }) {
    if (!this.endpoint) {
      return { ok: false as const, reason: 'gateway_disabled' };
    }

    const response = await this.request('sessions_spawn', {
      agentId: input.agentId,
      instruction: input.taskDescription,
      metadata: {
        cardId: input.cardId,
        delegationId: input.delegationId
      }
    });

    const runId = response?.runId ?? response?.payload?.runId;
    const sessionKey = response?.sessionKey ?? response?.payload?.sessionKey ?? response?.payload?.childSessionKey;
    const sessionId = response?.sessionId ?? response?.payload?.sessionId;

    const delegation = await attachDelegationSession(input.delegationId, {
      runId,
      sessionKey,
      sessionId,
      status: 'active',
      externalStatus: 'spawned'
    });

    await appendEvent({
      cardId: input.cardId,
      eventType: 'agent.started',
      eventKey: 'agent.started',
      source: 'openclaw',
      actorAgentId: input.agentId,
      payload: { runId, sessionKey, sessionId }
    });

    return { ok: true as const, delegation };
  }

  async sendResume(sessionKey: string, message: string) {
    await this.request('sessions_send', { sessionKey, message });
  }

  private connect() {
    console.info(`[openclaw] connecting to ${this.endpoint}`);
    this.ws = new WebSocket(this.endpoint!);

    this.ws.addEventListener('open', () => {
      this.isConnected = false;
      this.lastError = undefined;
      console.info('[openclaw] websocket open; awaiting challenge');
    });

    this.ws.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        await this.handleMessage(msg);
      } catch (error) {
        this.lastError = `failed to handle message: ${String(error)}`;
        console.warn('[openclaw] failed to handle message', error);
      }
    });

    this.ws.addEventListener('close', (event) => {
      this.isConnected = false;
      const reason = event.reason || '(no reason provided)';
      this.lastError = `socket closed (${event.code}): ${reason}`;
      console.warn(`[openclaw] websocket closed code=${event.code} reason=${reason}`);
      this.rejectPendingRequests(new Error('gateway websocket closed'));
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (error) => {
      this.lastError = `websocket error: ${String(error)}`;
      console.warn('[openclaw] websocket error', error);
    });
  }

  private rejectPendingRequests(error: Error) {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  private scheduleReconnect() {
    if (!this.endpoint) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const waitMs = this.reconnectDelayMs;
    console.info(`[openclaw] scheduling reconnect in ${waitMs}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), waitMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  private send(message: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private async request(method: string, payload: Record<string, unknown>): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`openclaw gateway is not connected; cannot call ${method}`);
    }

    const requestId = randomUUID();
    const sent = this.send({ id: requestId, type: method, payload });
    if (!sent) {
      throw new Error('failed to send gateway request');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`gateway request timeout for ${method}`));
      }, 15_000);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });
  }

  private resolvePending(msg: any): boolean {
    const requestId = msg?.replyTo ?? msg?.id;
    if (!requestId || !this.pendingRequests.has(requestId)) {
      return false;
    }

    const pending = this.pendingRequests.get(requestId)!;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if (msg?.error) {
      pending.reject(msg.error);
      return true;
    }

    pending.resolve(msg?.payload ?? msg);
    return true;
  }

  private async handleMessage(msg: any) {
    if (this.resolvePending(msg)) return;

    if (msg?.type === 'connect.challenge') {
      const nonce = msg?.nonce ?? msg?.payload?.nonce;
      console.info('[openclaw] challenge received');
      this.send({
        type: 'connect',
        payload: {
          protocolVersion: 3,
          auth: {
            mode: 'token',
            token: this.token
          },
          token: this.token,
          nonce,
          client: {
            name: 'clawtrello'
          }
        }
      });
      console.info('[openclaw] connect sent (token redacted)');
      return;
    }

    if (msg?.type === 'hello-ok') {
      this.isConnected = true;
      this.lastError = undefined;
      this.lastHandshakeAt = new Date().toISOString();
      this.reconnectDelayMs = 1000;
      console.info('[openclaw] hello-ok received; gateway connected');
      return;
    }

    const runId = msg?.runId ?? msg?.payload?.runId;
    const sessionKey = msg?.sessionKey ?? msg?.payload?.sessionKey ?? msg?.payload?.childSessionKey;
    const delegation = runId
      ? await findDelegationByRunId(runId)
      : sessionKey
        ? await findDelegationBySessionKey(sessionKey)
        : undefined;

    if (!delegation) return;

    switch (msg.type) {
      case 'session.updated':
        await attachDelegationSession(delegation.id, {
          status: 'in_progress',
          externalStatus: msg.payload?.status,
          sessionId: msg.payload?.sessionId,
          sessionKey: msg.payload?.sessionKey ?? msg.payload?.childSessionKey
        });
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'agent.progress',
          source: 'openclaw',
          actorAgentId: delegation.agentId,
          payload: msg.payload
        });
        break;
      case 'session.completed':
        await attachDelegationSession(delegation.id, {
          status: 'completed',
          externalStatus: 'completed'
        });
        await moveCard(delegation.cardId, 'review');
        this.onCardChanged?.(delegation.cardId);
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'card.completed',
          source: 'openclaw',
          actorAgentId: delegation.agentId,
          payload: msg.payload
        });
        break;
      case 'session.error':
        await attachDelegationSession(delegation.id, {
          status: 'error',
          externalStatus: 'session.error'
        });
        await moveCard(delegation.cardId, 'blocked');
        this.onCardChanged?.(delegation.cardId);
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'card.blocked',
          source: 'openclaw',
          actorAgentId: delegation.agentId,
          payload: msg.payload
        });
        break;
      case 'exec.approval.requested': {
        const targetStage = msg.payload?.requiresHumanHelp ? 'blocked' : 'review';
        await attachDelegationSession(delegation.id, {
          status: targetStage === 'blocked' ? 'blocked' : 'review',
          externalStatus: 'approval.requested'
        });
        await moveCard(delegation.cardId, targetStage);
        this.onCardChanged?.(delegation.cardId);
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'approval.requested',
          source: 'openclaw',
          actorAgentId: delegation.agentId,
          payload: msg.payload
        });
        break;
      }
      default:
        break;
    }
  }
}
