import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Blob flows (docs/protocol.md §7): `POST /byok/blobs` declares a blob and
 * gets back a presigned upload URL; the caller `PUT`s the bytes there
 * directly (no bearer auth on that URL — the HMAC signature + expiry *is*
 * the auth); `GET /byok/blobs/:id/url` mints a presigned download URL the
 * same way. `BlobRef` itself (`@byok-sdk/protocol`'s `blob.ts`) is unchanged;
 * this module is what produces the URLs a `BlobRef` points at.
 *
 * `BlobStore` is interface-shaped so a SaaS can swap in a real object-store
 * (S3/GCS/R2 presigned URLs) later; {@link LocalDiskBlobStore} is the M1
 * reference implementation (single-process, in-memory metadata + files on
 * disk) — good enough for local dev and the SDK's own tests, not meant to
 * survive a restart or run multi-process.
 */

export interface CreateUploadInput {
  size: number;
  contentType: string;
  /** Content-addressed hash the server verifies the uploaded bytes against (§7). Reference impl assumes hex-encoded SHA-256. */
  contentHash: string;
}

export type WriteContentResult = { ok: true } | { ok: false; reason: string };

export interface ReadContentResult {
  data: Buffer;
  contentType: string;
}

export class BlobDeclarationConflictError extends Error {
  constructor(blobId: string) {
    super(`Blob ${blobId} already binds a different declaration.`);
    this.name = 'BlobDeclarationConflictError';
  }
}

export interface BlobStore {
  /** Declare a blob before upload; an explicit id makes the declaration idempotent across host restart. */
  createUpload(input: CreateUploadInput, blobId?: string): Promise<{ blobId: string; uploadUrl: string }>;
  /** A presigned GET URL for a blob that has finished uploading, or `undefined` if unknown/not yet uploaded. */
  getDownloadUrl(blobId: string): Promise<string | undefined>;
  /** Whether `blobId` is known *and* has finished uploading. */
  exists(blobId: string): Promise<boolean>;
  /** Verify a presigned content URL's `sig`/`exp` query params for `action`. */
  verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): boolean;
  /** Accept uploaded bytes; rejects (without storing) on size/hash mismatch against the `createUpload` declaration. */
  writeContent(blobId: string, data: Buffer): Promise<WriteContentResult>;
  /** Read back previously-uploaded bytes, or `undefined` if unknown/not yet uploaded. */
  readContent(blobId: string): Promise<ReadContentResult | undefined>;
}

interface BlobRecord {
  meta: CreateUploadInput;
  uploaded: boolean;
}

export interface LocalDiskBlobStoreOptions {
  /** Directory blob content is written under. Defaults to a fresh OS temp dir. */
  directory?: string;
  /** How long a presigned upload/download URL stays valid, ms. Default 15 minutes. */
  urlTtlMs?: number;
}

const DEFAULT_URL_TTL_MS = 15 * 60 * 1000;

/** docs/protocol.md §7 now pins the canonical `contentHash` format (`sha256:<64 lowercase hex>`, finding F9 — `CONTENT_HASH_RE` in `@byok-sdk/protocol`'s `blob.ts`), enforced at the schema level on every inbound `CreateBlobRequest`/`BlobRef`. Comparison here is therefore a straight string match — no normalization, no compat shim; anything else was already rejected before reaching this store. */
function sha256Hex(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** Local-disk reference {@link BlobStore}: in-memory metadata, content on disk, HMAC-signed expiring URLs. */
export class LocalDiskBlobStore implements BlobStore {
  private readonly secret = randomBytes(32);
  private readonly directory: string;
  private readonly urlTtlMs: number;
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly ready: Promise<void>;

  constructor(opts: LocalDiskBlobStoreOptions = {}) {
    this.directory = opts.directory ?? mkdtempSync(path.join(tmpdir(), 'byok-blobs-'));
    this.urlTtlMs = opts.urlTtlMs ?? DEFAULT_URL_TTL_MS;
    this.ready = mkdir(this.directory, { recursive: true }).then(() => undefined);
  }

  async createUpload(input: CreateUploadInput, requestedBlobId?: string): Promise<{ blobId: string; uploadUrl: string }> {
    await this.ready;
    const blobId = requestedBlobId ?? `blob_${randomUUID()}`;
    const existing = this.blobs.get(blobId);
    if (existing !== undefined) {
      if (
        existing.meta.size !== input.size ||
        existing.meta.contentType !== input.contentType ||
        existing.meta.contentHash !== input.contentHash
      ) {
        throw new BlobDeclarationConflictError(blobId);
      }
      return { blobId, uploadUrl: this.signUrl(blobId, 'put') };
    }
    this.blobs.set(blobId, { meta: input, uploaded: false });
    return { blobId, uploadUrl: this.signUrl(blobId, 'put') };
  }

  async getDownloadUrl(blobId: string): Promise<string | undefined> {
    const record = this.blobs.get(blobId);
    if (!record?.uploaded) return undefined;
    return this.signUrl(blobId, 'get');
  }

  async exists(blobId: string): Promise<boolean> {
    return this.blobs.get(blobId)?.uploaded ?? false;
  }

  verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): boolean {
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    const expected = this.computeSig(blobId, action, exp);
    const expectedBuf = Buffer.from(expected, 'base64url');
    const actualBuf = Buffer.from(sig, 'base64url');
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  async writeContent(blobId: string, data: Buffer): Promise<WriteContentResult> {
    await this.ready;
    const record = this.blobs.get(blobId);
    if (!record) return { ok: false, reason: 'unknown blobId' };
    if (record.uploaded) return { ok: false, reason: 'blob already uploaded' };
    if (data.length !== record.meta.size) {
      return { ok: false, reason: `size mismatch: declared ${record.meta.size}, received ${data.length}` };
    }
    const actualHash = sha256Hex(data);
    if (actualHash !== record.meta.contentHash) {
      return { ok: false, reason: 'contentHash mismatch' };
    }
    await writeFile(this.pathFor(blobId), data);
    record.uploaded = true;
    return { ok: true };
  }

  async readContent(blobId: string): Promise<ReadContentResult | undefined> {
    const record = this.blobs.get(blobId);
    if (!record?.uploaded) return undefined;
    const data = await readFile(this.pathFor(blobId));
    return { data, contentType: record.meta.contentType };
  }

  private pathFor(blobId: string): string {
    return path.join(this.directory, blobId);
  }

  private computeSig(blobId: string, action: 'put' | 'get', exp: number): string {
    return createHmac('sha256', this.secret).update(`${blobId}:${action}:${exp}`).digest('base64url');
  }

  private signUrl(blobId: string, action: 'put' | 'get'): string {
    const exp = Date.now() + this.urlTtlMs;
    const sig = this.computeSig(blobId, action, exp);
    return `/byok/blobs/${blobId}/content?sig=${sig}&exp=${exp}`;
  }
}
