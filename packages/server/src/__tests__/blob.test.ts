import type { Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { pairFakeDaemon, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('blob flows (§7)', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server) await stopServer(server);
    server = undefined;
  });

  it('round-trips content: declare -> upload -> fetch download url -> download', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const content = Buffer.from('hello blob world');
    const contentHash = sha256Hex(content);

    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: content.length, contentType: 'text/plain', contentHash }),
    });
    expect(createRes.status).toBe(200);
    const { blobId, uploadUrl } = (await createRes.json()) as { blobId: string; uploadUrl: string };
    expect(blobId).toBeTruthy();

    // The upload URL is pre-signed — no bearer auth needed to use it.
    const putRes = await fetch(`${started.baseUrl}${uploadUrl}`, { method: 'PUT', body: content });
    expect(putRes.status).toBe(204);

    const urlRes = await fetch(`${started.baseUrl}/byok/blobs/${blobId}/url`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(urlRes.status).toBe(200);
    const { downloadUrl } = (await urlRes.json()) as { downloadUrl: string };

    const getRes = await fetch(`${started.baseUrl}${downloadUrl}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('text/plain');
    const downloaded = Buffer.from(await getRes.arrayBuffer());
    expect(downloaded.equals(content)).toBe(true);
  });

  it('accepts a contentHash with an explicit "sha256:" algorithm prefix (the @byok/client convention)', async () => {
    // docs/protocol.md §7 doesn't pin the exact contentHash string format;
    // the client encodes `sha256:<hex>` while this store's own default
    // assumption was bare `<hex>` — verify the prefixed form still verifies
    // correctly (see blob-store.ts's normalizeContentHash).
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const content = Buffer.from('prefixed hash content');
    const contentHash = `sha256:${sha256Hex(content)}`;

    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: content.length, contentType: 'text/plain', contentHash }),
    });
    const { blobId, uploadUrl } = (await createRes.json()) as { blobId: string; uploadUrl: string };

    const putRes = await fetch(`${started.baseUrl}${uploadUrl}`, { method: 'PUT', body: content });
    expect(putRes.status).toBe(204);

    const existsRes = await fetch(`${started.baseUrl}/byok/blobs/${blobId}/url`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(existsRes.status).toBe(200);
  });

  it('GET .../url 404s before anything has been uploaded', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const content = Buffer.from('never uploaded');
    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: content.length, contentType: 'text/plain', contentHash: sha256Hex(content) }),
    });
    const { blobId } = (await createRes.json()) as { blobId: string };

    const urlRes = await fetch(`${started.baseUrl}/byok/blobs/${blobId}/url`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(urlRes.status).toBe(404);
  });

  it('rejects an upload whose bytes do not match the declared contentHash', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const declared = Buffer.from('expected-content'); // 16 bytes
    const tampered = Buffer.from('not-the-expected'); // same length, different bytes -> isolates the hash check from the size check

    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256Hex(declared) }),
    });
    const { blobId, uploadUrl } = (await createRes.json()) as { blobId: string; uploadUrl: string };

    const putRes = await fetch(`${started.baseUrl}${uploadUrl}`, { method: 'PUT', body: tampered });
    expect(putRes.status).toBe(422);

    // Never successfully uploaded, so it still doesn't "exist".
    const urlRes = await fetch(`${started.baseUrl}/byok/blobs/${blobId}/url`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(urlRes.status).toBe(404);
  });

  it('rejects an upload whose byte length does not match the declared size', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const declared = Buffer.from('expected-content');
    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256Hex(declared) }),
    });
    const { uploadUrl } = (await createRes.json()) as { uploadUrl: string };

    const putRes = await fetch(`${started.baseUrl}${uploadUrl}`, { method: 'PUT', body: Buffer.from('short') });
    expect(putRes.status).toBe(422);
  });

  it('rejects a blob declaration exceeding the per-product size cap', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, maxBlobSizeBytes: 1024 });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: 2048, contentType: 'application/octet-stream', contentHash: 'deadbeef' }),
    });
    expect(createRes.status).toBe(413);
  });

  it('defaults the per-product cap to 100MB when not configured', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const overCap = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: 100 * 1024 * 1024 + 1, contentType: 'application/octet-stream', contentHash: 'deadbeef' }),
    });
    expect(overCap.status).toBe(413);

    const underCap = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: 1024, contentType: 'application/octet-stream', contentHash: 'deadbeef' }),
    });
    expect(underCap.status).toBe(200);
  });

  it('rejects blob POST/GET-url routes without a bearer token', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 10, contentType: 'text/plain', contentHash: 'deadbeef' }),
    });
    expect(createRes.status).toBe(401);
  });

  it('rejects the content routes when the signature is invalid or expired', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const badSig = await fetch(
      `${started.baseUrl}/byok/blobs/blob_nonexistent/content?sig=not-real&exp=${Date.now() + 60_000}`,
      { method: 'PUT', body: Buffer.from('x') },
    );
    expect(badSig.status).toBe(401);

    const expired = await fetch(`${started.baseUrl}/byok/blobs/blob_nonexistent/content?sig=not-real&exp=${Date.now() - 1}`, {
      method: 'PUT',
      body: Buffer.from('x'),
    });
    expect(expired.status).toBe(401);
  });
});
