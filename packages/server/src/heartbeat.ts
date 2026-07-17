/**
 * WS-native ping/pong liveness check (pinned here per the M1-2 task brief,
 * not in docs/protocol.md — this is a server implementation detail, not a
 * wire message). The server pings every `intervalMs` (default 30s);
 * `ws`'s WebSocket automatically replies to a protocol-level ping with a
 * protocol-level pong on any spec-compliant peer, so a healthy connection
 * just keeps ticking. After `maxMissedPongs` (default 2) consecutive
 * unanswered pings, the connection is terminated.
 *
 * Deliberately decoupled from the real `ws` package's `WebSocket` type (only
 * the four methods below are used) so the scheduling logic can be unit
 * tested with a plain stub + fake timers instead of a real socket — a real
 * peer auto-pongs, so there's no way to exercise "missed pong" through an
 * actual WS round-trip in a test.
 */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
  off(event: 'pong', listener: () => void): unknown;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  maxMissedPongs?: number;
}

export interface Heartbeat {
  /** Stop the ping timer and detach the pong listener (e.g. on normal connection close). */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MISSED_PONGS = 2;

export function startHeartbeat(ws: HeartbeatSocket, opts: HeartbeatOptions = {}): Heartbeat {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxMissedPongs = opts.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS;

  let awaitingPong = false;
  let missed = 0;

  const onPong = () => {
    awaitingPong = false;
    missed = 0;
  };
  ws.on('pong', onPong);

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (awaitingPong) {
      missed++;
      if (missed >= maxMissedPongs) {
        clearInterval(timer);
        ws.terminate();
        return;
      }
    }
    awaitingPong = true;
    ws.ping();
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
      ws.off('pong', onPong);
    },
  };
}
