import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { CAPABILITY_FLAGS, decodeEnvelope, PROTOCOL_VERSION, type ConnHelloPayload } from '@byok/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { authenticateBearer, type AuthDeps } from './auth';
import { startHeartbeat, type Heartbeat } from './heartbeat';
import type { ConnectionHub } from './hub';

const WS_PATH = '/byok/ws';

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

interface AttachDeps extends AuthDeps {
  hub: ConnectionHub;
  productId: string;
  /** WS-native ping interval, ms. Defaults inside `heartbeat.ts` (30s) if omitted. */
  heartbeatIntervalMs?: number;
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
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!matchesWsPath(req.url ?? '')) return; // not ours; leave it for any other listener

    void (async () => {
      const deviceId = await authenticateBearer(req.headers.authorization, deps);
      if (!deviceId) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, deviceId, deps);
      });
    })();
  });
}

function handleConnection(ws: WebSocket, deviceId: string, deps: AttachDeps): void {
  let helloReceived = false;
  let heartbeat: Heartbeat | undefined;

  ws.once('message', (data: RawData) => {
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
    if (payload.deviceId !== deviceId) {
      ws.close(1002, 'deviceId does not match authenticated token');
      return;
    }

    helloReceived = true;
    // M5 (hello-capability plumbing): previously only `runtimes` was
    // forwarded — `payload.capabilities` was silently ignored end to end.
    deps.hub.registerConnection(deviceId, ws, payload.runtimes, payload.capabilities);
    deps.hub.sendConnAck(deviceId, SUPPORTED_CAPABILITIES);
    // Reconnection procedure step 3 (§9): redeliver anything still relevant
    // sent since the daemon's last-seen `seq`. Omitted on a device's
    // first-ever connection (no cursor to redeliver from).
    if (payload.cursor !== undefined) {
      deps.hub.redeliverAfterReconnect(deviceId, payload.cursor);
    }

    heartbeat = startHeartbeat(ws, { intervalMs: deps.heartbeatIntervalMs });

    ws.on('message', (msgData: RawData) => {
      let msg;
      try {
        msg = decodeEnvelope(toDecodable(msgData));
      } catch (err) {
        console.warn(`[byok/server] dropping unparsable frame from device ${deviceId}:`, err);
        return;
      }
      deps.hub.handleInbound(deviceId, msg);
    });
  });

  ws.on('close', () => {
    heartbeat?.stop();
    if (helloReceived) {
      deps.hub.handleDisconnect(deviceId, ws);
    }
  });
}
