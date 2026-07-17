import { createHash } from 'node:crypto';
import type { BlobRef } from '@byok/protocol';
import type { AuthManager } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

/** Seam `TaskRunner` depends on, so tests can substitute a fake without spinning up real HTTP endpoints. */
export interface BlobResolver {
  resolveInstruction(blobRef: BlobRef): Promise<string>;
  uploadArtifact(content: string | Uint8Array, contentType: string): Promise<BlobRef>;
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * HTTP-side blob transfer (protocol §7): resolving an instruction `blobRef`
 * into its actual content, and uploading an artifact too large to inline.
 * Both require a valid bearer token, handled via `authedFetch`.
 */
export class BlobClient implements BlobResolver {
  constructor(
    private readonly serverUrl: string,
    private readonly auth: AuthManager,
  ) {}

  /** `blobRef` -> `GET /byok/blobs/:id/url` -> fetch the presigned download URL -> text content. Always resolves fresh rather than trusting any inlined `BlobRef.url`, per docs/protocol.md §7. */
  async resolveInstruction(blobRef: BlobRef): Promise<string> {
    const base = toHttpBase(this.serverUrl);
    const urlRes = await authedFetch(
      new URL(`/byok/blobs/${encodeURIComponent(blobRef.blobId)}/url`, base),
      { method: 'GET' },
      this.auth,
    );
    if (!urlRes.ok) {
      throw new Error(`failed to resolve blob download url: HTTP ${urlRes.status} ${await safeErrorText(urlRes)}`.trimEnd());
    }
    const { downloadUrl } = (await urlRes.json()) as { downloadUrl: string };

    // M1-4 e2e finding: the reference `LocalDiskBlobStore` mints
    // *origin-relative* content URLs (`/byok/blobs/:id/content?sig=...`),
    // same-origin with the rest of `byok.hono` — but a real object-store
    // `BlobStore` (S3/GCS/R2) would return a fully-qualified presigned URL.
    // A bare `fetch(downloadUrl)` throws outright on the relative form (no
    // "current page" for Node's fetch to resolve against — confirmed, not
    // hypothetical); `new URL(x, base)` handles both: relative resolves
    // against the server's own origin, and an already-absolute URL is
    // returned unchanged (base is ignored per the WHATWG URL spec).
    const contentRes = await fetch(new URL(downloadUrl, base));
    if (!contentRes.ok) {
      throw new Error(`failed to download blob content: HTTP ${contentRes.status}`);
    }
    return contentRes.text();
  }

  /** `POST /byok/blobs` (declares size/contentType/contentHash) -> PUT the bytes to the presigned upload URL -> a `BlobRef` for `task.artifact.blobRef`. */
  async uploadArtifact(content: string | Uint8Array, contentType: string): Promise<BlobRef> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const base = toHttpBase(this.serverUrl);

    const createRes = await authedFetch(
      new URL('/byok/blobs', base),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ size: bytes.length, contentType, contentHash }),
      },
      this.auth,
    );
    if (!createRes.ok) {
      throw new Error(`failed to create blob: HTTP ${createRes.status} ${await safeErrorText(createRes)}`.trimEnd());
    }
    const { blobId, uploadUrl } = (await createRes.json()) as { blobId: string; uploadUrl: string };

    // Same relative-vs-absolute handling as resolveInstruction() above.
    const putRes = await fetch(new URL(uploadUrl, base), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: bytes,
    });
    if (!putRes.ok) {
      throw new Error(`failed to upload blob content: HTTP ${putRes.status}`);
    }

    return { blobId, contentHash, size: bytes.length, contentType };
  }
}
