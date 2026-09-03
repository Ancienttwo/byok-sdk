import type { Server as HttpServer } from 'node:http';
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { serve } from '@hono/node-server';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type ConnAckPayload,
  type Envelope,
  type EventsPollResponse,
  type RuntimeCapabilities,
  type RuntimeId,
  type RuntimeInfo,
  type ToolsetId,
} from '@byok-sdk/protocol';
import { WebSocket, type RawData } from 'ws';
import { NONCE_SIGNING_DOMAIN } from '../auth';
import type { ByokServer, ByokServerEvent, PairingCodeClaims, ServerTaskEvent, TaskHandle } from '../index';

/**
 * Start `byok.hono` on an ephemeral port and wire up its WS upgrade.
 *
 * `hostname` is pinned to the same `127.0.0.1` the returned `baseUrl` (and
 * every WS url below) dials. Without it Node binds the IPv6 wildcard `::`,
 * which coexists with a foreign process already holding the more specific
 * `127.0.0.1:<port>` — so the drawn port can be answered by that stranger and
 * tests fail with whatever it replies (an intermittent
 * `pairing failed: 401 Unauthorized`). Binding the address we dial turns a
 * collision into a loud `EADDRINUSE`. See `port-shadowing.test.ts`.
 */
export async function startServer(
  byok: ByokServer,
): Promise<{ server: HttpServer; port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: byok.hono.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      byok.attachWebSocket(server as HttpServer);
      resolve({ server: server as HttpServer, port: info.port, baseUrl: `http://127.0.0.1:${info.port}` });
    });
  });
}

/**
 * Close a fixture server, dropping lingering client connections first.
 *
 * `closeAllConnections()` is load-bearing, not tidiness: a route that answers
 * before reading the request body — every `authenticateBearer` 401
 * short-circuits ahead of `readJsonBody` — leaves a rejected POST's body
 * unread, and under bun's `node:http` such a connection is never counted idle
 * again, so `close()`'s callback never fires and the suite dies on a hook
 * timeout. Node/undici drains the same socket, which is why this is invisible
 * under vitest. Probed with the pin isolated: a rejected GET (no body) and a
 * 401 whose body IS read both close in 0ms, `Connection: close` does not help,
 * and only the unread body pins the socket.
 */
export async function stopServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function toEnvelope(data: RawData): Envelope {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    return decodeEnvelope(data);
  } else if (Buffer.isBuffer(data)) {
    bytes = data;
  } else if (Array.isArray(data)) {
    bytes = Buffer.concat(data);
  } else {
    bytes = new Uint8Array(data);
  }
  return decodeEnvelope(bytes);
}

interface SocketQueueState {
  buffer: Envelope[];
  waiters: Array<{ resolve: (env: Envelope) => void; reject: (err: Error) => void }>;
  closed: boolean;
  closeError?: Error;
}

// Keyed per-socket so back-to-back sends (e.g. the server's conn.ack
// immediately followed by a redelivered envelope, both written within the
// same synchronous handler and often arriving in the same TCP read chunk)
// are buffered instead of dropped. A naive `ws.once('message', ...)` per
// call would lose the second frame if it fires before the *next* call
// attaches its listener — a real race, not a hypothetical one.
const socketQueues = new WeakMap<WebSocket, SocketQueueState>();

function getSocketQueue(ws: WebSocket): SocketQueueState {
  let state = socketQueues.get(ws);
  if (state) return state;

  state = { buffer: [], waiters: [], closed: false };
  socketQueues.set(ws, state);

  const fail = (err: Error) => {
    state!.closed = true;
    state!.closeError = err;
    for (const waiter of state!.waiters.splice(0)) waiter.reject(err);
  };

  ws.on('message', (data: RawData) => {
    let envelope: Envelope;
    try {
      envelope = toEnvelope(data);
    } catch (err) {
      const waiter = state!.waiters.shift();
      if (waiter) waiter.reject(err as Error);
      return;
    }
    const waiter = state!.waiters.shift();
    if (waiter) {
      waiter.resolve(envelope);
    } else {
      state!.buffer.push(envelope);
    }
  });
  ws.on('close', () => fail(new Error('ws closed before expected message')));
  ws.on('error', (err: Error) => fail(err));

  return state;
}

/** Wait for the next envelope on `ws` (rejects if the socket errors/closes first). Buffers ahead-of-time arrivals — see {@link getSocketQueue}. */
export function nextEnvelope(ws: WebSocket): Promise<Envelope> {
  const state = getSocketQueue(ws);
  if (state.buffer.length > 0) {
    return Promise.resolve(state.buffer.shift()!);
  }
  if (state.closed) {
    return Promise.reject(state.closeError ?? new Error('ws closed before expected message'));
  }
  return new Promise((resolve, reject) => {
    state.waiters.push({ resolve, reject });
  });
}

export function send(ws: WebSocket, envelope: Envelope): void {
  ws.send(encodeEnvelope(envelope));
}

/**
 * S0 (GAP-002): honest `conn.hello` runtime fixtures — each block is exactly
 * what the corresponding real adapter's `capabilities()` returns
 * (`packages/client/src/adapters/{pi,claude,codex}`), so a server test
 * describes a device that could actually exist rather than a convenient one.
 *
 * The asymmetry these encode is the whole reason the server's steer gate
 * exists: only pi implements steering. Claude's and Codex's adapters throw on
 * an inbound `task.steer`, so a server that sends them one stalls the client's
 * redelivery cursor forever. Any test needing a steerable task must claim
 * `pi`; anything else is expected to be refused server-side.
 */
export const PI_RUNTIME_INFO: RuntimeInfo = {
  id: 'pi',
  capabilities: { steer: true, resume: true, approvalInteractive: false, permissionModes: ['auto', 'readonly'] },
};

export const CLAUDE_RUNTIME_INFO: RuntimeInfo = {
  id: 'claude',
  capabilities: {
    steer: false,
    resume: true,
    approvalInteractive: true,
    permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
  },
};

export const CODEX_RUNTIME_INFO: RuntimeInfo = {
  id: 'codex',
  capabilities: { steer: false, resume: true, approvalInteractive: false, permissionModes: ['auto', 'readonly'] },
};

/**
 * S1: the tenant every fixture-paired device lands in unless a test names its
 * own. Tests that care about isolation (`tenant-pairing-isolation.test.ts`)
 * mint their own claims for a SECOND tenant; everything else just needs a
 * device to exist somewhere, and this is that somewhere.
 */
export const TEST_TENANT_ID = 'tenant-test';

/**
 * The claims a fixture-minted pairing code carries. `productId` is a
 * parameter rather than a constant because it must agree with the server
 * instance under test (`createByokServer({ productId })`) AND with the
 * `conn.hello.productId` the fake daemon announces — the S1 hello gate
 * compares the announced product against the DEVICE ROW, so a fixture that
 * quietly defaulted it would make every hello a coin flip.
 */
export function testPairingClaims(productId: string): PairingCodeClaims {
  return { tenantId: TEST_TENANT_ID, productId };
}

/** A fake device's Ed25519 identity (Auth v2, §6) — the private key never leaves this helper, mirroring the real daemon. */
export interface FakeDeviceIdentity {
  publicKeyBase64Url: string;
  /**
   * Sign arbitrary bytes with no domain tag. Real daemons never do this — it
   * exists so a test can produce the pre-S1 raw-nonce signature the server
   * must now reject (`tenant-pairing-isolation.test.ts`).
   */
  sign(message: string): string;
  /** What a real daemon does (S1): sign `byok-nonce-v1\n` + nonce — see `packages/client/src/daemon/device-keys.ts`. */
  signNonce(nonce: string): string;
}

export function generateFakeDeviceIdentity(): FakeDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const sign = (message: string) => signEd25519(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url');
  return {
    publicKeyBase64Url: jwk.x,
    sign,
    signNonce: (nonce: string) => sign(NONCE_SIGNING_DOMAIN + nonce),
  };
}

/**
 * Redeem a pairing code via `POST /byok/pair` (Auth v2, §6.1) and return the
 * minted identity. `pairingCode` must come from
 * `byok.pairing.createPairingCode()` (the SaaS side of the pairing flow).
 */
export async function pairFakeDaemon(
  baseUrl: string,
  pairingCode: string,
  opts: { deviceName?: string; identity?: FakeDeviceIdentity } = {},
): Promise<{ deviceId: string; accessToken: string; identity: FakeDeviceIdentity }> {
  const identity = opts.identity ?? generateFakeDeviceIdentity();
  const pairRes = await fetch(`${baseUrl}/byok/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode,
      deviceName: opts.deviceName ?? 'test-laptop',
      devicePublicKey: identity.publicKeyBase64Url,
    }),
  });
  if (!pairRes.ok) {
    throw new Error(`pairing failed: ${pairRes.status} ${await pairRes.text()}`);
  }
  const { deviceId, accessToken } = (await pairRes.json()) as { deviceId: string; accessToken: string };
  return { deviceId, accessToken, identity };
}

/**
 * Open a WS connection for an already-paired device and complete the
 * `conn.hello` -> `conn.ack` handshake. Split out from {@link connectFakeDaemon}
 * so reconnect/redelivery tests can reuse the same deviceId+accessToken
 * across multiple connections instead of re-pairing.
 */
export async function connectFakeDaemonWs(
  port: number,
  opts: {
    deviceId: string;
    accessToken: string;
    productId: string;
    clientVersion?: string;
    capabilities?: string[];
    runtimes?: RuntimeInfo[];
    configuredToolsets?: ToolsetId[];
    cursor?: number;
  },
): Promise<{ ws: WebSocket; ack: ConnAckPayload }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, {
    headers: { authorization: `Bearer ${opts.accessToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  send(
    ws,
    createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: opts.capabilities ?? [],
      deviceId: opts.deviceId,
      productId: opts.productId,
      clientVersion: opts.clientVersion,
      runtimes: opts.runtimes,
      configuredToolsets: opts.configuredToolsets,
      cursor: opts.cursor,
    }),
  );
  const ackEnvelope = await nextEnvelope(ws);
  if (ackEnvelope.type !== 'conn.ack') {
    throw new Error(`expected conn.ack, got ${ackEnvelope.type}`);
  }

  return { ws, ack: ackEnvelope.payload };
}

/**
 * Pair a new fake daemon via `POST /byok/pair`, then connect over WS and
 * complete the `conn.hello` -> `conn.ack` handshake. `pairingCode` must come
 * from `byok.pairing.createPairingCode()` (the SaaS side of the pairing flow).
 */
export async function connectFakeDaemon(
  baseUrl: string,
  port: number,
  pairingCode: string,
  opts: {
    deviceName?: string;
    productId: string;
    clientVersion?: string;
    capabilities?: string[];
    runtimes?: RuntimeInfo[];
    configuredToolsets?: ToolsetId[];
    cursor?: number;
    identity?: FakeDeviceIdentity;
  },
): Promise<{
  ws: WebSocket;
  deviceId: string;
  accessToken: string;
  identity: FakeDeviceIdentity;
  ack: ConnAckPayload;
}> {
  const { deviceId, accessToken, identity } = await pairFakeDaemon(baseUrl, pairingCode, opts);
  const { ws, ack } = await connectFakeDaemonWs(port, {
    deviceId,
    accessToken,
    productId: opts.productId,
    clientVersion: opts.clientVersion,
    capabilities: opts.capabilities,
    runtimes: opts.runtimes,
    configuredToolsets: opts.configuredToolsets,
    cursor: opts.cursor,
  });
  return { ws, deviceId, accessToken, identity, ack };
}

/**
 * Wait for `handle.events()` to produce an event matching `predicate`. Used
 * instead of an arbitrary `setTimeout` to synchronize with server-side
 * processing of a frame the test just sent over the fake daemon's WS —
 * `events()` only emits once the hub has actually applied the corresponding
 * state change, so this can't race the real (async, loopback-socket)
 * message delivery the way a fixed sleep would.
 */
export async function waitForTaskEvent(
  handle: TaskHandle,
  predicate: (event: ServerTaskEvent) => boolean,
): Promise<ServerTaskEvent> {
  for await (const event of handle.events()) {
    if (predicate(event)) return event;
  }
  throw new Error('task event stream ended before a matching event was seen');
}

/**
 * Wait for `byok.events.subscribe()` (the hub-level {@link ByokServerEvent}
 * feed — cross-task, e.g. device connect/disconnect, task creation/state
 * changes) to produce an event matching `predicate`. Mirrors
 * {@link waitForTaskEvent} exactly, one level up: {@link AsyncEventQueue}
 * (`event-queue.ts`) backs both, and always replays from the start of its
 * buffer, so calling this AFTER the triggering action already happened is
 * safe — it isn't a race against a live push. Unlike the per-task feed, this
 * one never closes (it's a long-lived, whole-hub feed) — only call this when
 * `predicate` is expected to actually be satisfied; a predicate that never
 * matches hangs forever rather than timing out.
 */
export async function waitForServerEvent(
  byok: ByokServer,
  predicate: (event: ByokServerEvent) => boolean,
): Promise<ByokServerEvent> {
  for await (const event of byok.events.subscribe()) {
    if (predicate(event)) return event;
  }
  throw new Error('server event stream ended before a matching event was seen');
}

/**
 * Claim + start a dispatched task over `ws` (Offered -> Claimed -> Running)
 * and wait for the Running event. Shared by every hub-level test that needs a
 * task actually running before driving it further (approve/reject,
 * implicit-approval-resume, etc).
 *
 * `runtime` (S0, GAP-002): the ACTUAL adapter this claim reports.
 * `capabilities` (S0/D-4): that adapter's own capability self-report, which is
 * the ONLY input the server's steer gate reads — the connection's `conn.hello`
 * runtimes are discovery and feed nothing here. Both omitted matches a legacy
 * daemon's `task.claim` — which is exactly what every pre-S0 call site here
 * already did, so their behavior is unchanged. Pass them (see
 * {@link PI_RUNTIME_INFO}'s `capabilities`) when the test needs the server to
 * have a claim-time capability snapshot to gate on.
 */
export async function claimAndStart(
  ws: WebSocket,
  deviceId: string,
  handle: TaskHandle,
  runtime?: RuntimeId,
  capabilities?: RuntimeCapabilities,
): Promise<void> {
  send(ws, createEnvelope('task.claim', { deviceId, runtime, capabilities }, { taskId: handle.taskId }));
  send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
}

/**
 * Drives a task to AwaitApproval over `ws` and waits for the server to
 * actually apply it. Shared by every hub-level test that needs a task
 * parked in AwaitApproval (approve/reject, implicit-approval-resume, etc).
 *
 * `approvalId` (M5, approval targeting): optional — omitted entirely
 * matches every pre-M5 call site's behavior (a legacy daemon that never
 * reports one); passed through verbatim when a test needs the server to
 * have recorded a specific `pendingApprovalId` for the task.
 */
export async function moveToAwaitApproval(
  ws: WebSocket,
  handle: TaskHandle,
  summary = 'needs a human ok',
  approvalId?: string,
): Promise<void> {
  send(ws, createEnvelope('task.await_approval', { summary, approvalId }, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'AwaitApproval');
}

/**
 * WP3B Step 0 (characterization): a fake daemon that speaks the long-poll
 * transport (§8) and NOTHING else — `POST /byok/pair` -> `POST
 * /byok/challenge` -> `POST /byok/token` -> `GET /byok/events` for inbound,
 * `POST /byok/messages` for outbound. No WebSocket is ever constructed here,
 * which is the whole point: it is the transport the server keeps after
 * `attachWebSocket` is deleted, so a behaviour pin written against this
 * fixture survives the fold unchanged.
 *
 * Split of responsibilities against the two WS fixtures above:
 * {@link pairFakeDaemon} still owns the `/byok/pair` half (reused verbatim);
 * the challenge/token renewal that {@link connectFakeDaemonWs} never needed
 * (a WS device dials with its pairing token) happens here because the
 * long-poll path is the one a real daemon renews on. The returned
 * `accessToken` is the RENEWED one, not the pairing response's.
 *
 * Cursor discipline (deliberate, and the reason `next`/`replay` are two
 * methods rather than one): the server's `EventsPollResponse.cursor` is the
 * highest `seq` it has ASSIGNED to this device, which can run ahead of the
 * page it just handed back (`collectRelevant` filters terminal-task
 * entries). `next()` takes that value as the device's new ack point, exactly
 * as a real daemon does. `replay(cursor)` deliberately does NOT touch the
 * fixture's own cursor and hands back the raw `Response`, so a test can
 * re-read an arbitrary point of the retained tail and inspect a 409
 * `cursor_too_old` body rather than having it thrown away.
 */
export interface FakeLongPollDaemon {
  readonly deviceId: string;
  /** The token minted by `POST /byok/token` (the renewal), not the one `POST /byok/pair` returned. */
  readonly accessToken: string;
  /** Highest server `seq` this fake daemon has acked so far — `0` until the first {@link next}. */
  cursor(): number;
  /** One long-poll round trip at the current cursor, advancing it from the response. Throws on any non-200. */
  next(): Promise<Envelope[]>;
  /** Raw `GET /byok/events?cursor=<cursor>` at an EXPLICIT cursor; never advances this fixture's cursor. */
  replay(cursor: number): Promise<Response>;
  /** `POST /byok/messages` carrying exactly one envelope. */
  send(envelope: Envelope): Promise<Response>;
}

export interface FakeLongPollDaemonOptions {
  productId: string;
  deviceName?: string;
  identity?: FakeDeviceIdentity;
  clientVersion?: string;
  /** Connection-level capability flags, published in `conn.hello` exactly like {@link connectFakeDaemonWs}'s. */
  capabilities?: string[];
  /** Connection-level runtime discovery block — see {@link PI_RUNTIME_INFO} and friends. */
  runtimes?: RuntimeInfo[];
  configuredToolsets?: ToolsetId[];
  /**
   * Publish the `conn.hello` snapshot over `POST /byok/messages` (the
   * long-poll equivalent of the WS handshake, and the admission authority
   * for connection-scoped features). Default `true`. Set `false` for a
   * device that only ever polls — it still counts as connected, because
   * `GET /byok/events` alone registers presence.
   */
  announce?: boolean;
}

export async function connectFakeDaemonLongPoll(
  baseUrl: string,
  byok: ByokServer,
  opts: FakeLongPollDaemonOptions,
): Promise<FakeLongPollDaemon> {
  const { code } = byok.pairing.createPairingCode(testPairingClaims(opts.productId));
  const { deviceId, identity } = await pairFakeDaemon(baseUrl, code, {
    deviceName: opts.deviceName,
    identity: opts.identity,
  });

  const challengeRes = await fetch(`${baseUrl}/byok/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (!challengeRes.ok) {
    throw new Error(`challenge failed: ${challengeRes.status} ${await challengeRes.text()}`);
  }
  const { nonce } = (await challengeRes.json()) as { nonce: string };

  const tokenRes = await fetch(`${baseUrl}/byok/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, nonce, signature: identity.signNonce(nonce) }),
  });
  if (!tokenRes.ok) {
    throw new Error(`token renewal failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { accessToken } = (await tokenRes.json()) as { accessToken: string };

  let cursor = 0;

  const send = (envelope: Envelope): Promise<Response> =>
    fetch(`${baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messages: [envelope] }),
    });

  const replay = (at: number): Promise<Response> =>
    fetch(`${baseUrl}/byok/events?cursor=${String(at)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

  if (opts.announce !== false) {
    const helloRes = await send(
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: opts.capabilities ?? [],
        deviceId,
        productId: opts.productId,
        clientVersion: opts.clientVersion,
        runtimes: opts.runtimes,
        configuredToolsets: opts.configuredToolsets,
      }),
    );
    if (!helloRes.ok) {
      throw new Error(`conn.hello publish failed: ${helloRes.status} ${await helloRes.text()}`);
    }
    const helloBody = (await helloRes.json()) as { accepted: number; rejected?: number };
    if (helloBody.accepted !== 1) {
      throw new Error(`conn.hello was not accepted: ${JSON.stringify(helloBody)}`);
    }
  }

  return {
    deviceId,
    accessToken,
    cursor: () => cursor,
    async next(): Promise<Envelope[]> {
      const res = await replay(cursor);
      if (res.status !== 200) {
        throw new Error(`long-poll failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as EventsPollResponse;
      cursor = body.cursor;
      return body.events;
    },
    replay,
    send,
  };
}
