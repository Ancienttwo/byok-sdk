/**
 * In-memory {@link CloudBlobStore}: metadata and bytes in process memory,
 * HMAC-signed expiring URLs (docs/protocol.md §7).
 *
 * The presigned URL form — `/byok/blobs/<id>/content?sig=&exp=` — is the
 * relative shape the daemon's blob client already resolves against its server
 * base, so a hosted deployment is indistinguishable from a self-hosted one on
 * this route too.
 *
 * Tenancy: `createUpload` records the owning tenant and `getDownloadUrl`
 * refuses to mint for any other, so the two bearer-authed routes are
 * tenant-closed. The two `/content` routes are presigned by construction and
 * have no principal at all — the signature over the blob id IS the credential
 * (same posture as the reference server, §7).
 */
import type { Clock, TenantId } from '@byok/core';
import type { CloudCrypto } from '../../crypto/port';
import type { BlobContent, BlobDeclaration, BlobWriteResult, CloudBlobStore } from '../ports';

/** How long a presigned upload/download URL stays valid. */
export const BLOB_URL_TTL_MS = 15 * 60 * 1000;

const SIGNING_SECRET_BYTES = 32;

interface BlobRecord {
  readonly tenantId: TenantId;
  readonly declaration: BlobDeclaration;
  uploaded: boolean;
  data?: Uint8Array;
}

export interface InMemoryBlobStoreOptions {
  readonly urlTtlMs?: number;
}

export class InMemoryCloudBlobStore implements CloudBlobStore {
  readonly #blobs = new Map<string, BlobRecord>();
  readonly #clock: Clock;
  readonly #crypto: CloudCrypto;
  readonly #secret: Uint8Array;
  readonly #urlTtlMs: number;

  constructor(clock: Clock, crypto: CloudCrypto, options: InMemoryBlobStoreOptions = {}) {
    this.#clock = clock;
    this.#crypto = crypto;
    this.#secret = globalThis.crypto.getRandomValues(new Uint8Array(SIGNING_SECRET_BYTES));
    this.#urlTtlMs = options.urlTtlMs ?? BLOB_URL_TTL_MS;
  }

  async createUpload(tenant: TenantId, input: BlobDeclaration): Promise<{ blobId: string; uploadUrl: string }> {
    const blobId = `blob_${this.#crypto.randomUuid()}`;
    this.#blobs.set(blobId, { tenantId: tenant, declaration: input, uploaded: false });
    return { blobId, uploadUrl: await this.#signUrl(blobId, 'put') };
  }

  async getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined> {
    const record = this.#blobs.get(blobId);
    // Another tenant's blob and a blob that does not exist answer identically.
    if (record === undefined || record.tenantId !== tenant || !record.uploaded) return undefined;
    return this.#signUrl(blobId, 'get');
  }

  async verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean> {
    if (!Number.isFinite(exp) || this.#clock.now().getTime() > exp) return false;
    const expected = await this.#computeSig(blobId, action, exp);
    return this.#crypto.timingSafeEqual(expected, sig);
  }

  async writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult> {
    const record = this.#blobs.get(blobId);
    if (record === undefined) return { ok: false, reason: 'unknown blobId' };
    if (data.length !== record.declaration.size) {
      return { ok: false, reason: `size mismatch: declared ${record.declaration.size}, received ${data.length}` };
    }
    const actualHash = await this.#crypto.sha256(data);
    if (actualHash !== record.declaration.contentHash) {
      return { ok: false, reason: 'contentHash mismatch' };
    }
    record.data = data;
    record.uploaded = true;
    return { ok: true };
  }

  async readContent(blobId: string): Promise<BlobContent | undefined> {
    const record = this.#blobs.get(blobId);
    if (record === undefined || !record.uploaded || record.data === undefined) return undefined;
    return { data: record.data, contentType: record.declaration.contentType };
  }

  async #signUrl(blobId: string, action: 'put' | 'get'): Promise<string> {
    const exp = this.#clock.now().getTime() + this.#urlTtlMs;
    const sig = await this.#computeSig(blobId, action, exp);
    return `/byok/blobs/${blobId}/content?sig=${sig}&exp=${exp}`;
  }

  #computeSig(blobId: string, action: 'put' | 'get', exp: number): Promise<string> {
    return this.#crypto.hmacSha256(this.#secret, `${blobId}:${action}:${exp}`);
  }
}
