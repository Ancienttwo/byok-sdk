import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import {
  createByokServer,
  type ByokServer,
  type CreateByokServerOptions,
  type PairingCodeInfo,
  type ServerTaskEvent,
  type TaskHandle,
} from '@byok-sdk/server';

/**
 * Boots the REAL `@byok-sdk/server` reference implementation (not the
 * lightweight `TestServer` stub the rest of this package's tests use) on an
 * ephemeral loopback port, for the small set of tests that specifically
 * need genuine cross-package client<->server behavior rather than a
 * hand-rolled approximation of it — e.g. finding F2 (redelivery depends on
 * the real server's exact mailbox cursor semantics) and finding F5 (a fresh
 * `deviceId` per `/byok/pair` call is the real server's actual behavior,
 * which the client-side `TestServer` stub deliberately does not reproduce —
 * see its own doc comment).
 *
 * WP3B Step 2: `@byok-sdk/server` is now a façade over `@byok-sdk/cloud` and
 * serves `GET /byok/events` + `POST /byok/messages` and nothing else — there
 * is no WebSocket upgrade handler anywhere in the package any more, so there
 * is exactly ONE start mode here (this one) rather than the three the WS era
 * needed (eager-WS / never-WS / deferred-WS). A daemon pointed at this server
 * therefore reaches long-poll through its own ordinary `wsFailureThreshold`
 * fallback: its WS upgrade attempt gets Node's default behavior for an
 * unhandled `'upgrade'` event (the raw socket is destroyed), which is a
 * genuine, real WS failure — not a simulated one — exactly as it would be
 * against a real deployment with no reachable WS endpoint.
 */
/**
 * The one address these fixtures both bind and dial. Passing it as `hostname`
 * matters: without it Node binds the IPv6 wildcard `::`, which coexists with a
 * foreign process already holding the more specific `127.0.0.1:<port>`, so the
 * drawn ephemeral port can be answered by that stranger instead of by byok.
 * Binding the address we dial turns a collision into a loud `EADDRINUSE`.
 */
const LOOPBACK = '127.0.0.1';

export interface RealServerHandle {
  byok: ByokServer;
  httpServer: HttpServer;
  url: string;
  /**
   * Mint a single-use pairing code for the SAME `productId` this server
   * instance was started with (S1). Bound to the handle rather than left to
   * each call site so a test can't accidentally pair a device into a product
   * its own `conn.hello` then contradicts — the kernel's hello gate compares
   * the announced product against this instance's `instanceProductId`.
   *
   * The tenant is no longer named here: an embedded server derives exactly one
   * tenant from its `productId` (`serverTenantId`, `packages/server/src/stores.ts`),
   * so `createPairingCode` takes the product alone — and is async, like every
   * other kernel-backed member of this surface.
   */
  createPairingCode(): Promise<PairingCodeInfo>;
  close(): Promise<void>;
}

/**
 * `Node.Server.close()` alone waits for every still-open connection to end
 * before its callback fires — including a long-poll `GET /byok/events` the
 * real server (by design) holds open for up to `longPollHoldMs` (~50s
 * default) waiting for events that, at test teardown time, are never
 * coming. `closeAllConnections()` (Node >=18.2) forcibly ends those so
 * teardown does not hang for the remainder of a long-poll hold — tests should
 * also pass a short `longPollHoldMs` themselves so any *mid-test* wait stays
 * short too, but this is the backstop for teardown regardless.
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
    const httpServer = serve({ fetch: byok.hono.fetch, port: 0, hostname: LOOPBACK }, (info) => {
      resolve({
        byok,
        httpServer: httpServer as HttpServer,
        url: `http://${LOOPBACK}:${info.port}`,
        createPairingCode: () => byok.pairing.createPairingCode({ productId: opts.productId }),
        close: async () => {
          // Releases the relay's per-task feeds and their reclamation timers
          // before the socket goes away, so nothing outlives the test file.
          byok.stop();
          await closeServer(httpServer as HttpServer);
        },
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
