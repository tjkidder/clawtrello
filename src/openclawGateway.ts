import { appendEvent, attachDelegationSession, findDelegationByRunId } from './store.js';

interface GatewayOptions {
  endpoint?: string;
  token?: string;
}

export class OpenClawGateway {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly endpoint?: string;
  private readonly token?: string;

  constructor(options: GatewayOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.OPENCLAW_WS_URL;
    this.token = options.token ?? process.env.OPENCLAW_TOKEN;
  }

  start() {
    if (!this.endpoint) return;
    this.connect();
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  async sendResume(sessionKey: string, message: string) {
    this.send({ type: 'sessions_send', sessionKey, payload: { message } });
  }

  private connect() {
    this.ws = new WebSocket(this.endpoint!);

    this.ws.addEventListener('open', () => {
      this.send({ type: 'protocol-v3.handshake', token: this.token, client: 'clawtrello' });
    });

    this.ws.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        await this.handleMessage(msg);
      } catch (error) {
        console.warn('[openclaw] failed to handle message', error);
      }
    });

    this.ws.addEventListener('close', () => {
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });

    this.ws.addEventListener('error', (error) => {
      console.warn('[openclaw] websocket error', error);
    });
  }

  private send(message: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private async handleMessage(msg: any) {
    const runId = msg?.runId ?? msg?.payload?.runId;
    if (!runId) return;
    const delegation = await findDelegationByRunId(runId);
    if (!delegation) return;

    switch (msg.type) {
      case 'session.updated':
        await attachDelegationSession(delegation.id, {
          status: 'running',
          externalStatus: msg.payload?.status,
          sessionId: msg.payload?.sessionId,
          sessionKey: msg.payload?.sessionKey
        });
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'card.delegation.progress',
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
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'card.delegation.completed',
          source: 'openclaw',
          actorAgentId: delegation.agentId,
          payload: msg.payload
        });
        break;
      case 'session.error':
      case 'exec.approval.requested':
        await attachDelegationSession(delegation.id, {
          status: 'blocked',
          externalStatus: msg.type
        });
        await appendEvent({
          cardId: delegation.cardId,
          eventType: msg.type,
          eventKey: 'card.delegation.failed',
          source: 'openclaw',
          actorAgentId: delegation.agentId,
          payload: msg.payload
        });
        break;
      default:
        break;
    }
  }
}
