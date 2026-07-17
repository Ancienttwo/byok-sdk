import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat, type HeartbeatSocket } from '../heartbeat';

/**
 * A real `ws.WebSocket` peer automatically replies to a protocol-level ping
 * with a protocol-level pong (RFC 6455) — there is no way to make a real
 * socket "miss" a pong from application code. So we exercise the scheduling
 * logic directly against a minimal stub + fake timers, which is exactly
 * what {@link HeartbeatSocket} exists to make possible.
 */
function createFakeSocket() {
  const pongListeners: Array<() => void> = [];
  const socket: HeartbeatSocket = {
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((_event: 'pong', listener: () => void) => {
      pongListeners.push(listener);
    }),
    off: vi.fn((_event: 'pong', listener: () => void) => {
      const idx = pongListeners.indexOf(listener);
      if (idx >= 0) pongListeners.splice(idx, 1);
    }),
  };
  return {
    socket,
    emitPong(): void {
      for (const listener of [...pongListeners]) listener();
    },
  };
}

describe('startHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings on each interval and never terminates while pongs keep arriving', () => {
    vi.useFakeTimers();
    const { socket, emitPong } = createFakeSocket();
    const heartbeat = startHeartbeat(socket, { intervalMs: 1000, maxMissedPongs: 2 });

    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(1000);
      expect(socket.ping).toHaveBeenCalledTimes(i);
      emitPong();
    }
    expect(socket.terminate).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it('terminates the connection after maxMissedPongs consecutive unanswered pings', () => {
    vi.useFakeTimers();
    const { socket } = createFakeSocket(); // never emits a pong
    startHeartbeat(socket, { intervalMs: 1000, maxMissedPongs: 2 });

    vi.advanceTimersByTime(1000); // ping #1
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // ping #1 went unanswered (missed=1) -> ping #2
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // ping #2 also unanswered (missed=2) -> terminate, no ping #3
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.ping).toHaveBeenCalledTimes(2);
  });

  it('a pong resets the missed-pong counter', () => {
    vi.useFakeTimers();
    const { socket, emitPong } = createFakeSocket();
    startHeartbeat(socket, { intervalMs: 1000, maxMissedPongs: 2 });

    vi.advanceTimersByTime(1000); // ping #1, unanswered so far
    vi.advanceTimersByTime(1000); // missed=1, ping #2
    emitPong(); // answers ping #2 -> missed resets to 0

    vi.advanceTimersByTime(1000); // ping #3, unanswered
    vi.advanceTimersByTime(1000); // missed=1 (not 2 — the earlier miss was forgiven by the pong), ping #4
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('stop() clears the timer and detaches the pong listener', () => {
    vi.useFakeTimers();
    const { socket } = createFakeSocket();
    const heartbeat = startHeartbeat(socket, { intervalMs: 1000 });

    heartbeat.stop();
    vi.advanceTimersByTime(10_000);

    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.off).toHaveBeenCalled();
  });
});
