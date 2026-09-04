import type { Server as HttpServer } from 'node:http';
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { serve } from '@hono/node-server';
import {
  createEnvelope,
  PROTOCOL_VERSION,
  type Envelope,
  type EventsPollResponse,
  type RuntimeCapabilities,
  type RuntimeId,
  type RuntimeInfo,
  type ToolsetId,
} from '@byok-sdk/protocol';
import { NONCE_SIGNING_DOMAIN, tenantId as brandTenantId, type TenantId } from '@byok-sdk/cloud';
import { expect } from 'vitest';
import type {
  ByokServer,
  ByokServerEvent,
  CreatePairingCodeInput,
  ServerTaskEvent,
  TaskHandle,
} from '../index';

/**
 * Start `byok.hono` on an ephemeral port.
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
 * The input a fixture-minted pairing code carries.
 *
 * The TENANT is no longer a parameter: an embedded `createByokServer` serves
 * exactly one tenant, derived from its own `productId` (`stores.ts`'s
 * `serverTenantId`), so a fixture cannot name one. `productId` stays a
 * parameter because it must agree with the server instance under test
 * (`createByokServer({ productId })`) AND with the `conn.hello.productId` the
 * fake daemon announces — the hello gate compares the announced product
 * against the DEVICE ROW, so a fixture that quietly defaulted it would make
 * every hello a coin flip.
 */
export function testPairingClaims(productId: string): CreatePairingCodeInput {
  return { productId };
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
): Promise<{ deviceId: string; accessToken: string; identity: FakeDeviceIdentity; tenantId: TenantId }> {
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
  const body = (await pairRes.json()) as { deviceId: string; accessToken: string; tenantId: string };
  // The ENROLLMENT's own tenant, straight off the pair response — the only
  // public way to learn the one tenant an embedded server serves, and therefore
  // the only legal input to `byok.devices.revoke`. Deliberately not re-derived
  // from `productId` here: that derivation is the façade's, and a fixture
  // copying it would be a second authority for the same datum.
  return { deviceId: body.deviceId, accessToken: body.accessToken, identity, tenantId: brandTenantId(body.tenantId) };
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
 * WP3B Step 0 (characterization): a fake daemon that speaks the long-poll
 * transport (§8) and NOTHING else — `POST /byok/pair` -> `POST
 * /byok/challenge` -> `POST /byok/token` -> `GET /byok/events` for inbound,
 * `POST /byok/messages` for outbound. As of WP3B Step 2b it is the ONLY
 * fixture in this package: the WebSocket transport and its two fixtures are
 * deleted, so nothing here can construct a socket even by accident.
 *
 * {@link pairFakeDaemon} still owns the `/byok/pair` half. The challenge/token
 * renewal happens here rather than there because the long-poll path is the one
 * a real daemon renews on; the returned `accessToken` is the RENEWED one, not
 * the pairing response's.
 *
 * Cursor discipline (deliberate, and the reason `next`/`replay` are two
 * methods rather than one): the server's `EventsPollResponse.cursor` is the
 * highest `seq` it has handed this device, which can run ahead of the page it
 * just returned (the kernel scans past filtered cancelled offers). `next()`
 * takes that value as the device's new ack point, exactly as a real daemon
 * does — and, exactly as for a real daemon, the ack only lands when the NEXT
 * poll carries it. `replay(cursor)` deliberately does NOT touch the fixture's
 * own cursor and hands back the raw `Response`, so a test can re-read an
 * arbitrary point of the retained window and inspect a 409 `cursor_too_old`
 * body rather than having it thrown away.
 */
export interface FakeLongPollDaemon {
  readonly deviceId: string;
  /** The enrollment's tenant, as the `POST /byok/pair` response reported it. */
  readonly tenantId: TenantId;
  /** The device's own signing identity, so a test can re-sign a later challenge. */
  readonly identity: FakeDeviceIdentity;
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
  /** Connection-level capability flags, published in the `conn.hello` this fixture posts. */
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
  const { code } = await byok.pairing.createPairingCode(testPairingClaims(opts.productId));
  const { deviceId, identity, tenantId } = await pairFakeDaemon(baseUrl, code, {
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
    tenantId,
    identity,
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

/**
 * Re-publish `conn.hello` on an already-connected fake daemon.
 *
 * The long-poll equivalent of "the same device reconnects and announces a
 * different runtime set": there is no socket to drop, so a fresh announcement
 * IS the reconnect. `DeviceConnections.announce` replaces the discovery block
 * wholesale (`connections.ts`), which is exactly what a restarted daemon does.
 */
export async function announceHello(
  daemon: FakeLongPollDaemon,
  opts: {
    productId: string;
    capabilities?: string[];
    runtimes?: RuntimeInfo[];
    clientVersion?: string;
    configuredToolsets?: ToolsetId[];
  },
): Promise<void> {
  const res = await daemon.send(
    createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: opts.capabilities ?? [],
      deviceId: daemon.deviceId,
      productId: opts.productId,
      clientVersion: opts.clientVersion,
      runtimes: opts.runtimes,
      configuredToolsets: opts.configuredToolsets,
    }),
  );
  if (!res.ok) throw new Error(`conn.hello re-publish failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { accepted: number };
  if (body.accepted !== 1) throw new Error(`conn.hello was not accepted: ${JSON.stringify(body)}`);
}

/**
 * `POST /byok/messages` carrying exactly one envelope, decoded.
 *
 * The response IS the barrier: the kernel applies an accepted envelope inside
 * the request, so an awaited send is itself the synchronization point for every
 * state change it caused. Nothing in this file ever sleeps to "let the server
 * catch up".
 */
export async function sendOne(
  daemon: FakeLongPollDaemon,
  envelope: Envelope,
): Promise<{ status: number; body: unknown }> {
  const res = await daemon.send(envelope);
  return { status: res.status, body: await res.json() };
}

/**
 * One envelope at a time off the long-poll transport.
 *
 * `GET /byok/events` answers in PAGES, so this keeps the undelivered remainder
 * of the last page per daemon and only polls again once it is empty. The buffer
 * is keyed by the daemon object rather than held on it so
 * {@link FakeLongPollDaemon} stays the shape a real daemon implements.
 *
 * Throws instead of hanging when the poll's own hold window expires with
 * nothing to hand back — a test that expects an envelope and gets silence must
 * fail, not stall. Servers under test set a short `longPollHoldMs` so that
 * failure is fast.
 */
const pendingEnvelopes = new WeakMap<FakeLongPollDaemon, Envelope[]>();

export async function nextEnvelope(daemon: FakeLongPollDaemon): Promise<Envelope> {
  const buffered = pendingEnvelopes.get(daemon) ?? [];
  if (buffered.length === 0) {
    const page = await daemon.next();
    if (page.length === 0) throw new Error('long-poll window closed before any envelope arrived');
    buffered.push(...page);
  }
  const next = buffered.shift();
  pendingEnvelopes.set(daemon, buffered);
  if (next === undefined) throw new Error('unreachable: non-empty buffer produced nothing');
  return next;
}

/** Assert nothing more is owed: the buffer is empty AND a full poll window returns an empty page. */
export async function expectNoMoreEnvelopes(daemon: FakeLongPollDaemon): Promise<void> {
  expect(pendingEnvelopes.get(daemon) ?? []).toEqual([]);
  expect(await daemon.next()).toEqual([]);
}

/**
 * Offered -> Claimed -> Running over the long-poll send path, asserting each
 * hop landed. Lifted verbatim from WP3B Step 0's `claimAndStartOverLongPoll`
 * (`coordination-characterization.test.ts`), which keeps its own copy: that
 * file is a frozen pin and must not depend on a shared fixture that could drift
 * under it.
 *
 * `runtime` (S0) is the actual adapter the claim reports and `capabilities`
 * (S0/D-4) is that adapter's own self-report — the ONLY input the steer gate
 * reads. Both omitted matches a legacy `task.claim`.
 */
export async function claimAndStart(
  byok: ByokServer,
  daemon: FakeLongPollDaemon,
  handle: TaskHandle,
  runtime?: RuntimeId,
  capabilities?: RuntimeCapabilities,
): Promise<void> {
  const claim = await sendOne(
    daemon,
    createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime, capabilities }, { taskId: handle.taskId }),
  );
  expect(claim).toEqual({ status: 200, body: { accepted: 1 } });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('Claimed');

  const started = await sendOne(daemon, createEnvelope('task.started', {}, { taskId: handle.taskId }));
  expect(started).toEqual({ status: 200, body: { accepted: 1 } });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('Running');
}

/** Drive an already-Running task into `AwaitApproval` by reporting one, asserting it landed. */
export async function moveToAwaitApproval(
  byok: ByokServer,
  daemon: FakeLongPollDaemon,
  handle: TaskHandle,
  opts: { summary?: string; approvalId?: string } = {},
): Promise<void> {
  const reported = await sendOne(
    daemon,
    createEnvelope(
      'task.await_approval',
      {
        summary: opts.summary ?? 'needs a human ok',
        ...(opts.approvalId === undefined ? {} : { approvalId: opts.approvalId }),
      },
      { taskId: handle.taskId },
    ),
  );
  expect(reported).toEqual({ status: 200, body: { accepted: 1 } });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');
}

/** Poll a public read until it holds, or fail loudly at `timeoutMs`. Never a completion signal for a state change the test itself caused. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
