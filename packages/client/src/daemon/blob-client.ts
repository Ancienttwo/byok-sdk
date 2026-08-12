import { createHash, randomUUID } from 'node:crypto';
import { BYOK_BLOBS_PATH, byokBlobFinalizePath, byokBlobUrlPath } from '@byok-sdk/protocol';
import type { BlobRef } from '@byok-sdk/protocol';
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
      new URL(byokBlobUrlPath(blobRef.blobId), base),
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
    const bytes = new Uint8Array(await contentRes.arrayBuffer());
    const observedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (observedHash !== blobRef.contentHash || bytes.length !== blobRef.size) {
      throw new Error(
        `downloaded blob failed declared integrity: expected ${blobRef.contentHash}/${blobRef.size} bytes, observed ${observedHash}/${bytes.length} bytes`,
      );
    }
    return new TextDecoder().decode(bytes);
  }

  /** `POST /byok/blobs` (declares size/contentType/contentHash) -> PUT the bytes to the presigned upload URL -> a `BlobRef` for `task.artifact.blobRef`. */
  async uploadArtifact(content: string | Uint8Array, contentType: string): Promise<BlobRef> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const base = toHttpBase(this.serverUrl);
    const reservationId = `blob_${randomUUID()}`;

    const createRes = await authedFetch(
      new URL(BYOK_BLOBS_PATH, base),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': reservationId,
        },
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

    await this.#finalize(base, blobId, reservationId);

    return { blobId, contentHash, size: bytes.length, contentType };
  }

  async #finalize(base: string, blobId: string, reservationId: string): Promise<void> {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let response: Response;
      try {
        response = await authedFetch(
          new URL(byokBlobFinalizePath(blobId), base),
          {
            method: 'POST',
            headers: { 'idempotency-key': reservationId },
          },
          this.auth,
        );
      } catch (error) {
        lastFailure = error;
        if (attempt === 2) throw error;
        continue;
      }
      if (response.ok) return;
      if (response.status < 500 || attempt === 2) {
        throw new Error(
          `failed to finalize blob: HTTP ${response.status} ${await safeErrorText(response)}`.trimEnd(),
        );
      }
      lastFailure = new Error(`failed to finalize blob: HTTP ${response.status}`);
    }
    throw lastFailure;
  }
}
