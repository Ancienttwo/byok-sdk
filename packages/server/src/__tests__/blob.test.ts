import type { Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { pairFakeDaemon, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';

/** Canonical `contentHash` form (finding F9): `sha256:<64 lowercase hex>` — the only form the schema now accepts. */
function sha256Hex(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
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

  /**
   * Finding F9 (contentHash accepts any prefix): docs/protocol.md §7 now
   * pins the canonical format exactly (`sha256:<64 lowercase hex>`) and the
   * server rejects anything else outright — no normalization compat shim.
   * This supersedes the old "accepts a contentHash with an explicit sha256:
   * prefix" test, which existed only because the server used to *also*
   * accept a bare, unprefixed hex hash (via `normalizeContentHash`); that
   * latitude is gone.
   */
  it('rejects a declare request whose contentHash is not the canonical "sha256:<64 lowercase hex>" form', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const content = Buffer.from('some content');
    const bareHex = createHash('sha256').update(content).digest('hex'); // no "sha256:" prefix — no longer accepted

    const cases = [
      bareHex,
      `SHA256:${bareHex}`, // wrong case on the algorithm tag
      `sha256:${bareHex.toUpperCase()}`, // wrong case on the hex digits
      `sha256:${bareHex.slice(0, 63)}`, // too short
      'deadbeef',
    ];

    for (const contentHash of cases) {
      const createRes = await fetch(`${started.baseUrl}/byok/blobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ size: content.length, contentType: 'text/plain', contentHash }),
      });
      expect(createRes.status, `expected 400 for contentHash ${JSON.stringify(contentHash)}`).toBe(400);
    }
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
      body: JSON.stringify({
        size: 2048,
        contentType: 'application/octet-stream',
        contentHash: sha256Hex(Buffer.from('oversized-declaration')),
      }),
    });
    expect(createRes.status).toBe(413);
  });

  it('defaults the per-product cap to 100MB when not configured', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);
    const validHash = sha256Hex(Buffer.from('cap-probe'));

    const overCap = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: 100 * 1024 * 1024 + 1, contentType: 'application/octet-stream', contentHash: validHash }),
    });
    expect(overCap.status).toBe(413);

    const underCap = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: 1024, contentType: 'application/octet-stream', contentHash: validHash }),
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
      body: JSON.stringify({ size: 10, contentType: 'text/plain', contentHash: sha256Hex(Buffer.from('x')) }),
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
