import { randomUUID } from 'node:crypto';
import { appendEvent, attachDelegationSession, findDelegationByRunId, findDelegationBySessionKey, moveCard } from './store.js';

interface GatewayOptions {
  endpoint?: string;
  token?: string;
  origin?: string;
  subprotocol?: string;
  headers?: Record<string, string>;
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
  lastCloseCode?: number;
  lastCloseReason?: string;
}

export class OpenClawGateway {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1000;
  private isConnected = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private readonly endpoint?: string;
  private readonly token?: string;
  private readonly wsOrigin?: string;
  private readonly wsSubprotocol?: string;
  private readonly wsHeaders?: Record<string, string>;
  private readonly onCardChanged?: (cardId: string) => void;
  private lastError?: string;
  private lastHandshakeAt?: string;
  private lastCloseCode?: number;
  private lastCloseReason?: string;
  private challengeWatchdog?: NodeJS.Timeout;

  constructor(options: GatewayOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.OPENCLAW_WS_URL;
    this.token = options.token ?? process.env.OPENCLAW_TOKEN;
    this.wsOrigin = options.origin ?? process.env.OPENCLAW_WS_ORIGIN;
    this.wsSubprotocol = options.subprotocol ?? process.env.OPENCLAW_WS_SUBPROTOCOL;
    this.wsHeaders = options.headers ?? this.parseHeaders(process.env.OPENCLAW_WS_HEADERS_JSON);
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
      lastHandshakeAt: this.lastHandshakeAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason
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
    const headers: Record<string, string> = { ...(this.wsHeaders ?? {}) };
    if (this.wsOrigin) {
      headers.Origin = this.wsOrigin;
    }

    const wsInit: { protocols?: string; headers?: Record<string, string> } = {};
    if (this.wsSubprotocol) wsInit.protocols = this.wsSubprotocol;
    if (Object.keys(headers).length > 0) wsInit.headers = headers;

    const WebSocketWithInit = WebSocket as unknown as {
      new (url: string, protocols?: string | string[] | { protocols?: string | string[]; headers?: Record<string, string> }): WebSocket;
      OPEN: number;
    };

    this.ws = new WebSocketWithInit(this.endpoint!, wsInit);
    let receivedAnyMessage = false;
    let handshakeComplete = false;

    this.ws.addEventListener('message', async (event: MessageEvent) => {
      receivedAnyMessage = true;
      if (this.challengeWatchdog) {
        clearTimeout(this.challengeWatchdog);
        this.challengeWatchdog = undefined;
      }

      const raw = await this.messageToString(event.data);
      console.info(`[openclaw] raw frame received: ${this.truncateForLog(raw)}`);

      try {
        const msg = JSON.parse(raw);
        await this.handleMessage(msg);
        const isHelloOk =
          (msg?.type === 'res' && msg?.ok && msg?.payload?.type === 'hello-ok') ||
          (msg?.type === 'event' && msg?.event === 'hello-ok');
        if (isHelloOk) {
          handshakeComplete = true;
        }
      } catch (error) {
        this.lastError = `failed to handle message: ${String(error)}`;
        console.warn(`[openclaw] failed to parse/handle frame frame=${this.truncateForLog(raw)}`, error);
      }
    });

    this.ws.addEventListener('open', () => {
      this.isConnected = false;
      this.lastError = undefined;
      const wsOptionsLog = JSON.stringify({
        subprotocol: this.wsSubprotocol,
        headers
      });
      console.info(`[openclaw] websocket open; awaiting challenge (options=${wsOptionsLog})`);

      this.challengeWatchdog = setTimeout(() => {
        if (receivedAnyMessage || this.isConnected) return;
        console.warn(`[openclaw] no challenge received within 500ms (url=${this.endpoint}, options=${wsOptionsLog})`);
      }, 500);
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this.isConnected = false;
      this.lastCloseCode = event.code;
      const reason = event.reason || '(no reason provided)';
      this.lastCloseReason = reason;
      if (this.challengeWatchdog) {
        clearTimeout(this.challengeWatchdog);
        this.challengeWatchdog = undefined;
      }

      this.lastError = handshakeComplete ? `socket closed (${event.code}): ${reason}` : 'closed before handshake complete';
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
    const sent = this.send({ type: 'req', id: requestId, method, params: payload });
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
    if (msg?.type !== 'res') return false;

    const requestId = msg?.id;
    if (!requestId || !this.pendingRequests.has(requestId)) {
      return false;
    }

    const pending = this.pendingRequests.get(requestId)!;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if (msg?.ok === false || msg?.error) {
      pending.reject(msg.error ?? msg);
      return true;
    }

    pending.resolve(msg?.payload);
    return true;
  }

  private async handleMessage(msg: any) {
    if (this.resolvePending(msg)) return;

    const messageType = msg?.type === 'event' ? msg?.event : msg?.type;

    if (messageType === 'connect.challenge') {
      const requestId = randomUUID();
      console.info('[openclaw] challenge received');
      this.send({
        type: 'req',
        id: requestId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          auth: {
            token: this.token
          },
          client: {
            id: 'cli',
            version: '0.1.0',
            platform: 'macos',
            mode: 'operator'
          }
        }
      });
      console.info('[openclaw] connect sent (token redacted)');
      return;
    }

    const isHelloOk =
      (msg?.type === 'res' && msg?.ok && msg?.payload?.type === 'hello-ok') ||
      (msg?.type === 'event' && msg?.event === 'hello-ok');
    if (isHelloOk) {
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

    switch (messageType) {
      case 'session.updated':
        await attachDelegationSession(delegation.id, {
          status: 'in_progress',
          externalStatus: msg.payload?.status,
          sessionId: msg.payload?.sessionId,
          sessionKey: msg.payload?.sessionKey ?? msg.payload?.childSessionKey
        });
        await appendEvent({
          cardId: delegation.cardId,
          eventType: messageType,
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
          eventType: messageType,
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
          eventType: messageType,
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
          eventType: messageType,
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

  private parseHeaders(headersJson: string | undefined): Record<string, string> | undefined {
    if (!headersJson) return undefined;

    try {
      const parsed = JSON.parse(headersJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.lastError = 'OPENCLAW_WS_HEADERS_JSON must be a JSON object';
        return undefined;
      }

      return Object.fromEntries(
        Object.entries(parsed)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, value as string])
      );
    } catch (error) {
      this.lastError = `failed to parse OPENCLAW_WS_HEADERS_JSON: ${String(error)}`;
      console.warn('[openclaw] failed to parse OPENCLAW_WS_HEADERS_JSON', error);
      return undefined;
    }
  }

  private async messageToString(data: unknown): Promise<string> {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data.text();
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer).toString('utf8');
    return String(data);
  }

  private truncateForLog(text: string, limit = 300): string {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
}
