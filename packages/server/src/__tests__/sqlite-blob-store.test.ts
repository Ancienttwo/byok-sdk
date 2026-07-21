import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { SqliteBlobStore } from '../sqlite-blob-store';
import { isSqliteCapableNodeVersion } from '../sqlite-support';
import { pairFakeDaemon, startServer, stopServer } from './test-support';

// node:sqlite requires Node 22.5+. The core SDK works on the declared Node 20
// floor with the default LocalDiskBlobStore; these SQLite reference-store tests
// skip on older runtimes (the CI Node 20 leg) rather than fail the whole leg.
const sqliteReady = isSqliteCapableNodeVersion(process.versions.node);

/** Canonical `contentHash` form (docs/protocol.md §7, finding F9): `sha256:<64 lowercase hex>` — same helper `blob.test.ts` uses. */
function sha256Hex(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return path.join(dir, 'blobs.db');
}

/** Pull `sig`/`exp` off a relative presigned URL (`/byok/blobs/:id/content?sig=...&exp=...`) so a test can call `verifySignedUrl` directly without going through HTTP. */
function parseSignedUrl(url: string): { sig: string; exp: number } {
  const { searchParams } = new URL(url, 'http://local.test');
  const sig = searchParams.get('sig');
  const exp = searchParams.get('exp');
  if (!sig || exp === null) throw new Error(`not a signed url: ${url}`);
  return { sig, exp: Number(exp) };
}

describe.skipIf(!sqliteReady)('SqliteBlobStore', () => {
  it('round-trips content through createUpload -> writeContent -> readContent (same contract as LocalDiskBlobStore)', async () => {
    const store = new SqliteBlobStore({ path: ':memory:' });
    const content = Buffer.from('hello sqlite blob world');
    const contentHash = sha256Hex(content);

    const { blobId, uploadUrl } = await store.createUpload({ size: content.length, contentType: 'text/plain', contentHash });
    expect(blobId).toBeTruthy();
    expect(uploadUrl).toMatch(new RegExp(`^/byok/blobs/${blobId}/content\\?sig=.+&exp=\\d+$`));

    expect(await store.exists(blobId)).toBe(false);
    expect(await store.getDownloadUrl(blobId)).toBeUndefined();

    const writeResult = await store.writeContent(blobId, content);
    expect(writeResult).toEqual({ ok: true });

    expect(await store.exists(blobId)).toBe(true);
    const downloadUrl = await store.getDownloadUrl(blobId);
    expect(downloadUrl).toMatch(new RegExp(`^/byok/blobs/${blobId}/content\\?sig=.+&exp=\\d+$`));

    const read = await store.readContent(blobId);
    expect(read?.data.equals(content)).toBe(true);
    expect(read?.contentType).toBe('text/plain');
  });

  it('rejects writeContent on a size mismatch, without storing anything', async () => {
    const store = new SqliteBlobStore({ path: ':memory:' });
    const content = Buffer.from('hello');
    const contentHash = sha256Hex(content);
    const { blobId } = await store.createUpload({ size: content.length, contentType: 'text/plain', contentHash });

    const result = await store.writeContent(blobId, Buffer.from('hello world'));
    expect(result.ok).toBe(false);
    expect(await store.exists(blobId)).toBe(false);
  });

  it('rejects writeContent on a contentHash mismatch, without storing anything', async () => {
    const store = new SqliteBlobStore({ path: ':memory:' });
    const content = Buffer.from('hello');
    const contentHash = sha256Hex(content);
    const { blobId } = await store.createUpload({ size: content.length, contentType: 'text/plain', contentHash });

    // Same length as declared, different bytes -> different hash.
    const tampered = Buffer.from('HELLO');
    const result = await store.writeContent(blobId, tampered);
    expect(result.ok).toBe(false);
    expect(await store.exists(blobId)).toBe(false);

    const ok = await store.writeContent(blobId, content);
    expect(ok).toEqual({ ok: true });
  });

  it('treats an unknown blobId as not found across every read path', async () => {
    const store = new SqliteBlobStore({ path: ':memory:' });
    expect((await store.writeContent('blob_nope', Buffer.from('x'))).ok).toBe(false);
    expect(await store.readContent('blob_nope')).toBeUndefined();
    expect(await store.getDownloadUrl('blob_nope')).toBeUndefined();
    expect(await store.exists('blob_nope')).toBe(false);
  });

  it('bytes written via one instance are read back byte-identical via a second instance on the same db file (restart-safety)', async () => {
    const dbPath = tempDbPath('byok-sqlite-blob-restart-');
    const content = Buffer.from('raw store-level restart-safety bytes \x00\x01\x02', 'utf8');
    const contentHash = sha256Hex(content);

    const storeA = new SqliteBlobStore({ path: dbPath });
    const { blobId } = await storeA.createUpload({
      size: content.length,
      contentType: 'application/octet-stream',
      contentHash,
    });
    expect(await storeA.writeContent(blobId, content)).toEqual({ ok: true });
    storeA.close(); // simulates the process exiting

    const storeB = new SqliteBlobStore({ path: dbPath });
    const read = await storeB.readContent(blobId);
    expect(read?.data.equals(content)).toBe(true);
    expect(read?.contentType).toBe('application/octet-stream');
    expect(await storeB.exists(blobId)).toBe(true);
    storeB.close();
  });

  it('the HMAC signing secret itself persists across restart: a URL signed by instance A verifies via instance B', async () => {
    const dbPath = tempDbPath('byok-sqlite-blob-sig-');
    const content = Buffer.from('signed url restart check');
    const contentHash = sha256Hex(content);

    const storeA = new SqliteBlobStore({ path: dbPath });
    const { blobId, uploadUrl } = await storeA.createUpload({ size: content.length, contentType: 'text/plain', contentHash });
    await storeA.writeContent(blobId, content);
    const downloadUrl = (await storeA.getDownloadUrl(blobId))!;
    storeA.close();

    const storeB = new SqliteBlobStore({ path: dbPath });
    const put = parseSignedUrl(uploadUrl);
    expect(storeB.verifySignedUrl(blobId, 'put', put.sig, put.exp)).toBe(true);
    const get = parseSignedUrl(downloadUrl);
    expect(storeB.verifySignedUrl(blobId, 'get', get.sig, get.exp)).toBe(true);
    // A signature for the wrong action must still fail.
    expect(storeB.verifySignedUrl(blobId, 'get', put.sig, put.exp)).toBe(false);
    storeB.close();
  });
});

describe.skipIf(!sqliteReady)('createByokServer({ blobStore: new SqliteBlobStore(...) }) restart-safety', () => {
  it('a blob uploaded through one live server is downloadable through a second server instance on the same db file, via the exact same presigned URL', async () => {
    const dbPath = tempDbPath('byok-sqlite-blob-server-');
    const content = Buffer.from('end-to-end sqlite blob restart-safety');
    const contentHash = sha256Hex(content);

    const storeA = new SqliteBlobStore({ path: dbPath });
    const byokA = createByokServer({ productId: 'acme', blobStore: storeA });
    const startedA = await startServer(byokA);
    const { code } = byokA.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(startedA.baseUrl, code);

    const createRes = await fetch(`${startedA.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ size: content.length, contentType: 'text/plain', contentHash }),
    });
    expect(createRes.status).toBe(200);
    const { blobId, uploadUrl } = (await createRes.json()) as { blobId: string; uploadUrl: string };

    const putRes = await fetch(`${startedA.baseUrl}${uploadUrl}`, { method: 'PUT', body: content });
    expect(putRes.status).toBe(204);

    const urlRes = await fetch(`${startedA.baseUrl}/byok/blobs/${blobId}/url`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { downloadUrl } = (await urlRes.json()) as { downloadUrl: string };

    await stopServer(startedA.server);
    byokA.stop();
    storeA.close();

    // "Restart": a brand-new server + a brand-new SqliteBlobStore instance,
    // pointed at the exact same file. Reuses the *same* downloadUrl string
    // minted by instance A above — proving the signing secret persisted,
    // not just the blob metadata/bytes.
    const storeB = new SqliteBlobStore({ path: dbPath });
    const byokB = createByokServer({ productId: 'acme', blobStore: storeB });
    const startedB = await startServer(byokB);

    const getRes = await fetch(`${startedB.baseUrl}${downloadUrl}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('text/plain');
    const downloaded = Buffer.from(await getRes.arrayBuffer());
    expect(downloaded.equals(content)).toBe(true);

    await stopServer(startedB.server);
    byokB.stop();
    storeB.close();
  });
});
