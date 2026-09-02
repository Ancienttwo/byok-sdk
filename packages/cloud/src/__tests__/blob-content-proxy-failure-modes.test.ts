/**
 * The three outcomes `GET /byok/blobs/:id/content` can now distinguish, at the
 * wire level: no such blob (404, `undefined` from the proxy — unchanged), and
 * the two upstream failures that used to be indistinguishable from it.
 *
 * A stub `BlobContentProxy` rather than the in-memory one on purpose: the
 * in-memory composition holds the bytes in-process and can therefore never
 * produce either failure code (see `InMemoryBlobContentProxy.readContent`), so
 * only a stub can exercise the branch a real object-storage proxy would take.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { BYOK_BLOB_CONTENT_ROUTE } from '@byok-sdk/protocol';
import { blobDownloadContentHandler } from '../handlers/blobs';
import type { BlobContentProxy, BlobReadResult } from '../stores/ports';

function appFor(read: BlobReadResult | undefined): Hono {
  const contentProxy: BlobContentProxy = {
    verifySignedUrl: async () => true,
    expectedUploadBytes: async () => 0n,
    writeContent: async () => ({ ok: true }),
    readContent: async () => read,
  };
  const app = new Hono();
  app.get(BYOK_BLOB_CONTENT_ROUTE, blobDownloadContentHandler({ contentProxy, maxUploadBytes: 1 }));
  return app;
}

const REQUEST_PATH = '/byok/blobs/blob_1/content?sig=deadbeef&exp=9999999999999';

describe('blob download content: proxy failure modes', () => {
  it('404s when the proxy reports no such blob', async () => {
    const res = await appFor(undefined).request(REQUEST_PATH);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'blob not found' });
  });

  it('502s with blob_upstream_unavailable when the upstream never answered', async () => {
    const res = await appFor({ ok: false, code: 'blob_upstream_unavailable' }).request(REQUEST_PATH);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'blob_upstream_unavailable' });
  });

  it('502s with blob_upstream_stream_interrupted when the response died mid-transfer', async () => {
    const res = await appFor({ ok: false, code: 'blob_upstream_stream_interrupted' }).request(REQUEST_PATH);
    expect(res.status).toBe(502);
    // Same status as the other failure — the CODE is what tells an operator
    // that whatever reached the caller is a truncated prefix.
    expect(await res.json()).toEqual({ error: 'blob_upstream_stream_interrupted' });
  });

  it('still streams the bytes on ok', async () => {
    const res = await appFor({
      ok: true,
      content: { data: new Uint8Array([1, 2, 3]), contentType: 'application/octet-stream' },
    }).request(REQUEST_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
