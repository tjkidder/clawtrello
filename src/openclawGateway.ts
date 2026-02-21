import { randomUUID } from 'node:crypto';
import { appendEvent, attachDelegationSession, findDelegationById, findDelegationByRunId, findDelegationBySessionKey, findLatestDelegationForCard, getCard, moveCard, updateDelegationSession } from './store.js';
import { getPreferredSessionKeyFormat } from './openclawConfig.js';
import { Stage } from './types.js';

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
  supportedMethods: string[];
  lastHelloAt: string | null;
  lastHealthAt: string | null;
}

interface NormalizedGatewayEvent {
  eventKey: string;
  stageUpdate?: Stage;
  actorAgentId?: string;
  delegationStatus?: string;
  externalStatus?: string;
  payload: Record<string, unknown>;
}

export class UnsupportedGatewayError extends Error {
  code = 'UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedGatewayError';
  }
}

type SessionKeyFormatLabel = 'agent_card' | 'agentid_card' | 'legacy' | 'custom';

interface SessionKeyCandidate {
  label: SessionKeyFormatLabel;
  key: string;
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
  private readonly clientMode: string;
  private lastError?: string;
  private lastHandshakeAt?: string;
  private lastCloseCode?: number;
  private lastCloseReason?: string;
  private challengeWatchdog?: NodeJS.Timeout;
  private supportedMethods = new Set<string>();
  private lastHelloAt?: string;
  private lastHealthAt?: string;

  constructor(options: GatewayOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.OPENCLAW_WS_URL;
    this.token = options.token ?? process.env.OPENCLAW_TOKEN;
    this.wsOrigin = options.origin ?? process.env.OPENCLAW_WS_ORIGIN;
    this.wsSubprotocol = options.subprotocol ?? process.env.OPENCLAW_WS_SUBPROTOCOL;
    this.wsHeaders = options.headers ?? this.parseHeaders(process.env.OPENCLAW_WS_HEADERS_JSON);
    this.onCardChanged = options.onCardChanged;
    this.clientMode = process.env.OPENCLAW_CLIENT_MODE ?? 'cli';
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
      lastCloseReason: this.lastCloseReason,
      supportedMethods: Array.from(this.supportedMethods ?? []),
      lastHelloAt: this.lastHelloAt ?? null,
      lastHealthAt: this.lastHealthAt ?? null
    };
  }

  supports(method: string): boolean {
    return this.supportedMethods?.has(method) ?? false;
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

    this.ensureMethod('agent');
    const sessionKeyFormats = this.getSessionKeyFormats(input.cardId, input.agentId);

    let response: any;
    let successfulFormat: SessionKeyFormatLabel | undefined;
    let lastError: unknown;

    for (const sessionKeyCandidate of sessionKeyFormats) {
      try {
        response = await this.trySpawnWithFormat(sessionKeyCandidate.key, input);
        successfulFormat = sessionKeyCandidate.label;
        break;
      } catch (error) {
        lastError = error;
        if (this.isAgentMismatchError(error)) {
          console.warn(`[openclaw] session key format failed; retrying with fallback format (${sessionKeyCandidate.label})`);
          continue;
        }
        throw error;
      }
    }

    if (!response || !successfulFormat) {
      throw lastError instanceof Error ? lastError : new Error('all session key formats failed');
    }

    const runId = response?.payload?.runId ?? response?.runId;
    const responseSessionKey = response?.sessionKey ?? response?.payload?.sessionKey ?? response?.payload?.childSessionKey;
    const sessionKeyCandidate = sessionKeyFormats.find((candidate) => candidate.label === successfulFormat)?.key;
    const finalSessionKey = responseSessionKey ?? sessionKeyCandidate;
    const sessionId = response?.payload?.sessionId ?? response?.sessionId;

    if (!runId) {
      throw new Error(`agent did not return runId (agentId=${input.agentId}, cardId=${input.cardId}, sessionKey=${finalSessionKey ?? 'missing'})`);
    }

    if (!finalSessionKey) {
      throw new Error(`agent did not return sessionKey and no attempted key was available for format ${successfulFormat}`);
    }

    const delegation = await updateDelegationSession(input.delegationId, {
      runId,
      sessionKey: finalSessionKey,
      sessionId,
      sessionKeyFormat: successfulFormat
    });

    if (this.supports('agent.wait')) {
      await this.request('agent.wait', { runId });
    }

    await appendEvent({
      cardId: input.cardId,
      eventType: 'agent.started',
      eventKey: 'agent.started',
      source: 'openclaw',
      actorAgentId: input.agentId,
      payload: { runId, sessionKey: finalSessionKey, sessionId, sessionKeyFormat: successfulFormat, methodUsed: 'agent' }
    });

    return {
      ok: true as const,
      methodUsed: 'agent',
      delegation,
      sessionKey: finalSessionKey,
      sessionKeyFormat: successfulFormat,
      runId,
      sessionId
    };
  }

  async resumeDelegation(delegationId: number, message: string): Promise<{ methodUsed: string; runId?: string }> {
    const delegation = await findDelegationById(delegationId);
    if (!delegation) {
      throw new Error(`Delegation ${delegationId} not found`);
    }

    if (this.supports('chat.send')) {
      if (!delegation.sessionKey) {
        throw new Error(`Delegation ${delegationId} has no session key - cannot resume`);
      }

      try {
        const idempotencyKey = `resume:${delegation.id}:${Date.now()}`;
        await this.request('chat.send', { idempotencyKey, sessionKey: delegation.sessionKey, message });
        await attachDelegationSession(delegationId, {
          status: 'in_progress',
          externalStatus: 'resumed'
        });
        return { methodUsed: 'chat.send', runId: delegation.runId };
      } catch (err: any) {
        if (this.isSchemaCompatibilityError(err)) {
          throw new UnsupportedGatewayError(`resume is not supported by this gateway schema: ${this.errorMessage(err)}`);
        }
        throw new Error(`resume failed: ${this.errorMessage(err)}`);
      }
    }

    if (delegation.runId && this.supports('agent.wait')) {
      try {
        await this.request('agent.wait', { runId: delegation.runId });
        await attachDelegationSession(delegationId, {
          status: 'in_progress',
          externalStatus: 'waiting'
        });
        return { methodUsed: 'agent.wait', runId: delegation.runId };
      } catch (err: any) {
        const msg = err?.error?.message || err?.message || String(err);
        throw new Error(`resume failed: ${msg}`);
      }
    }

    throw new UnsupportedGatewayError('resume not supported by gateway');
  }

  async getTranscript(sessionKey: string): Promise<any[]> {
    if (this.supports('chat.history')) {
      try {
        const history = await this.request('chat.history', { sessionKey });
        this.lastHealthAt = new Date().toISOString();
        return this.normalizeTranscript(history);
      } catch {
        return [];
      }
    }

    if (this.supports('sessions.history')) {
      try {
        const history = await this.request('sessions.history', { sessionKey });
        this.lastHealthAt = new Date().toISOString();
        return this.normalizeTranscript(history);
      } catch {
        return [];
      }
    }

    return [];
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

  async runAgentTask(params: {
    agentId: string;
    message: string;
    sessionKey: string;
    idempotencyKey: string;
    timeoutSeconds?: number;
  }): Promise<any> {
    this.ensureMethod('agent');

    return this.request('agent', {
      idempotencyKey: params.idempotencyKey,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      message: params.message,
      timeout: params.timeoutSeconds ?? 600
    });
  }

  private async request(method: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`openclaw gateway is not connected; cannot call ${method}`);
    }

    const requestId = randomUUID();
    const finalParams = method === 'agent.wait' ? this.stripSessionKey(payload) : payload;
    console.info('[openclaw] sending', method, JSON.stringify(finalParams));
    const sent = this.send({ type: 'req', id: requestId, method, params: finalParams });
    if (!sent) {
      throw new Error('failed to send gateway request');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`gateway request timeout for ${method}`));
      }, timeoutMs);

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
      console.info(`[openclaw] connect client.mode=${this.clientMode}`);
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
            mode: this.clientMode
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
      this.supportedMethods = new Set(msg?.payload?.features?.methods ?? []);
      this.isConnected = true;
      this.lastError = undefined;
      this.lastHandshakeAt = new Date().toISOString();
      this.reconnectDelayMs = 1000;
      console.info('[openclaw] hello-ok received; gateway connected');
      this.lastHelloAt = new Date().toISOString();
      console.info('[openclaw] supported methods:', Array.from(this.supportedMethods));
      return;
    }

    const runId = msg?.runId ?? msg?.payload?.runId ?? msg?.payload?.data?.runId;
    const sessionKey = msg?.sessionKey ?? msg?.payload?.sessionKey ?? msg?.payload?.childSessionKey ?? msg?.payload?.data?.sessionKey;
    const normalizedEvent = this.normalizeGatewayEvent(messageType, msg);
    if (!normalizedEvent) {
      return;
    }

    const delegation = await this.findDelegationForMessage({ runId, sessionKey });
    if (!delegation) {
      console.warn('[openclaw] Orphaned event (no delegation)', {
        messageType,
        runId,
        sessionKey,
        eventKey: normalizedEvent.eventKey
      });
      return;
    }

    await attachDelegationSession(delegation.id, {
      runId,
      status: normalizedEvent.delegationStatus,
      externalStatus: normalizedEvent.externalStatus,
      sessionId: msg?.payload?.sessionId,
      sessionKey
    });

    if (normalizedEvent.stageUpdate) {
      await this.maybeMoveCardStage(delegation.cardId, normalizedEvent.stageUpdate);
    }

    await appendEvent({
      cardId: delegation.cardId,
      eventType: messageType,
      eventKey: normalizedEvent.eventKey,
      source: 'openclaw',
      actorAgentId: normalizedEvent.actorAgentId ?? delegation.agentId,
      payload: normalizedEvent.payload
    });
  }


  private async trySpawnWithFormat(
    sessionKey: string,
    input: {
      delegationId: number;
      cardId: string;
      agentId: string;
      taskDescription?: string;
    }
  ): Promise<any> {
    const idempotencyKey = `delegation:${input.delegationId}:session:${sessionKey}`;
    return this.runAgentTask({
      agentId: input.agentId,
      sessionKey,
      idempotencyKey,
      message: input.taskDescription ?? '',
      timeoutSeconds: 600
    });
  }

  private getSessionKeyFormats(cardId: string, agentId: string): SessionKeyCandidate[] {
    const preferred = getPreferredSessionKeyFormat();
    const formats: SessionKeyCandidate[] = [
      this.resolvePreferredSessionKeyCandidate(preferred, cardId, agentId),
      { label: 'agent_card', key: this.buildDelegationSessionKey(cardId, agentId) },
      { label: 'agentid_card', key: `${agentId}:card:${cardId}` },
      { label: 'legacy', key: `agent:${agentId}:${cardId}` }
    ].filter((value): value is SessionKeyCandidate => Boolean(value?.key));

    const seenKeys = new Set<string>();
    return formats.filter((candidate) => {
      if (seenKeys.has(candidate.key)) return false;
      seenKeys.add(candidate.key);
      return true;
    });
  }

  private resolvePreferredSessionKeyCandidate(preferred: string | undefined, cardId: string, agentId: string): SessionKeyCandidate | undefined {
    if (!preferred) return;

    if (preferred === 'agent_card') {
      return { label: 'agent_card', key: this.buildDelegationSessionKey(cardId, agentId) };
    }
    if (preferred === 'agentid_card') {
      return { label: 'agentid_card', key: `${agentId}:card:${cardId}` };
    }
    if (preferred === 'legacy') {
      return { label: 'legacy', key: `agent:${agentId}:${cardId}` };
    }

    return { label: 'custom', key: preferred };
  }

  private normalizeTranscript(history: any): Array<{ role: string; text: string; timestamp: string | null }> {
    const messages =
      (Array.isArray(history) && history) ||
      (Array.isArray(history?.messages) && history.messages) ||
      (Array.isArray(history?.items) && history.items) ||
      (Array.isArray(history?.payload?.messages) && history.payload.messages) ||
      [];

    return messages.map((message: any) => {
      const text = this.extractTextContent(message).slice(0, 4000);
      return {
        role: message?.role ?? 'unknown',
        text,
        timestamp: message?.timestamp ?? null
      };
    });
  }

  private extractTextContent(message: unknown): string {
    if (message == null) return '';

    const safeStringify = (value: unknown): string => {
      const seen = new WeakSet<object>();
      try {
        return JSON.stringify(value, (_key, val) => {
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
          }
          return val;
        });
      } catch {
        return String(value);
      }
    };

    const content = typeof message === 'object' && message !== null ? (message as any).content : message;

    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      const parts = content
        .map((chunk) => {
          if (typeof chunk === 'string') return chunk;
          if (chunk && typeof chunk === 'object') {
            const candidate: any = chunk;
            if (typeof candidate.text === 'string') return candidate.text;
            if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text;
          }
          return '';
        })
        .map((value) => value.trim())
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }

    if (content && typeof content === 'object' && typeof (content as any).text === 'string') {
      return (content as any).text;
    }

    const payloads =
      (typeof message === 'object' && message !== null && (message as any).payloads) ||
      (typeof message === 'object' && message !== null && (message as any).result?.payloads);

    if (Array.isArray(payloads)) {
      const payloadText = payloads
        .map((payload: any) => {
          if (typeof payload?.text === 'string') return payload.text;
          if (typeof payload?.content === 'string') return payload.content;
          return '';
        })
        .map((value) => value.trim())
        .filter(Boolean)
        .join('\n');
      if (payloadText) return payloadText;
    }

    if (typeof (message as any)?.output_text === 'string') return (message as any).output_text;
    if (typeof (message as any)?.text === 'string') return (message as any).text;

    const serialized = safeStringify(message);
    return serialized === '{}' ? '' : serialized;
  }

  private async findDelegationForMessage(input: { runId?: string; sessionKey?: string }) {
    if (input.runId) {
      const byRunId = await findDelegationByRunId(input.runId);
      if (byRunId) return byRunId;
    }

    if (input.sessionKey) {
      const bySessionKey = await findDelegationBySessionKey(input.sessionKey);
      if (bySessionKey) return bySessionKey;

      const cardId = this.extractCardIdFromSessionKey(input.sessionKey);
      if (cardId) {
        const byCard = await findLatestDelegationForCard(cardId);
        if (byCard) return byCard;
      }
    }

    return undefined;
  }

  private extractCardIdFromSessionKey(sessionKey: string): string | undefined {
    const explicitCardMatch = sessionKey.match(/(?:^|:)card:([0-9a-fA-F-]{36})(?:$|:)/);
    if (explicitCardMatch?.[1]) return explicitCardMatch[1];

    const trailingUuidMatch = sessionKey.match(/([0-9a-fA-F-]{36})$/);
    if (trailingUuidMatch?.[1]) return trailingUuidMatch[1];

    return undefined;
  }

  private normalizeGatewayEvent(messageType: string, msg: any): NormalizedGatewayEvent | undefined {
    const stream = msg?.payload?.stream;
    const phase = msg?.payload?.data?.phase;

    if (stream === 'error' || messageType === 'session.error' || msg?.ok === false || msg?.error) {
      return {
        eventKey: 'agent.error',
        stageUpdate: 'blocked',
        delegationStatus: 'error',
        externalStatus: stream === 'error' ? 'stream.error' : messageType,
        actorAgentId: msg?.payload?.agentId,
        payload: this.toJsonSafePayload(msg?.payload ?? msg)
      };
    }

    if (stream === 'lifecycle' && phase === 'start') {
      return {
        eventKey: 'agent.started',
        stageUpdate: 'in_progress',
        delegationStatus: 'in_progress',
        externalStatus: 'lifecycle.start',
        actorAgentId: msg?.payload?.agentId,
        payload: this.toJsonSafePayload(msg?.payload ?? msg)
      };
    }

    if (stream === 'lifecycle' && phase === 'end') {
      return {
        eventKey: 'agent.completed',
        stageUpdate: 'review',
        delegationStatus: 'completed',
        externalStatus: 'lifecycle.end',
        actorAgentId: msg?.payload?.agentId,
        payload: this.toJsonSafePayload(msg?.payload ?? msg)
      };
    }

    if (messageType === 'session.updated') {
      return {
        eventKey: 'agent.progress',
        delegationStatus: 'in_progress',
        externalStatus: msg?.payload?.status,
        actorAgentId: msg?.payload?.agentId,
        payload: this.toJsonSafePayload(msg?.payload ?? msg)
      };
    }

    if (messageType === 'session.completed') {
      return {
        eventKey: 'agent.completed',
        stageUpdate: 'review',
        delegationStatus: 'completed',
        externalStatus: 'completed',
        actorAgentId: msg?.payload?.agentId,
        payload: this.toJsonSafePayload(msg?.payload ?? msg)
      };
    }

    if (messageType === 'exec.approval.requested' || messageType === 'exec.approval.request') {
      return {
        eventKey: 'approval.requested',
        stageUpdate: 'review',
        delegationStatus: 'review',
        externalStatus: 'approval.requested',
        actorAgentId: msg?.payload?.agentId,
        payload: this.toJsonSafePayload(msg?.payload ?? msg)
      };
    }

    return undefined;
  }

  private async maybeMoveCardStage(cardId: string, stageUpdate: Stage): Promise<void> {
    const card = await getCard(cardId);
    if (!card || !this.isAllowedAutoTransition(card.stage, stageUpdate)) {
      return;
    }

    const updated = await moveCard(cardId, stageUpdate);
    if (updated) {
      this.onCardChanged?.(cardId);
    }
  }

  private isAllowedAutoTransition(currentStage: Stage, nextStage: Stage): boolean {
    if (currentStage === nextStage) return false;

    const allowedTransitions: Record<Stage, Stage[]> = {
      backlog: ['in_progress'],
      in_progress: ['review', 'blocked'],
      review: ['blocked'],
      blocked: ['in_progress'],
      done: []
    };

    return allowedTransitions[currentStage].includes(nextStage);
  }

  private toJsonSafePayload(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { value: payload as any };
    }
    return payload as Record<string, unknown>;
  }

  private isSchemaCompatibilityError(error: any): boolean {
    const code = error?.code ?? error?.error?.code;
    const message = this.errorMessage(error).toLowerCase();
    if (code !== 'INVALID_REQUEST') return false;
    return (
      message.includes('must have required property') ||
      message.includes('unexpected property') ||
      message.includes('schema') ||
      message.includes('params')
    );
  }

  private errorMessage(error: any): string {
    return error?.error?.message || error?.message || String(error);
  }

  private isAgentMismatchError(error: unknown): boolean {
    if (!error) return false;
    const message = JSON.stringify(error).toLowerCase();
    return message.includes('does not match session key') || message.includes('agent mismatch');
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

  private ensureMethod(method: string): void {
    if (this.supports(method)) return;
    throw new Error(`Gateway does not advertise method ${method}. Known methods: ${JSON.stringify(Array.from(this.supportedMethods))}`);
  }

  private buildDelegationSessionKey(cardId: string, agentId: string): string {
    return `agent:${agentId}:card:${cardId}`;
  }

  private stripSessionKey(payload: Record<string, unknown>): Record<string, unknown> {
    const { sessionKey: _sessionKey, ...paramsWithoutSessionKey } = payload;
    return paramsWithoutSessionKey;
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
