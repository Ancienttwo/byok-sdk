import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, randomUUID, verify as edVerify } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  parseMessage,
  PROTOCOL_VERSION,
  type Envelope,
} from '@byok/protocol';

interface Waiter {
  predicate: (envelope: Envelope) => boolean;
  resolve: (envelope: Envelope) => void;
}

interface DeviceAuthState {
  deviceId: string;
  publicKeyBase64Url: string;
  accessToken: string;
  revoked: boolean;
}

interface StoredBlob {
  blobId: string;
  contentType: string;
  contentHash: string;
  size: number;
  bytes?: Buffer;
}

/**
 * In-process stand-in for a SaaS server: serves the `/byok/*` HTTP surface
 * (pair v2, challenge/token renewal, blobs, long-poll events) and the
 * `/byok/ws` upgrade from the SAME origin (mirroring the real pinned server
 * contract), replies `conn.ack` to `conn.hello` automatically, and
 * records/dispatches every envelope for assertions.
 *
 * Auth is genuinely enforced (real Ed25519 signature verification on
 * `/byok/token`, bearer-token checks on the WS upgrade and every other
 * authed endpoint) so client-side auth-manager tests exercise real
 * round-trips rather than a server that rubber-stamps everything.
 */
export class TestServer {
  socket: WebSocket | undefined;
  readonly received: Envelope[] = [];
  /** Every HTTP request this server has handled, in order — lets tests assert e.g. "a /byok/token call happened" without caring about response bodies. */
  readonly httpRequests: Array<{ method: string; pathname: string }> = [];
  /** Count of WS upgrade attempts (regardless of accept/reject) — used to assert "no retry loop" after revocation: this must stop growing. */
  wsUpgradeAttempts = 0;
  private waiters: Waiter[] = [];

  private readonly devicesById = new Map<string, DeviceAuthState>();
  private readonly pendingNonces = new Map<string, string>(); // nonce -> deviceId
  private readonly blobs = new Map<string, StoredBlob>();
  /**
   * M4 Phase 4 (version-negotiation drill): ONE ordered queue for the next
   * long-poll response's `events` array — typed pushes (`pushLongPollEvent`)
   * and raw/untyped pushes (`pushRawLongPollEvent`) both append here, in
   * call order, so a test can interleave known and unrecognized-shape
   * entries and have the response preserve that exact order (two separate
   * queues merged at response time could not do this: everything from one
   * queue would always precede everything from the other, regardless of
   * push order).
   */
  private pendingLongPollEntries: unknown[] = [];
  private longPollCursor = 0;

  private deviceSeq = 0;
  private tokenSeq = 0;
  private blobSeq = 0;
  private seqCounter = 0;
  private tokenTtlMs = 60 * 60 * 1000;
  private rejectWs = false;
  private failBlobUploads = false;
  /** Finding R2: capabilities advertised in every subsequent `conn.ack` — see `setAckCapabilities`. */
  private ackCapabilities: string[] = [];

  private constructor(
    private readonly httpServer: http.Server,
    private readonly wss: WebSocketServer,
  ) {}

  static async start(): Promise<TestServer> {
    const httpServer = http.createServer();
    const wss = new WebSocketServer({
      server: httpServer,
      path: '/byok/ws',
      verifyClient: (info, callback) => {
        server.handleVerifyClient(info.req, callback);
      },
    });
    const server = new TestServer(httpServer, wss);

    httpServer.on('request', (req, res) => {
      void server.handleRequest(req, res);
    });

    wss.on('connection', (ws) => server.onConnection(ws));

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    return server;
  }

  get url(): string {
    const addr = this.httpServer.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  // --- test controls ---------------------------------------------------

  /** How long a freshly (re)minted access token is valid for — controls both `/byok/pair`'s `refreshHint` and `/byok/token`'s `expiresAt`. */
  setTokenTtlMs(ms: number): void {
    this.tokenTtlMs = ms;
  }

  /** Reject every WS upgrade attempt (503) while `true` — used to force the client into its long-poll fallback (protocol §8). */
  setRejectWs(reject: boolean): void {
    this.rejectWs = reject;
  }

  /** Finding R2: capabilities to advertise in every SUBSEQUENT `conn.ack` (default `[]`, matching the wire's real "additive-minor, absent means not understood" convention) — used to test capability-gated client behavior (e.g. `approval_resolved`) without needing the real `@byok/server`. */
  setAckCapabilities(capabilities: string[]): void {
    this.ackCapabilities = capabilities;
  }

  /** Make every blob content PUT fail with a 500 while `true` — used to test the client's handling of an upload failure (finding F7). */
  setFailBlobUploads(fail: boolean): void {
    this.failBlobUploads = fail;
  }

  /** Mark a device revoked: its next `/byok/challenge`, `/byok/token`, or WS connect gets a 401 (protocol §6.3). */
  revokeDevice(deviceId: string): void {
    const device = this.devicesById.get(deviceId);
    if (device) device.revoked = true;
  }

  isRevoked(deviceId: string): boolean {
    return this.devicesById.get(deviceId)?.revoked ?? false;
  }

  /** Simulate a server-side token rotation the client doesn't know about yet: the device's *old* cached token stops being valid (e.g. WS/blob calls using it now get a 401) until it renews via challenge/token. */
  rotateDeviceToken(deviceId: string): string {
    const device = this.devicesById.get(deviceId);
    if (!device) throw new Error(`unknown device: ${deviceId}`);
    device.accessToken = this.mintToken();
    return device.accessToken;
  }

  currentAccessToken(deviceId: string): string | undefined {
    return this.devicesById.get(deviceId)?.accessToken;
  }

  /** Queue an envelope for the next long-poll `GET /byok/events` response (protocol §8) — appended to the single ordered `pendingLongPollEntries` queue (see its own doc comment for why order matters). */
  pushLongPollEvent(envelope: Envelope): void {
    this.pendingLongPollEntries.push(envelope);
    if (typeof envelope.seq === 'number' && envelope.seq > this.longPollCursor) {
      this.longPollCursor = envelope.seq;
    }
  }

  /**
   * M4 Phase 4 (version-negotiation drill): queue a RAW, untyped value into
   * the next long-poll response's `events` array — bypassing `Envelope`'s
   * type checking entirely. `pushLongPollEvent` above can't express a wire
   * payload the current `@byok/protocol` package doesn't recognize at all
   * (e.g. a hypothetical future minor server's new message type) since its
   * parameter is typed as the real, frozen `Envelope` union; this is the
   * escape hatch for simulating exactly that scenario against the client's
   * real long-poll transport. Appended to the SAME ordered queue
   * `pushLongPollEvent` uses, so a test can freely interleave typed and raw
   * pushes and have the response preserve that exact call order.
   */
  pushRawLongPollEvent(raw: unknown): void {
    this.pendingLongPollEntries.push(raw);
  }

  /**
   * M4 Phase 4 (version-negotiation drill): send a RAW, untyped value over
   * the live WS connection — bypassing `createEnvelope`'s validation (which
   * would reject a `type` this package doesn't recognize). Mirrors
   * `pushRawLongPollEvent`'s rationale for the WS transport.
   */
  sendRaw(raw: unknown): void {
    this.socket?.send(`${JSON.stringify(raw)}\n`);
  }

  /** The content currently stored for a blob (undefined until the presigned PUT lands). */
  blobContent(blobId: string): Buffer | undefined {
    return this.blobs.get(blobId)?.bytes;
  }

  /** Directly register a blob as already existing (e.g. a large instruction the SaaS backend produced out-of-band) — bypasses the create+upload round trip, which is only relevant for *this device's own* uploads. */
  seedBlob(blobId: string, content: string | Buffer, contentType: string): void {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    this.blobs.set(blobId, { blobId, contentType, contentHash: `sha256:seeded-${blobId}`, size: bytes.length, bytes });
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

  // --- WS -----------------------------------------------------------------

  private handleVerifyClient(
    req: IncomingMessage,
    callback: (res: boolean, code?: number, message?: string) => void,
  ): void {
    this.wsUpgradeAttempts += 1;
    if (this.rejectWs) {
      callback(false, 503, 'ws temporarily unavailable');
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      callback(false, 401, 'missing bearer token');
      return;
    }
    const device = this.deviceByToken(token);
    if (!device || device.revoked) {
      callback(false, 401, 'invalid or revoked token');
      return;
    }
    callback(true);
  }

  /** Per-connection monotonic counter for the redelivery `seq` (protocol §1.2) — shared across every server->daemon envelope type, matching the wire's single per-device sequence space. Tests constructing their own S->D envelopes (`task.offer`/`task.approve`/`task.reject`/`task.cancel`/`task.steer`) must call this too, so `seq` stays strictly increasing across the whole connection. */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
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
            createEnvelope(
              'conn.ack',
              { protocolVersion: PROTOCOL_VERSION, capabilities: this.ackCapabilities, serverTime: new Date().toISOString() },
              { seq: this.nextSeq() },
            ),
          ),
        );
      }

      this.recordReceivedEnvelope(envelope);
    });
  }

  /** Shared by both transports an envelope can arrive over: a live WS message, or a `POST /byok/messages` batch entry (finding F6). */
  private recordReceivedEnvelope(envelope: Envelope): void {
    this.received.push(envelope);
    const matched = this.waiters.filter((w) => w.predicate(envelope));
    this.waiters = this.waiters.filter((w) => !matched.includes(w));
    for (const waiter of matched) waiter.resolve(envelope);
  }

  // --- HTTP -----------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    const method = req.method ?? 'GET';
    this.httpRequests.push({ method, pathname: url.pathname });

    try {
      if (method === 'POST' && url.pathname === '/byok/pair') return void this.handlePair(req, res);
      if (method === 'POST' && url.pathname === '/byok/challenge') return void (await this.handleChallenge(req, res));
      if (method === 'POST' && url.pathname === '/byok/token') return void (await this.handleToken(req, res));
      if (method === 'POST' && url.pathname === '/byok/blobs') return void (await this.handleCreateBlob(req, res));
      if (method === 'GET' && /^\/byok\/blobs\/[^/]+\/url$/.test(url.pathname)) {
        return void this.handleBlobUrl(req, res, url.pathname.split('/')[3] ?? '');
      }
      if (method === 'GET' && url.pathname === '/byok/events') return void (await this.handleEventsPoll(req, res));
      if (method === 'POST' && url.pathname === '/byok/messages') return void (await this.handleMessagesSend(req, res));
      if (method === 'PUT' && url.pathname.startsWith('/_test/blob-upload/')) {
        return void (await this.handleBlobUpload(req, res, url.pathname.slice('/_test/blob-upload/'.length)));
      }
      if (method === 'GET' && url.pathname.startsWith('/_test/blob-download/')) {
        return void this.handleBlobDownload(res, url.pathname.slice('/_test/blob-download/'.length));
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
      return;
    }

    res.writeHead(404).end();
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { pairingCode: string; deviceName: string; devicePublicKey: string };

    let device = [...this.devicesById.values()].find((d) => d.publicKeyBase64Url === body.devicePublicKey);
    if (device) {
      device.revoked = false;
      device.accessToken = this.mintToken();
    } else {
      this.deviceSeq += 1;
      device = {
        deviceId: `device-${this.deviceSeq}`,
        publicKeyBase64Url: body.devicePublicKey,
        accessToken: this.mintToken(),
        revoked: false,
      };
      this.devicesById.set(device.deviceId, device);
    }

    respondJson(res, 200, {
      deviceId: device.deviceId,
      accessToken: device.accessToken,
      refreshHint: new Date(Date.now() + this.tokenTtlMs).toISOString(),
    });
  }

  private async handleChallenge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { deviceId: string };
    const device = this.devicesById.get(body.deviceId);
    if (!device || device.revoked) {
      respondJson(res, 401, { error: 'invalid or revoked device' });
      return;
    }
    const nonce = randomUUID();
    this.pendingNonces.set(nonce, device.deviceId);
    respondJson(res, 200, { nonce });
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { deviceId: string; nonce: string; signature: string };
    const device = this.devicesById.get(body.deviceId);
    if (!device || device.revoked) {
      respondJson(res, 401, { error: 'invalid or revoked device' });
      return;
    }
    const nonceOwner = this.pendingNonces.get(body.nonce);
    this.pendingNonces.delete(body.nonce); // single-use regardless of outcome
    if (nonceOwner !== body.deviceId || !this.verifySignature(device, body.nonce, body.signature)) {
      respondJson(res, 401, { error: 'invalid nonce or signature' });
      return;
    }

    device.accessToken = this.mintToken();
    respondJson(res, 200, {
      accessToken: device.accessToken,
      expiresAt: new Date(Date.now() + this.tokenTtlMs).toISOString(),
    });
  }

  private verifySignature(device: DeviceAuthState, nonce: string, signatureBase64Url: string): boolean {
    try {
      const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: device.publicKeyBase64Url }, format: 'jwk' });
      return edVerify(null, Buffer.from(nonce, 'utf8'), publicKey, Buffer.from(signatureBase64Url, 'base64url'));
    } catch {
      return false;
    }
  }

  private async handleCreateBlob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requireBearer(req, res)) return;
    const body = (await readJsonBody(req)) as { size: number; contentType: string; contentHash: string };
    this.blobSeq += 1;
    const blobId = `blob-${this.blobSeq}`;
    this.blobs.set(blobId, { blobId, contentType: body.contentType, contentHash: body.contentHash, size: body.size });
    // Origin-relative, deliberately NOT `${this.url}/...` — matches the real
    // reference `LocalDiskBlobStore` (packages/server/src/blob-store.ts),
    // which mints relative content URLs. An M1-4 e2e run against a real
    // server caught `BlobClient` calling bare `fetch(uploadUrl)` on exactly
    // this shape, which Node's fetch rejects outright (no base to resolve a
    // relative URL against) — silently swallowed by task-runner.ts's
    // best-effort artifact-upload error handling, so no task ever failed;
    // the blob just never actually uploaded. Kept absolute here would mask
    // that class of bug again.
    respondJson(res, 200, { blobId, uploadUrl: `/_test/blob-upload/${blobId}` });
  }

  private handleBlobUrl(req: IncomingMessage, res: ServerResponse, blobId: string): void {
    if (!this.requireBearer(req, res)) return;
    if (!this.blobs.has(blobId)) {
      respondJson(res, 404, { error: 'unknown blob' });
      return;
    }
    respondJson(res, 200, { downloadUrl: `/_test/blob-download/${blobId}` }); // see uploadUrl comment above
  }

  private async handleBlobUpload(req: IncomingMessage, res: ServerResponse, blobId: string): Promise<void> {
    const blob = this.blobs.get(blobId);
    if (!blob) {
      res.writeHead(404).end();
      return;
    }
    if (this.failBlobUploads) {
      await readRawBody(req); // drain so the client's PUT doesn't hang on a full send buffer
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'simulated upload failure' }));
      return;
    }
    blob.bytes = await readRawBody(req);
    res.writeHead(200).end();
  }

  private handleBlobDownload(res: ServerResponse, blobId: string): void {
    const blob = this.blobs.get(blobId);
    if (!blob || !blob.bytes) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': blob.contentType }).end(blob.bytes);
  }

  /** `cursor` is accepted per the schema but not used to filter — this stub always drains its whole queue (in push order — see `pendingLongPollEntries`'s own doc comment) rather than tracking per-request replay. */
  private async handleEventsPoll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requireBearer(req, res)) return;
    const entries = this.pendingLongPollEntries.splice(0);
    // Not re-validated here — this response is hand-serialized exactly like
    // the real server's `EventsPollResponse`, so a raw entry queued via
    // `pushRawLongPollEvent` rides along unchanged, the same way a genuinely
    // future message type would arrive from a real future server.
    respondJson(res, 200, { events: entries, cursor: this.longPollCursor });
  }

  /** `POST /byok/messages` (finding F6): the daemon's outbound send path while long-polling — same recording/waiter-resolution as a live WS message. */
  private async handleMessagesSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requireBearer(req, res)) return;
    const body = (await readJsonBody(req)) as { messages?: unknown };
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    let accepted = 0;
    for (const raw of rawMessages) {
      let envelope: Envelope;
      try {
        envelope = parseMessage(raw);
      } catch {
        continue; // malformed entry — mirrors the real server's schema-validation gate
      }
      this.recordReceivedEnvelope(envelope);
      accepted += 1;
    }
    respondJson(res, 200, { accepted });
  }

  private requireBearer(req: IncomingMessage, res: ServerResponse): boolean {
    const token = bearerToken(req.headers.authorization);
    const device = token ? this.deviceByToken(token) : undefined;
    if (!device || device.revoked) {
      respondJson(res, 401, { error: 'invalid or revoked token' });
      return false;
    }
    return true;
  }

  private deviceByToken(token: string): DeviceAuthState | undefined {
    return [...this.devicesById.values()].find((d) => d.accessToken === token);
  }

  private mintToken(): string {
    this.tokenSeq += 1;
    return `token-${this.tokenSeq}`;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  return raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
}
