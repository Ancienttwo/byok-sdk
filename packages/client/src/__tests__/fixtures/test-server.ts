import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type Envelope,
} from '@byok/protocol';

export interface PairResponse {
  deviceId: string;
  deviceToken: string;
}

interface Waiter {
  predicate: (envelope: Envelope) => boolean;
  resolve: (envelope: Envelope) => void;
}

/**
 * In-process stand-in for a SaaS server: serves `POST /byok/pair` over plain
 * HTTP and the `/byok/ws` upgrade from the SAME origin (mirroring the real
 * pinned server contract), replies `conn.ack` to `conn.hello` automatically,
 * and records/dispatches every envelope for assertions.
 */
export class TestServer {
  socket: WebSocket | undefined;
  readonly received: Envelope[] = [];
  private waiters: Waiter[] = [];
  private pairResponse: PairResponse = { deviceId: 'device-1', deviceToken: 'token-1' };

  private constructor(
    private readonly httpServer: http.Server,
    private readonly wss: WebSocketServer,
  ) {}

  static async start(): Promise<TestServer> {
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer, path: '/byok/ws' });
    const server = new TestServer(httpServer, wss);

    httpServer.on('request', (req, res) => {
      if (req.method === 'POST' && req.url === '/byok/pair') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(server.pairResponse));
        });
        return;
      }
      res.writeHead(404).end();
    });

    wss.on('connection', (ws) => server.onConnection(ws));

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    return server;
  }

  setPairResponse(response: PairResponse): void {
    this.pairResponse = response;
  }

  get url(): string {
    const addr = this.httpServer.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  send(envelope: Envelope): void {
    this.socket?.send(encodeEnvelope(envelope));
  }

  /** Force-drop the current client connection (simulates a network blip). */
  dropConnection(): void {
    this.socket?.terminate();
  }

  async waitFor(predicate: (envelope: Envelope) => boolean, timeoutMs = 2000): Promise<Envelope> {
    const existing = this.received.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for envelope')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (envelope) => {
          clearTimeout(timer);
          resolve(envelope);
        },
      });
    });
  }

  async close(): Promise<void> {
    this.socket?.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private onConnection(ws: WebSocket): void {
    this.socket = ws;
    ws.on('message', (data, isBinary) => {
      const bytes = isBinary || Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(String(data), 'utf8');
      let envelope: Envelope;
      try {
        envelope = decodeEnvelope(bytes);
      } catch {
        return;
      }

      if (envelope.type === 'conn.hello') {
        ws.send(
          encodeEnvelope(
            createEnvelope('conn.ack', {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              serverTime: new Date().toISOString(),
            }),
          ),
        );
      }

      this.received.push(envelope);
      const matched = this.waiters.filter((w) => w.predicate(envelope));
      this.waiters = this.waiters.filter((w) => !matched.includes(w));
      for (const waiter of matched) waiter.resolve(envelope);
    });
  }
}
