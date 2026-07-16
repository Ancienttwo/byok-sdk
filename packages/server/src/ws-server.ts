import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CAPABILITY_FLAGS,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type ConnHelloPayload,
} from '@byok/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { ConnectionHub } from './hub';
import type { PairingManager } from './pairing';

const WS_PATH = '/byok/ws';

/**
 * Capability flags this M0 server actually implements. `blob-upload` is
 * withheld on purpose — M0 has no blob store (artifacts are inline-only,
 * <=64KB; see the M0 simplifications in the task/plan).
 */
const SUPPORTED_CAPABILITIES: string[] = CAPABILITY_FLAGS.filter((flag) => flag !== 'blob-upload');

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

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

interface AttachDeps {
  pairing: PairingManager;
  hub: ConnectionHub;
  productId: string;
}

/**
 * Wire up the `GET /byok/ws` upgrade on a raw Node HTTP server (the one
 * `@hono/node-server`'s `serve()` returns). Auth happens on the upgrade
 * request itself via `Authorization: Bearer <deviceToken>`; unknown/invalid
 * tokens get a 401 and the socket is destroyed. Handshake (`conn.hello` ->
 * `conn.ack`) happens on the first WS message once upgraded.
 */
export function attachWebSocket(server: HttpServer, deps: AttachDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!matchesWsPath(req.url ?? '')) return; // not ours; leave it for any other listener

    const token = extractBearerToken(req.headers.authorization);
    const deviceId = token ? deps.pairing.deviceIdForToken(token) : undefined;
    if (!deviceId) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, deviceId, deps);
    });
  });
}

function handleConnection(ws: WebSocket, deviceId: string, deps: AttachDeps): void {
  let helloReceived = false;

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
    deps.hub.registerConnection(deviceId, ws, payload.agents);

    const ack = createEnvelope('conn.ack', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SUPPORTED_CAPABILITIES,
      serverTime: new Date().toISOString(),
    });
    ws.send(encodeEnvelope(ack));

    ws.on('message', (msgData: RawData) => {
      let msg;
      try {
        msg = decodeEnvelope(toDecodable(msgData));
      } catch (err) {
        console.warn(`[byok/server] dropping unparsable frame from device ${deviceId}:`, err);
        return;
      }
      deps.hub.handleEnvelope(deviceId, msg);
    });
  });

  ws.on('close', () => {
    if (helloReceived) {
      deps.hub.handleDisconnect(deviceId);
    }
  });
}
