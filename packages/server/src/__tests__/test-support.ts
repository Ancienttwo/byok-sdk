import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type ConnAckPayload,
  type Envelope,
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

/** Wait for the next envelope on `ws` (rejects if the socket errors/closes first). */
export function nextEnvelope(ws: WebSocket): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onMessage = (data: RawData) => {
      cleanup();
      try {
        resolve(toEnvelope(data));
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('ws closed before expected message'));
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

export function send(ws: WebSocket, envelope: Envelope): void {
  ws.send(encodeEnvelope(envelope));
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
  opts: { deviceName?: string; productId: string; agents?: unknown },
): Promise<{ ws: WebSocket; deviceId: string; deviceToken: string; ack: ConnAckPayload }> {
  const pairRes = await fetch(`${baseUrl}/byok/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode, deviceName: opts.deviceName ?? 'test-laptop' }),
  });
  if (!pairRes.ok) {
    throw new Error(`pairing failed: ${pairRes.status} ${await pairRes.text()}`);
  }
  const { deviceId, deviceToken } = (await pairRes.json()) as { deviceId: string; deviceToken: string };

  const ws = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, {
    headers: { authorization: `Bearer ${deviceToken}` },
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
      deviceId,
      productId: opts.productId,
      agents: opts.agents,
    }),
  );
  const ackEnvelope = await nextEnvelope(ws);
  if (ackEnvelope.type !== 'conn.ack') {
    throw new Error(`expected conn.ack, got ${ackEnvelope.type}`);
  }

  return { ws, deviceId, deviceToken, ack: ackEnvelope.payload };
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
