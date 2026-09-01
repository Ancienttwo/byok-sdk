import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { BYOK_WS_PATH, CAPABILITY_FLAGS, decodeEnvelope, PROTOCOL_VERSION, type ConnHelloPayload } from '@byok-sdk/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { authenticateBearer, type AuthDeps, type AuthenticatedDevice } from './auth';
import { startHeartbeat, type Heartbeat } from './heartbeat';
import type { ConnectionHub } from './hub';

const WS_PATH = BYOK_WS_PATH;

/**
 * Capability flags this server implements. Unlike the M0 server, `blob-upload`
 * is no longer withheld — the blob store (§7, `blob-store.ts`) is now
 * implemented, so both flags are advertised.
 */
const SUPPORTED_CAPABILITIES: string[] = [...CAPABILITY_FLAGS];

function matchesWsPath(url: string): boolean {
  return url.split('?')[0] === WS_PATH;
}

/**
 * Reject an upgrade request with a plain HTTP response, mirroring `ws`'s own
 * internal `abortHandshake` helper: write the full response via `.end()` (so
 * it's flushed before closing) and only `destroy()` once `'finish'` fires,
 * rather than destroying immediately after `write()` and risking the client
 * seeing a reset instead of the response.
 */
function rejectUpgrade(socket: Duplex, code: number, message: string): void {
  const body = message;
  const headers = [
    `HTTP/1.1 ${code} ${message}`,
    'Connection: close',
    'Content-Type: text/plain',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    '',
  ].join('\r\n');
  socket.once('finish', () => socket.destroy());
  socket.end(headers + body);
}

function toDecodable(data: RawData): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data; // Buffer, which is a Uint8Array
}

function rawDataByteLength(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

interface AttachDeps extends AuthDeps {
  hub: ConnectionHub;
  productId: string;
  /** WS-native ping interval, ms. Defaults inside `heartbeat.ts` (30s) if omitted. */
  heartbeatIntervalMs?: number;
  helloTimeoutMs: number;
  maxPendingWebSockets: number;
  maxPayloadBytes: number;
}

/**
 * Wire up the `GET /byok/ws` upgrade on a raw Node HTTP server (the one
 * `@hono/node-server`'s `serve()` returns). Auth happens on the upgrade
 * request itself via `Authorization: Bearer <accessToken>` (a JWT minted by
 * `/byok/pair` or `/byok/token` — Auth v2, §6); an invalid, expired, or
 * revoked token gets a 401 and the socket is destroyed. Handshake
 * (`conn.hello` -> `conn.ack`) happens on the first WS message once
 * upgraded.
 */
export function attachWebSocket(server: HttpServer, deps: AttachDeps): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: deps.maxPayloadBytes });
  let pendingHelloConnections = 0;

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!matchesWsPath(req.url ?? '')) return; // not ours; leave it for any other listener

    void (async () => {
      const principal = await authenticateBearer(req.headers.authorization, deps);
      if (!principal) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      if (pendingHelloConnections >= deps.maxPendingWebSockets) {
        rejectUpgrade(socket, 503, 'WebSocket hello admission limit reached');
        return;
      }
      pendingHelloConnections++;
      let released = false;
      const releasePendingHello = () => {
        if (released) return;
        released = true;
        pendingHelloConnections--;
      };
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleConnection(ws, principal, deps, releasePendingHello);
        });
      } catch {
        releasePendingHello();
        socket.destroy();
      }
    })();
  });
}

function handleConnection(
  ws: WebSocket,
  principal: AuthenticatedDevice,
  deps: AttachDeps,
  releasePendingHello: () => void,
): void {
  const { deviceId } = principal;
  let helloReceived = false;
  let epoch: number | undefined;
  let heartbeat: Heartbeat | undefined;
  const helloDeadline = setTimeout(() => {
    if (!helloReceived) ws.close(1008, 'hello_timeout');
  }, deps.helloTimeoutMs);
  helloDeadline.unref?.();
  const clearHelloDeadline = () => clearTimeout(helloDeadline);
  // `ws` emits an error when its transport-level maxPayload guard rejects a
  // frame. A listener makes that a normal connection failure; close cleanup
  // releases the pre-hello slot or current epoch exactly once.
  ws.on('error', () => undefined);

  ws.once('message', (data: RawData) => {
    if (rawDataByteLength(data) > deps.maxPayloadBytes) {
      ws.close(1009, 'payload_too_large');
      return;
    }
    let envelope;
    try {
      envelope = decodeEnvelope(toDecodable(data));
    } catch {
      ws.close(1002, 'expected conn.hello');
      return;
    }
    if (envelope.type !== 'conn.hello') {
      ws.close(1002, 'expected conn.hello');
      return;
    }

    const payload: ConnHelloPayload = envelope.payload;
    if (!payload.protocolVersions.includes(PROTOCOL_VERSION)) {
      ws.close(1002, 'unsupported protocol version');
      return;
    }
    // One daemon process is always scoped to one product (see plan: "一产品
    // 一 daemon 进程"); a mismatched productId means this connection is for a
    // different embedding SaaS than this server instance serves.
    if (payload.productId !== deps.productId) {
      ws.close(1002, 'productId mismatch');
      return;
    }
    // S1: the instance check above says "this server serves that product";
    // this one says "the DEVICE was paired into that product". They are
    // different facts — a device paired under one product's claims must not
    // register a connection as another, even on a server instance that
    // happens to serve the announced one. Checked here, before
    // `registerConnection`, so a mismatched daemon never reaches the hub.
    if (payload.productId !== principal.productId) {
      ws.close(1002, 'productId does not match the device record');
      return;
    }
    if (payload.deviceId !== deviceId) {
      ws.close(1002, 'deviceId does not match authenticated token');
      return;
    }

    if (payload.cursor !== undefined) {
      try {
        // `conn.ack` itself consumes one ring slot. Prove it cannot evict a
        // required replay control before writing any normal handshake frame.
        deps.hub.assertReplayAvailable(deviceId, payload.cursor, 1);
      } catch {
        ws.close(1008, 'cursor_too_old');
        return;
      }
    }

    helloReceived = true;
    // M5 (hello-capability plumbing): previously only `runtimes` was
    // forwarded — `payload.capabilities` was silently ignored end to end.
    epoch = deps.hub.registerConnection(
      deviceId,
      ws,
      payload.runtimes,
      payload.capabilities,
      payload.configuredToolsets,
      payload.clientVersion,
    );
    clearHelloDeadline();
    releasePendingHello();
    deps.hub.sendConnAck(deviceId, SUPPORTED_CAPABILITIES);
    // Reconnection procedure step 3 (§9): redeliver anything still relevant
    // sent since the daemon's last-seen `seq`. Omitted on a device's
    // first-ever connection (no cursor to redeliver from).
    if (payload.cursor !== undefined) {
      deps.hub.redeliverAfterReconnect(deviceId, payload.cursor);
    }

    heartbeat = startHeartbeat(ws, { intervalMs: deps.heartbeatIntervalMs });

    ws.on('message', (msgData: RawData) => {
      if (epoch === undefined || !deps.hub.isCurrentConnection(deviceId, ws, epoch)) return;
      if (rawDataByteLength(msgData) > deps.maxPayloadBytes) {
        ws.close(1009, 'payload_too_large');
        return;
      }
      let msg;
      try {
        msg = decodeEnvelope(toDecodable(msgData));
      } catch (err) {
        console.warn(`[byok/server] dropping unparsable frame from device ${deviceId}:`, err);
        return;
      }
      if (deps.hub.isCurrentConnection(deviceId, ws, epoch)) {
        deps.hub.handleInbound(deviceId, msg);
      }
    });
  });

  ws.on('close', () => {
    clearHelloDeadline();
    releasePendingHello();
    heartbeat?.stop();
    if (helloReceived && epoch !== undefined) {
      deps.hub.handleDisconnect(deviceId, ws);
    }
  });
}
