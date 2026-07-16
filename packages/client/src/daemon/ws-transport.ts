import { WebSocket } from 'ws';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type CapabilityFlag,
  type Envelope,
} from '@byok/protocol';
import { toWsUrl } from './url';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

export interface WsTransportOptions {
  serverUrl: string;
  deviceToken: string;
  deviceId: string;
  productId: string;
  capabilities: CapabilityFlag[];
  onEnvelope: (envelope: Envelope) => void;
  onStateChange?: (state: ConnectionState) => void;
  backoff?: BackoffOptions;
}

/**
 * The daemon's outbound-only WS connection: opens, sends `conn.hello`, waits
 * for `conn.ack`, and reconnects with capped exponential backoff + jitter on
 * drop (M0 scope — at-least-once redelivery with cursors is M1). Frames not
 * yet ack'd (or sent while disconnected) are queued and flushed on the next
 * successful handshake.
 */
export class WsTransport {
  private socket: WebSocket | undefined;
  private closedByUser = false;
  private acked = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly outbox: string[] = [];
  private ackWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private readonly opts: WsTransportOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  send(envelope: Envelope): void {
    const line = encodeEnvelope(envelope);
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.acked) {
      this.socket.send(line);
    } else {
      this.outbox.push(line);
    }
  }

  waitForAck(timeoutMs = 10_000): Promise<void> {
    if (this.acked) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for conn.ack')), timeoutMs);
      this.ackWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private openSocket(): void {
    const url = toWsUrl(this.opts.serverUrl);
    this.acked = false;
    this.opts.onStateChange?.('connecting');

    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.opts.deviceToken}` },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      const hello = createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: this.opts.capabilities,
        deviceId: this.opts.deviceId,
        productId: this.opts.productId,
      });
      socket.send(encodeEnvelope(hello));
    });

    socket.on('message', (data, isBinary) => {
      const bytes = toBytes(data, isBinary);
      let envelope: Envelope;
      try {
        envelope = decodeEnvelope(bytes);
      } catch {
        return; // unparsable or unknown-type frame — ignore for forward-compat
      }
      if (envelope.type === 'conn.ack') {
        this.acked = true;
        this.opts.onStateChange?.('open');
        this.flushOutbox();
        for (const waiter of this.ackWaiters.splice(0)) waiter.resolve();
      }
      this.opts.onEnvelope(envelope);
    });

    socket.on('close', () => {
      this.socket = undefined;
      this.opts.onStateChange?.('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    });

    // A 'close' event always follows 'error' for ws sockets; avoid an
    // unhandled-error crash and let the close handler drive reconnection.
    socket.on('error', () => {});
  }

  private scheduleReconnect(): void {
    const { baseMs = 1000, maxMs = 30_000, factor = 2 } = this.opts.backoff ?? {};
    const delay = Math.min(maxMs, baseMs * factor ** this.reconnectAttempt);
    const jitter = delay * (0.8 + Math.random() * 0.4);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.openSocket(), jitter);
  }

  private flushOutbox(): void {
    for (const line of this.outbox.splice(0)) {
      this.socket?.send(line);
    }
  }
}

function toBytes(data: unknown, _isBinary: boolean): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.from(String(data), 'utf8');
}
