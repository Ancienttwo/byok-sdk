import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import {
  createByokServer,
  type ByokServer,
  type CreateByokServerOptions,
  type ServerTaskEvent,
  type TaskHandle,
} from '@byok/server';

/**
 * Boots the REAL `@byok/server` reference implementation (not the
 * lightweight `TestServer` stub the rest of this package's tests use) on an
 * ephemeral loopback port, for the small set of tests that specifically
 * need genuine cross-package client<->server behavior rather than a
 * hand-rolled approximation of it — e.g. finding F2 (redelivery ordering
 * depends on the real server's exact `conn.ack`-before-backlog sequencing)
 * and finding F5 (a fresh `deviceId` per `/byok/pair` call is the real
 * server's actual behavior, which the client-side `TestServer` stub
 * deliberately does not reproduce — see its own doc comment).
 */
export interface RealServerHandle {
  byok: ByokServer;
  httpServer: HttpServer;
  url: string;
  close(): Promise<void>;
}

/**
 * `Node.Server.close()` alone waits for every still-open connection to end
 * before its callback fires — including a long-poll `GET /byok/events` the
 * real server (by design) holds open for up to `longPollHoldMs` (~50s
 * default) waiting for events that, at test teardown time, are never
 * coming. `closeAllConnections()` (Node >=18.2) forcibly ends those so
 * teardown does not hang for the remainder of a long-poll hold — tests that
 * exercise long-poll should also pass a short `longPollHoldMs` themselves
 * (see finding F6's test) so any *mid-test* wait stays short too, but this
 * is the backstop for teardown regardless.
 */
function closeServer(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections?.();
  });
}

export async function startRealServer(opts: CreateByokServerOptions): Promise<RealServerHandle> {
  const byok = createByokServer(opts);
  return new Promise((resolve) => {
    const httpServer = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => {
      byok.attachWebSocket(httpServer as HttpServer);
      resolve({
        byok,
        httpServer: httpServer as HttpServer,
        url: `http://127.0.0.1:${info.port}`,
        close: () => closeServer(httpServer as HttpServer),
      });
    });
  });
}

/**
 * Same as {@link startRealServer}, but deliberately never wires up the WS
 * upgrade — used for finding F6's "long-poll only, WS never connects" test.
 * Any WS upgrade attempt against this server gets Node's default behavior
 * for an unhandled 'upgrade' event (the raw socket is destroyed), which is a
 * genuine, real WS failure — not a simulated one — so the daemon's normal
 * `wsFailureThreshold` fallback logic drives it into long-poll mode exactly
 * as it would against a real deployment with no reachable WS endpoint.
 */
export async function startRealServerWithoutWebSocket(opts: CreateByokServerOptions): Promise<RealServerHandle> {
  const byok = createByokServer(opts);
  return new Promise((resolve) => {
    const httpServer = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => {
      resolve({
        byok,
        httpServer: httpServer as HttpServer,
        url: `http://127.0.0.1:${info.port}`,
        close: () => closeServer(httpServer as HttpServer),
      });
    });
  });
}

/** Wait for `handle.events()` to produce an event matching `predicate` (mirrors `packages/server`'s own test-support helper, which isn't importable across the package boundary). */
export async function waitForTaskEvent(
  handle: TaskHandle,
  predicate: (event: ServerTaskEvent) => boolean,
): Promise<ServerTaskEvent> {
  for await (const event of handle.events()) {
    if (predicate(event)) return event;
  }
  throw new Error('task event stream ended before a matching event was seen');
}
