import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { byokBlobContentPath } from '@byok-sdk/protocol';
import type { TenantId } from './auth';

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
 * reference implementation (single-process, persisted metadata + files on
 * disk) — good enough for local dev and the SDK's own tests, including a
 * restart of the same directory; it is not multi-process storage.
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

/** The upload reservation HTTP must resolve before it starts retaining bytes. */
export interface BlobUploadReservation {
  size: number;
}

export class BlobDeclarationConflictError extends Error {
  constructor(blobId: string) {
    super(`Blob ${blobId} already binds a different declaration.`);
    this.name = 'BlobDeclarationConflictError';
  }
}

export interface BlobStore {
  /** Declare a blob before upload; an explicit id makes the declaration idempotent across host restart. */
  createUpload(tenantId: TenantId, input: CreateUploadInput, blobId?: string): Promise<{ blobId: string; uploadUrl: string }>;
  /** A presigned GET URL for a blob that has finished uploading, or `undefined` if unknown/not yet uploaded. */
  getDownloadUrl(tenantId: TenantId, blobId: string): Promise<string | undefined>;
  /** Whether `blobId` is known *and* has finished uploading. */
  exists(tenantId: TenantId, blobId: string): Promise<boolean>;
  /** Resolve a capability URL's immutable declared size before consuming its body. */
  getUploadReservation(blobId: string): Promise<BlobUploadReservation | undefined>;
  /** Verify a presigned content URL's `sig`/`exp` query params for `action`. */
  verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): boolean;
  /** Accept uploaded bytes; rejects (without storing) on size/hash mismatch against the `createUpload` declaration. */
  writeContent(blobId: string, data: Buffer): Promise<WriteContentResult>;
  /** Read back previously-uploaded bytes, or `undefined` if unknown/not yet uploaded. */
  readContent(blobId: string): Promise<ReadContentResult | undefined>;
}

interface BlobRecord {
  tenantId: TenantId;
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

/** Local-disk reference {@link BlobStore}: persisted metadata/content and HMAC-signed expiring URLs. */
export class LocalDiskBlobStore implements BlobStore {
  private secret = randomBytes(32);
  private readonly directory: string;
  private readonly metadataPath: string;
  private readonly urlTtlMs: number;
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly ready: Promise<void>;
  private metadataWriteTail: Promise<void> = Promise.resolve();

  constructor(opts: LocalDiskBlobStoreOptions = {}) {
    this.directory = opts.directory ?? mkdtempSync(path.join(tmpdir(), 'byok-blobs-'));
    this.metadataPath = path.join(this.directory, 'metadata.json');
    this.urlTtlMs = opts.urlTtlMs ?? DEFAULT_URL_TTL_MS;
    this.ready = mkdir(this.directory, { recursive: true }).then(() => this.loadMetadata());
  }

  async createUpload(tenantId: TenantId, input: CreateUploadInput, requestedBlobId?: string): Promise<{ blobId: string; uploadUrl: string }> {
    await this.ready;
    const blobId = requestedBlobId ?? `blob_${randomUUID()}`;
    const existing = this.blobs.get(blobId);
    if (existing !== undefined) {
      if (
        existing.tenantId !== tenantId ||
        existing.meta.size !== input.size ||
        existing.meta.contentType !== input.contentType ||
        existing.meta.contentHash !== input.contentHash
      ) {
        throw new BlobDeclarationConflictError(blobId);
      }
      return { blobId, uploadUrl: this.signUrl(blobId, 'put') };
    }
    this.blobs.set(blobId, { tenantId, meta: input, uploaded: false });
    await this.persistMetadata();
    return { blobId, uploadUrl: this.signUrl(blobId, 'put') };
  }

  async getDownloadUrl(tenantId: TenantId, blobId: string): Promise<string | undefined> {
    await this.ready;
    const record = this.blobs.get(blobId);
    if (!record?.uploaded || record.tenantId !== tenantId) return undefined;
    return this.signUrl(blobId, 'get');
  }

  async exists(tenantId: TenantId, blobId: string): Promise<boolean> {
    await this.ready;
    const record = this.blobs.get(blobId);
    return record?.tenantId === tenantId && record.uploaded;
  }

  async getUploadReservation(blobId: string): Promise<BlobUploadReservation | undefined> {
    await this.ready;
    const record = this.blobs.get(blobId);
    return record === undefined ? undefined : { size: record.meta.size };
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
    await this.persistMetadata();
    return { ok: true };
  }

  async readContent(blobId: string): Promise<ReadContentResult | undefined> {
    await this.ready;
    const record = this.blobs.get(blobId);
    if (!record?.uploaded) return undefined;
    const data = await readFile(this.pathFor(blobId));
    return { data, contentType: record.meta.contentType };
  }

  private pathFor(blobId: string): string {
    return path.join(this.directory, blobId);
  }

  private async loadMetadata(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.metadataPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isBlobMetadataDocument(parsed)) {
      throw new Error('invalid LocalDiskBlobStore metadata document');
    }
    for (const entry of parsed.blobs) {
      this.blobs.set(entry.blobId, {
        tenantId: entry.tenantId,
        meta: entry.meta,
        uploaded: entry.uploaded,
      });
    }
    this.secret = Buffer.from(parsed.signingSecret, 'base64url');
  }

  private async persistMetadata(): Promise<void> {
    const write = this.metadataWriteTail.then(async () => {
      // Snapshot only after earlier writes have committed. Taking the snapshot
      // before joining the queue would let a slow old rename overwrite newer
      // tenant/upload metadata.
      const metadata = {
        version: 1,
        signingSecret: this.secret.toString('base64url'),
        blobs: [...this.blobs.entries()].map(([blobId, record]) => ({ blobId, ...record })),
      };
      const temporaryPath = `${this.metadataPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(metadata), 'utf8');
      await rename(temporaryPath, this.metadataPath);
    });
    this.metadataWriteTail = write.catch(() => undefined);
    await write;
  }

  private computeSig(blobId: string, action: 'put' | 'get', exp: number): string {
    return createHmac('sha256', this.secret).update(`${blobId}:${action}:${exp}`).digest('base64url');
  }

  private signUrl(blobId: string, action: 'put' | 'get'): string {
    const exp = Date.now() + this.urlTtlMs;
    const sig = this.computeSig(blobId, action, exp);
    return `${byokBlobContentPath(blobId)}?sig=${sig}&exp=${exp}`;
  }
}

function isBlobMetadataDocument(value: unknown): value is {
  version: 1;
  signingSecret: string;
  blobs: Array<{ blobId: string; tenantId: TenantId; meta: CreateUploadInput; uploaded: boolean }>;
} {
  if (typeof value !== 'object' || value === null) return false;
  const document = value as { version?: unknown; signingSecret?: unknown; blobs?: unknown };
  if (document.version !== 1 || typeof document.signingSecret !== 'string' || !Array.isArray(document.blobs)) return false;
  const signingSecret = Buffer.from(document.signingSecret, 'base64url');
  if (signingSecret.length !== 32) return false;
  return document.blobs.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const candidate = entry as { blobId?: unknown; tenantId?: unknown; meta?: unknown; uploaded?: unknown };
    if (typeof candidate.blobId !== 'string' || typeof candidate.tenantId !== 'string' || typeof candidate.uploaded !== 'boolean') return false;
    if (typeof candidate.meta !== 'object' || candidate.meta === null) return false;
    const meta = candidate.meta as { size?: unknown; contentType?: unknown; contentHash?: unknown };
    return typeof meta.size === 'number' && Number.isSafeInteger(meta.size) && meta.size >= 0 && typeof meta.contentType === 'string' && typeof meta.contentHash === 'string';
  });
}
