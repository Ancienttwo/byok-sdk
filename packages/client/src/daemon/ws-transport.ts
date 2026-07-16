import { WebSocket } from 'ws';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type CapabilityFlag,
  type Envelope,
  type RuntimeInfo,
} from '@byok/protocol';
import { toWsUrl } from './url';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'degraded' | 'revoked';

/** The WS upgrade itself was rejected with a non-101 HTTP status (e.g. 401 for an expired/invalid bearer token). Surfaced via `onConnectOutcome` so `ConnectionManager` can force a reactive token renewal before the next attempt (protocol §6.2, "reactively on 401"). */
export class WsUnexpectedStatusError extends Error {
  constructor(public readonly status: number) {
    super(`WS upgrade rejected with HTTP ${status}`);
    this.name = 'WsUnexpectedStatusError';
  }
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

export interface LivenessOptions {
  /** Terminate and reconnect if no data/ping arrives for this long. Default 75s (server pings every 30s per the pinned heartbeat convention). */
  timeoutMs?: number;
  /** How often to check for silence. Default: timeoutMs/3, floored at 1s. */
  checkIntervalMs?: number;
}

export interface WsTransportOptions {
  serverUrl: string;
  /** Resolves the current valid bearer token; called fresh before every connect attempt (initial and every reconnect) so a proactively-renewed token is always used. */
  getToken: () => Promise<string>;
  deviceId: string;
  productId: string;
  capabilities: CapabilityFlag[];
  /** Detected runtimes, sent on every `conn.hello` (protocol §10 gap #4/#11). */
  runtimes?: RuntimeInfo[];
  /** The redelivery cursor to send as `conn.hello.cursor` (protocol §9) — read fresh on every connect so a value learned mid-connection is used on the next reconnect. */
  getCursor?: () => number | undefined;
  onEnvelope: (envelope: Envelope) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Fired the moment `conn.ack` is processed and the connection becomes usable — independent of `onConnectOutcome`, which only fires on close (a healthy, still-open connection never reaches it). */
  onAcked?: () => void;
  /**
   * Fired once per connection attempt when the socket closes, reporting
   * whether that attempt ever reached `conn.ack` (`acked`) before closing,
   * and the causing error when the attempt failed before a socket even
   * opened (e.g. `getToken()` rejecting). Used by `ConnectionManager` to
   * count consecutive failures for the long-poll fallback (protocol §8).
   */
  onConnectOutcome?: (acked: boolean, err?: unknown) => void;
  backoff?: BackoffOptions;
  liveness?: LivenessOptions;
}

/**
 * The daemon's outbound-only WS connection: opens, sends `conn.hello`, waits
 * for `conn.ack`, and reconnects with capped exponential backoff + jitter on
 * drop. Frames not yet ack'd (or sent while disconnected) are queued and
 * flushed on the next successful handshake — this is also how a message
 * "sent" while the connection manager has fallen back to long-poll actually
 * leaves the device: it queues here until WS recovers (protocol §8 has no
 * daemon->server HTTP path).
 *
 * Auto-reconnect can be paused (`stopAutoReconnect`) and single attempts
 * made on demand (`connect({ auto: false })`) — used by `ConnectionManager`
 * to probe WS recovery every few minutes while long-polling, without this
 * transport's own backoff loop fighting that cadence.
 */
export class WsTransport {
  private socket: WebSocket | undefined;
  private closedByUser = false;
  private autoReconnect = true;
  private acked = false;
  private everAckedThisAttempt = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  private lastActivity = 0;
  private lastUnexpectedStatus: number | undefined;
  private readonly outbox: string[] = [];
  private ackWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private readonly opts: WsTransportOptions) {}

  connect(opts: { auto?: boolean } = {}): void {
    this.autoReconnect = opts.auto ?? true;
    this.closedByUser = false;
    void this.openSocket();
  }

  /** Stop scheduling further reconnect attempts (any pending one is cancelled too); the current socket, if any, is left alone. Used when handing retry ownership to a slower external cadence (e.g. the long-poll fallback's periodic WS probe). */
  stopAutoReconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** Resume normal auto-reconnect-on-close behavior (does not itself trigger a connect — only affects future closes). */
  resumeAutoReconnect(): void {
    this.autoReconnect = true;
  }

  get isOpen(): boolean {
    return this.acked;
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

  private async openSocket(): Promise<void> {
    const url = toWsUrl(this.opts.serverUrl);
    this.acked = false;
    this.everAckedThisAttempt = false;
    this.opts.onStateChange?.('connecting');

    let token: string;
    try {
      token = await this.opts.getToken();
    } catch (err) {
      this.opts.onStateChange?.('closed');
      this.opts.onConnectOutcome?.(false, err);
      if (!this.closedByUser && this.autoReconnect) this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.socket = socket;
    this.lastActivity = Date.now();
    this.startLivenessCheck(socket);

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      const hello = createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: this.opts.capabilities,
        deviceId: this.opts.deviceId,
        productId: this.opts.productId,
        runtimes: this.opts.runtimes,
        cursor: this.opts.getCursor?.(),
      });
      socket.send(encodeEnvelope(hello));
    });

    socket.on('ping', () => {
      this.lastActivity = Date.now();
    });

    socket.on('message', (data, isBinary) => {
      this.lastActivity = Date.now();
      const bytes = toBytes(data, isBinary);
      let envelope: Envelope;
      try {
        envelope = decodeEnvelope(bytes);
      } catch {
        return; // unparsable or unknown-type frame — ignore for forward-compat
      }
      if (envelope.type === 'conn.ack') {
        this.acked = true;
        this.everAckedThisAttempt = true;
        this.opts.onStateChange?.('open');
        this.flushOutbox();
        for (const waiter of this.ackWaiters.splice(0)) waiter.resolve();
        this.opts.onAcked?.();
      }
      this.opts.onEnvelope(envelope);
    });

    socket.on('close', () => {
      this.socket = undefined;
      this.stopLivenessCheck();
      this.opts.onStateChange?.('closed');
      const acked = this.everAckedThisAttempt;
      const status = this.lastUnexpectedStatus;
      this.lastUnexpectedStatus = undefined;
      this.opts.onConnectOutcome?.(acked, status !== undefined ? new WsUnexpectedStatusError(status) : undefined);
      if (!this.closedByUser && this.autoReconnect) this.scheduleReconnect();
    });

    // A 'close' event always follows 'error'/'unexpected-response' for ws
    // sockets; avoid an unhandled-error crash and let the close handler
    // drive reconnection/outcome reporting.
    socket.on('error', () => {});
    socket.on('unexpected-response', (_req, res) => {
      this.lastUnexpectedStatus = res.statusCode;
      res.resume(); // drain so the socket can close cleanly
      socket.terminate();
    });
  }

  private scheduleReconnect(): void {
    const { baseMs = 1000, maxMs = 30_000, factor = 2 } = this.opts.backoff ?? {};
    const delay = Math.min(maxMs, baseMs * factor ** this.reconnectAttempt);
    const jitter = delay * (0.8 + Math.random() * 0.4);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.openSocket(), jitter);
  }

  private startLivenessCheck(socket: WebSocket): void {
    const { timeoutMs = 75_000, checkIntervalMs = Math.max(1000, Math.floor(timeoutMs / 3)) } = this.opts.liveness ?? {};
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > timeoutMs) {
        // Force-close; the 'close' handler drives reconnection exactly as
        // it would for any other drop.
        socket.terminate();
      }
    }, checkIntervalMs);
    this.livenessTimer.unref?.();
  }

  private stopLivenessCheck(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
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
