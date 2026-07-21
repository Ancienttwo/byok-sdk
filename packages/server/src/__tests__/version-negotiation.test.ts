import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, type ConnAckPayload } from '@byok/protocol';
import { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { nextEnvelope, pairFakeDaemon, send, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';

/** Open an authenticated WS connection without sending `conn.hello` yet — mirrors `integration.test.ts`'s identical helper. */
async function openAuthedSocket(port: number, accessToken: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Mirrors `integration.test.ts`'s identical helper — resolves once `socket` actually closes, with its close code/reason. */
function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** Races `promise` against a generous timeout, proving whichever settles first — used below to demonstrate "clean failure, not a hang" with actual evidence rather than relying on the test runner's own global timeout to catch a hang implicitly. */
async function raceAgainstHang<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms — this would indicate a hang`)), timeoutMs)),
  ]);
}

/**
 * M4 Phase 4 version-negotiation drill, item 4 (behavioral half — see
 * `packages/protocol/src/__tests__/version-negotiation-drill.test.ts` for
 * the schema-level half and the full cross-reference). The REAL negotiation
 * decision lives in `ws-server.ts`'s handshake handler
 * (`payload.protocolVersions.includes(PROTOCOL_VERSION)`) — this drives that
 * exact code through a real WS connection against the real
 * `createByokServer`, never a reimplementation. `integration.test.ts`
 * already has one adjacent test (a single out-of-range sentinel version
 * rejected); this file adds the two scenarios the drill specifically names:
 * a daemon simulating "I can also speak a hypothetical newer minor version,
 * but still list today's v1 too" (overlap -> agrees on 1), and a genuinely
 * disjoint set (no overlap -> clean, typed failure, not a hang).
 */
describe('M4 Phase 4 version-negotiation drill, item 4 (behavioral): real WS handshake negotiation', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('daemon advertising [PROTOCOL_VERSION, PROTOCOL_VERSION+1] (overlapping today\'s server) is accepted and agrees on PROTOCOL_VERSION — conn.ack reports exactly that one resolved version', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    ws = await openAuthedSocket(started.port, accessToken);
    send(
      ws,
      createEnvelope('conn.hello', {
        // Simulates a forward-compatible daemon: it still lists today's real
        // PROTOCOL_VERSION, but ALSO advertises a hypothetical future one —
        // this must not confuse the server's "does the list include MY
        // version" check.
        protocolVersions: [PROTOCOL_VERSION, PROTOCOL_VERSION + 1],
        capabilities: [],
        deviceId,
        productId: PRODUCT_ID,
      }),
    );

    const ackEnvelope = await raceAgainstHang(nextEnvelope(ws), 2000);
    expect(ackEnvelope.type).toBe('conn.ack');
    if (ackEnvelope.type !== 'conn.ack') throw new Error('unreachable');
    const ack: ConnAckPayload = ackEnvelope.payload;
    expect(ack.protocolVersion).toBe(PROTOCOL_VERSION);

    // The connection is genuinely usable afterward — proof this was a real
    // negotiated success, not a fluke ack right before a close.
    expect(byok.machines.list().find((m) => m.deviceId === deviceId)?.connected).toBe(true);
  });

  it('daemon advertising a DISJOINT set ([PROTOCOL_VERSION+1, PROTOCOL_VERSION+2], no overlap with today\'s server) gets a clean, typed 1002 close — proven to happen promptly, not to hang', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    ws = await openAuthedSocket(started.port, accessToken);
    const closed = waitForClose(ws);
    send(
      ws,
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION + 1, PROTOCOL_VERSION + 2],
        capabilities: [],
        deviceId,
        productId: PRODUCT_ID,
      }),
    );

    // Racing this against a generous timeout is the actual "not a hang"
    // evidence: a genuine hang would make this reject with the timeout
    // error below, not silently pass by virtue of the suite's own global
    // timeout eventually firing.
    const { code: closeCode, reason } = await raceAgainstHang(closed, 2000);
    expect(closeCode).toBe(1002);
    expect(reason).toMatch(/protocol version/i);

    // The device was never marked connected — a clean, complete rejection,
    // not a half-open connection left dangling.
    expect(byok.machines.list().find((m) => m.deviceId === deviceId)?.connected).toBe(false);
  });
});
