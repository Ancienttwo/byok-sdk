import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { WebSocket } from 'ws';
import { createByokServer, LocalDiskBlobStore, type TokenSigner } from '../index';
import { SqliteBlobStore } from '../sqlite-blob-store';
import { isSqliteAvailable } from '../sqlite-support';
import {
  connectFakeDaemon,
  nextEnvelope,
  pairFakeDaemon,
  send,
  startServer,
  stopServer,
  testPairingClaims,
} from './test-support';

const PRODUCT_ID = 'acme';
const AGENT_REF = { agentId: 'agent-issues', profileRevision: 'profile-r1' } as const;
const CONTENT_HASH = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function sha256Hex(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function waitForClose(ws: WebSocket, timeoutMs = 250): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close within deadline')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      resolve({ code: response.statusCode ?? 0, reason: response.statusMessage ?? '' });
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function openSocket(port: number, accessToken: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, { headers: { authorization: `Bearer ${accessToken}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function sendHello(ws: WebSocket, deviceId: string, cursor?: number): void {
  send(ws, createEnvelope('conn.hello', {
    protocolVersions: [PROTOCOL_VERSION],
    capabilities: [],
    deviceId,
    productId: PRODUCT_ID,
    cursor,
  }));
}

describe('Issues #112/#114/#115/#116/#117/#118/#120 reference-server regressions', () => {
  let server: HttpServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    if (server) await stopServer(server);
    server = undefined;
  });

  it('#112 retries one immutable pairing completion after token issuance fails', async () => {
    let signCalls = 0;
    const signer: TokenSigner = {
      async sign() {
        signCalls++;
        if (signCalls === 1) throw new Error('injected first token signing failure');
        return 'retry-token';
      },
      async verify() {
        return undefined;
      },
    };
    const byok = createByokServer({ productId: PRODUCT_ID, tokenSigner: signer });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const publicKey = 'A'.repeat(43);
    const request = {
      pairingCode: code,
      deviceName: 'retryable-first-pair',
      devicePublicKey: publicKey,
    };

    const first = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(first.status).toBeGreaterThanOrEqual(500);

    const retry = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(retry.status).toBe(200);
    const recovered = await retry.json() as { deviceId: string; accessToken: string; tenantId: string };
    expect(recovered).toMatchObject({ accessToken: 'retry-token', tenantId: 'tenant-test' });
    expect(byok.machines.list()).toHaveLength(1);

    // The response body of this successful completion is intentionally not
    // consumed. Its exact retry must still name the same enrollment.
    await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const afterLostResponse = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(afterLostResponse.status).toBe(200);
    expect((await afterLostResponse.json() as { deviceId: string }).deviceId).toBe(recovered.deviceId);

    const conflict = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, devicePublicKey: 'B'.repeat(43) }),
    });
    expect(conflict.status).toBe(409);

    const concurrentCode = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID)).code;
    const concurrentRequest = { ...request, pairingCode: concurrentCode, deviceName: 'concurrent-first-pair' };
    const concurrent = await Promise.all([
      fetch(`${started.baseUrl}/byok/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(concurrentRequest) }),
      fetch(`${started.baseUrl}/byok/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(concurrentRequest) }),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const concurrentResponses = await Promise.all(concurrent.map(async (response) => response.json() as Promise<{ deviceId: string }>));
    expect(concurrentResponses[0]?.deviceId).toBe(concurrentResponses[1]?.deviceId);
    expect(byok.machines.list()).toHaveLength(2);
  });

  it('#114 refuses an over-reservation Content-Length before the upload body reaches a store write', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, maxBlobSizeBytes: 32 });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);
    const declared = Buffer.from('abc');
    const created = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'idempotency-key': 'bounded-upload' },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256Hex(declared) }),
    });
    const { uploadUrl } = (await created.json()) as { uploadUrl: string };
    const oversized = await fetch(`${started.baseUrl}${uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-length': '4' },
      body: Buffer.from('abcd'),
    });
    expect(oversized.status).toBe(413);
  });

  it('#114 stops a chunked upload at the reservation plus one byte when Content-Length is absent', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, maxBlobSizeBytes: 32 });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);
    const declared = Buffer.from('abc');
    const created = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'idempotency-key': 'chunked-bounded-upload' },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256Hex(declared) }),
    });
    const { uploadUrl } = (await created.json()) as { uploadUrl: string };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('abc'));
        controller.enqueue(Buffer.from('d'));
        controller.close();
      },
    });
    const oversized = await fetch(`${started.baseUrl}${uploadUrl}`, {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(oversized.status).toBe(413);
  });

  it('#114 enforces the deployment ceiling even for a previously-reserved capability URL', async () => {
    const store = new LocalDiskBlobStore();
    const content = Buffer.from('abcd');
    const created = await store.createUpload('tenant-preexisting', {
      size: content.length,
      contentType: 'text/plain',
      contentHash: sha256Hex(content),
    }, 'blob_absolute_ceiling');
    const byok = createByokServer({ productId: PRODUCT_ID, blobStore: store, maxBlobSizeBytes: content.length - 1 });
    const started = await startServer(byok);
    server = started.server;
    const response = await fetch(`${started.baseUrl}${created.uploadUrl}`, { method: 'PUT', body: content });
    expect(response.status).toBe(413);
  });

  it('#115 makes a disclosed foreign blob id indistinguishable from missing at the URL-mint boundary', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const firstCode = byok.pairing.createPairingCode({ tenantId: 'tenant-a', productId: PRODUCT_ID });
    const secondCode = byok.pairing.createPairingCode({ tenantId: 'tenant-b', productId: PRODUCT_ID });
    const first = await pairFakeDaemon(started.baseUrl, firstCode.code);
    const second = await pairFakeDaemon(started.baseUrl, secondCode.code);
    const content = Buffer.from('tenant-a-secret');
    const created = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json', 'idempotency-key': 'same-reservation' },
      body: JSON.stringify({ size: content.length, contentType: 'text/plain', contentHash: sha256Hex(content) }),
    });
    const { blobId, uploadUrl } = (await created.json()) as { blobId: string; uploadUrl: string };
    expect((await fetch(`${started.baseUrl}${uploadUrl}`, { method: 'PUT', body: content })).status).toBe(204);
    const foreign = await fetch(`${started.baseUrl}/byok/blobs/${blobId}/url`, {
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(foreign.status).toBe(404);

    const directory = mkdtempSync(join(tmpdir(), 'byok-issue-115-'));
    try {
      const firstStore = new LocalDiskBlobStore({ directory });
      const persisted = Buffer.from('persisted tenant owner');
      const upload = await firstStore.createUpload('tenant-a', {
        size: persisted.length,
        contentType: 'text/plain',
        contentHash: sha256Hex(persisted),
      }, 'blob_issue_115');
      expect(await firstStore.writeContent('blob_issue_115', persisted)).toEqual({ ok: true });

      const afterRestart = new LocalDiskBlobStore({ directory });
      expect(await afterRestart.getDownloadUrl('tenant-b', 'blob_issue_115')).toBeUndefined();
      expect(await afterRestart.getDownloadUrl('tenant-a', 'blob_issue_115')).toBeDefined();
      const signed = new URL(upload.uploadUrl, 'http://local.test');
      expect(afterRestart.verifySignedUrl('blob_issue_115', 'put', signed.searchParams.get('sig')!, Number(signed.searchParams.get('exp')))).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.skipIf(!isSqliteAvailable())('#115 persists SQLite tenant ownership across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-issue-115-sqlite-'));
    const path = join(directory, 'blobs.sqlite');
    try {
      const content = Buffer.from('sqlite tenant owner');
      const first = new SqliteBlobStore({ path });
      await first.createUpload('tenant-a', {
        size: content.length,
        contentType: 'text/plain',
        contentHash: sha256Hex(content),
      }, 'blob_sqlite_issue_115');
      expect(await first.writeContent('blob_sqlite_issue_115', content)).toEqual({ ok: true });
      first.close();

      const afterRestart = new SqliteBlobStore({ path });
      expect(await afterRestart.getDownloadUrl('tenant-b', 'blob_sqlite_issue_115')).toBeUndefined();
      expect(await afterRestart.getDownloadUrl('tenant-a', 'blob_sqlite_issue_115')).toBeDefined();
      afterRestart.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('#116 returns an explicit long-poll replay-gap failure instead of a normal partial tail', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    sockets.push(daemon.ws);

    for (let i = 0; i < 501; i++) {
      await byok.dispatch({ deviceId: daemon.deviceId, instruction: `overflow-${String(i)}` });
    }

    const response = await fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${daemon.accessToken}` },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'cursor_too_old', recoverableFrom: expect.any(Number) });
  });

  it('#116 closes a reconnect before conn.ack when its cursor predates the recoverable floor', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    sockets.push(daemon.ws);
    for (let i = 0; i < 501; i++) {
      await byok.dispatch({ deviceId: daemon.deviceId, instruction: `ws-overflow-${String(i)}` });
    }
    const reconnect = await openSocket(started.port, daemon.accessToken);
    sockets.push(reconnect);
    const closed = waitForClose(reconnect);
    sendHello(reconnect, daemon.deviceId, 0);
    await expect(closed).resolves.toMatchObject({ code: 1008, reason: 'cursor_too_old' });
  });

  it('#117 makes an A -> B takeover stale A inbound frame inert', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const first = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    sockets.push(first.ws);
    const task = await byok.dispatch({ deviceId: first.deviceId, instruction: 'stale socket must not claim' });
    await nextEnvelope(first.ws);

    const replacement = await openSocket(started.port, first.accessToken);
    sockets.push(replacement);
    const firstClosed = waitForClose(first.ws);
    sendHello(replacement, first.deviceId);
    send(first.ws, createEnvelope('task.claim', { deviceId: first.deviceId }, { taskId: task.taskId }));
    expect((await nextEnvelope(replacement)).type).toBe('conn.ack');
    await expect(firstClosed).resolves.toMatchObject({ code: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(byok.tasks.get(task.taskId)?.state).toBe('Offered');
  });

  it('#118 times out an authenticated socket that never presents conn.hello', async () => {
    const byok = createByokServer({
      productId: PRODUCT_ID,
      webSocketHelloTimeoutMs: 25,
      maxPendingWebSockets: 1,
      maxWebSocketPayloadBytes: 1024,
    });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await pairFakeDaemon(started.baseUrl, code);
    const silent = await openSocket(started.port, daemon.accessToken);
    sockets.push(silent);
    await expect(waitForClose(silent)).resolves.toMatchObject({ code: 1008, reason: 'hello_timeout' });
  });

  it('#118 rejects an excess pending hello and a post-hello oversized frame without hub mutation', async () => {
    const byok = createByokServer({
      productId: PRODUCT_ID,
      webSocketHelloTimeoutMs: 500,
      maxPendingWebSockets: 1,
      maxWebSocketPayloadBytes: 1024,
    });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await pairFakeDaemon(started.baseUrl, code);
    const pending = await openSocket(started.port, daemon.accessToken);
    sockets.push(pending);
    const excess = new WebSocket(`ws://127.0.0.1:${started.port}/byok/ws`, { headers: { authorization: `Bearer ${daemon.accessToken}` } });
    sockets.push(excess);
    await expect(waitForClose(excess)).resolves.toMatchObject({ code: 503 });
    pending.terminate();

    const active = await openSocket(started.port, daemon.accessToken);
    sockets.push(active);
    sendHello(active, daemon.deviceId);
    expect((await nextEnvelope(active)).type).toBe('conn.ack');
    const before = byok.stats().envelopesIn;
    const closed = waitForClose(active);
    active.send('x'.repeat(1025));
    await expect(closed).resolves.toMatchObject({ code: 1009 });
    expect(byok.stats().envelopesIn).toBe(before);
  });

  it('#120 rejects a first agent message publish after cancellation without calling the product consumer', async () => {
    const consumed: unknown[] = [];
    const byok = createByokServer({
      productId: PRODUCT_ID,
      agentMessage: { consume(input) { consumed.push(input); return { outcome: 'accepted' }; } },
    });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection'],
    });
    sockets.push(daemon.ws);
    const task = await byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'late publish must not side effect',
      agentRef: AGENT_REF,
      sessionRef: 'session-issues',
      egressPolicy: {
        policyRevision: 'policy-r1',
        activity: { mode: 'metadata-status', delivery: 'latest-value' },
        reliable: { maxPendingEventsPerAgent: 1, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 1024 },
        transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
      },
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 1024 },
      terminalProjection: { mode: 'none' },
      agentMessageContext: { destinationBinding: 'conversation/issue-120' },
    });
    await nextEnvelope(daemon.ws);
    await task.cancel('cancel before first publish');
    await nextEnvelope(daemon.ws);
    send(daemon.ws, createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF,
      sessionRef: 'session-issues',
      contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000120',
      cursor: 1,
      contentType: 'text/markdown',
      body: 'hello',
      contentHash: CONTENT_HASH,
      byteCount: 5,
    }, { taskId: task.taskId }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(consumed).toHaveLength(0);
  });
});
