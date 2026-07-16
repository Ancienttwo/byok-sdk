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
  type RuntimeInfo,
} from '@byok/protocol';
import { WebSocket, type RawData } from 'ws';
import type { ByokServer, ServerTaskEvent, TaskHandle } from '../index';

/** Start `byok.hono` on an ephemeral port and wire up its WS upgrade. */
export async function startServer(
  byok: ByokServer,
): Promise<{ server: HttpServer; port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => {
      byok.attachWebSocket(server as HttpServer);
      resolve({ server: server as HttpServer, port: info.port, baseUrl: `http://127.0.0.1:${info.port}` });
    });
  });
}

export async function stopServer(server: HttpServer): Promise<void> {
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

/** A fake device's Ed25519 identity (Auth v2, §6) — the private key never leaves this helper, mirroring the real daemon. */
export interface FakeDeviceIdentity {
  publicKeyBase64Url: string;
  sign(message: string): string;
}

export function generateFakeDeviceIdentity(): FakeDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    publicKeyBase64Url: jwk.x,
    sign: (message: string) => signEd25519(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
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
    runtimes?: RuntimeInfo[];
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
      capabilities: [],
      deviceId: opts.deviceId,
      productId: opts.productId,
      runtimes: opts.runtimes,
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
  opts: { deviceName?: string; productId: string; runtimes?: RuntimeInfo[]; cursor?: number; identity?: FakeDeviceIdentity },
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
    runtimes: opts.runtimes,
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
