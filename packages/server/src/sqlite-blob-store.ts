import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { BlobStore, CreateUploadInput, ReadContentResult, WriteContentResult } from './blob-store';
import { openSqliteDatabase, secureSqliteFilePermissions } from './sqlite-support';

export interface SqliteBlobStoreOptions {
  /**
   * Database file path. Use `:memory:` to exercise the SQLite code path
   * without persistence — defeats this store's whole purpose (same caveat
   * as `SqliteTaskStore`'s `:memory:` option); real restart-safety requires
   * a real file path.
   */
  path: string;
  /** How long a presigned upload/download URL stays valid, ms. Default 15 minutes — same default as `LocalDiskBlobStore`. */
  urlTtlMs?: number;
  /**
   * HMAC signing key for presigned URLs. Defaults to a key generated once
   * and persisted in this same database (a `meta` table) — so, unlike
   * `LocalDiskBlobStore`'s fresh-per-instance `randomBytes(32)` (fine there
   * only because its metadata doesn't survive a restart either), the
   * default here is *already* stable across restarts: a URL signed by one
   * process instance still verifies against a later instance pointed at
   * the same database file. Pass this explicitly only if the key needs to
   * live outside the database (e.g. shared across multiple database files,
   * or rotated independently of the data).
   */
  signingKey?: Buffer;
}

/** Exported (only) so `sqlite-blob-store.test.ts` can apply the same schema to a raw `DatabaseSync` connection when testing {@link loadOrCreateSigningSecret}'s concurrency behavior directly. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  blob_id      TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  uploaded     INTEGER NOT NULL DEFAULT 0,
  data         BLOB
);
`;

const DEFAULT_URL_TTL_MS = 15 * 60 * 1000;
const SIGNING_SECRET_META_KEY = 'signing_secret';

/** §7 canonical form: `sha256:<64 lowercase hex>` (finding F9, enforced at the schema level on every inbound request before it reaches any `BlobStore`) — comparison here is a straight string match, mirroring `LocalDiskBlobStore`. */
function sha256Hex(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** Wrap a `node:sqlite` BLOB read (a `Uint8Array`-shaped value) as a `Buffer` view over the same bytes, no copy. */
function toBuffer(value: unknown): Buffer {
  const view = value as Uint8Array;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

interface BlobRow {
  size: number;
  content_type: string;
  content_hash: string;
  uploaded: number;
  data: unknown;
}

/**
 * Atomically load the persisted HMAC signing secret from `db`'s `meta`
 * table, generating and persisting one if none exists yet.
 *
 * Safe under two `DatabaseSync` connections racing on the same file — e.g.
 * two fresh `SqliteBlobStore` instances constructed against a brand-new
 * database at nearly the same moment. Both may see no existing row (via the
 * initial `SELECT`) and both generate a candidate secret, but `INSERT OR
 * IGNORE` guarantees at most one candidate is ever persisted, and —
 * critically — EVERY caller unconditionally re-reads the row afterward and
 * returns THAT value, never its own locally-generated candidate. Without
 * that re-read (the bug this fixes: the previous implementation used
 * `INSERT OR REPLACE` and returned its own candidate unconditionally), a
 * caller whose candidate lost the race would keep using its own discarded
 * value in memory — so a presigned URL it signs would fail to verify
 * against any other instance, which persisted (and uses) the winning value.
 *
 * `generateCandidate` defaults to `randomBytes(32)`; overridable so
 * `sqlite-blob-store.test.ts` can deterministically force the race window —
 * real callers never need to pass it.
 */
export function loadOrCreateSigningSecret(
  db: DatabaseSync,
  generateCandidate: () => Buffer = () => randomBytes(32),
): Buffer {
  const selectStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const existing = selectStmt.get(SIGNING_SECRET_META_KEY) as { value: string } | undefined;
  if (existing) return Buffer.from(existing.value, 'hex');

  const candidate = generateCandidate();
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    SIGNING_SECRET_META_KEY,
    candidate.toString('hex'),
  );

  // Re-read regardless of whether OUR insert is what actually landed: if a
  // concurrent connection's INSERT committed first, this returns ITS value.
  const persisted = selectStmt.get(SIGNING_SECRET_META_KEY) as { value: string } | undefined;
  if (!persisted) {
    // Unreachable in practice — INSERT OR IGNORE guarantees a row exists by
    // now (ours or a racing connection's). A loud failure here rather than
    // silently generating yet another candidate keeps this from masking a
    // genuinely broken database.
    throw new Error('failed to initialize SQLite blob store signing secret');
  }
  return Buffer.from(persisted.value, 'hex');
}

/**
 * Persistent {@link BlobStore} backed by `node:sqlite` — no native
 * dependency, same rationale as `SqliteTaskStore` (`sqlite-support.ts`).
 * Metadata AND content bytes both live in the same database file (a `data
 * BLOB` column), so a fresh instance pointed at the same file recovers
 * everything: declared blobs, upload state, and the bytes themselves,
 * byte-for-byte.
 *
 * Presigned URLs use the same HMAC-signed-query-param scheme as
 * `LocalDiskBlobStore` (`/byok/blobs/:id/content?sig=...&exp=...`, verified
 * generically by `http.ts` via {@link verifySignedUrl} regardless of which
 * `BlobStore` is plugged in) — the only difference is where the signing
 * secret comes from; see {@link SqliteBlobStoreOptions.signingKey}.
 *
 * Requires Node.js 22.5+ (`node:sqlite`'s minimum); constructing this on an
 * unsupported runtime throws `SqliteUnavailableError` (`sqlite-support.ts`).
 */
export class SqliteBlobStore implements BlobStore {
  private readonly db: DatabaseSync;
  private readonly urlTtlMs: number;
  private readonly secret: Buffer;
  private readonly insertBlobStmt: StatementSync;
  private readonly selectBlobStmt: StatementSync;
  private readonly selectUploadedStmt: StatementSync;
  private readonly writeContentStmt: StatementSync;

  constructor(opts: SqliteBlobStoreOptions) {
    this.db = openSqliteDatabase(opts.path);
    this.db.exec(SCHEMA);
    secureSqliteFilePermissions(opts.path);
    this.urlTtlMs = opts.urlTtlMs ?? DEFAULT_URL_TTL_MS;
    this.secret = opts.signingKey ?? loadOrCreateSigningSecret(this.db);

    this.insertBlobStmt = this.db.prepare(
      `INSERT INTO blobs (blob_id, size, content_type, content_hash, uploaded, data)
       VALUES (?, ?, ?, ?, 0, NULL)`,
    );
    this.selectBlobStmt = this.db.prepare(
      'SELECT size, content_type, content_hash, uploaded, data FROM blobs WHERE blob_id = ?',
    );
    this.selectUploadedStmt = this.db.prepare('SELECT uploaded FROM blobs WHERE blob_id = ?');
    this.writeContentStmt = this.db.prepare('UPDATE blobs SET data = ?, uploaded = 1 WHERE blob_id = ?');
  }

  async createUpload(input: CreateUploadInput): Promise<{ blobId: string; uploadUrl: string }> {
    const blobId = `blob_${randomUUID()}`;
    this.insertBlobStmt.run(blobId, input.size, input.contentType, input.contentHash);
    return { blobId, uploadUrl: this.signUrl(blobId, 'put') };
  }

  async getDownloadUrl(blobId: string): Promise<string | undefined> {
    const row = this.selectUploadedStmt.get(blobId) as { uploaded: number } | undefined;
    if (!row?.uploaded) return undefined;
    return this.signUrl(blobId, 'get');
  }

  async exists(blobId: string): Promise<boolean> {
    const row = this.selectUploadedStmt.get(blobId) as { uploaded: number } | undefined;
    return Boolean(row?.uploaded);
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
    const row = this.selectBlobStmt.get(blobId) as BlobRow | undefined;
    if (!row) return { ok: false, reason: 'unknown blobId' };
    if (data.length !== row.size) {
      return { ok: false, reason: `size mismatch: declared ${row.size}, received ${data.length}` };
    }
    const actualHash = sha256Hex(data);
    if (actualHash !== row.content_hash) {
      return { ok: false, reason: 'contentHash mismatch' };
    }
    this.writeContentStmt.run(data, blobId);
    return { ok: true };
  }

  async readContent(blobId: string): Promise<ReadContentResult | undefined> {
    const row = this.selectBlobStmt.get(blobId) as BlobRow | undefined;
    if (!row?.uploaded || row.data === null || row.data === undefined) return undefined;
    return { data: toBuffer(row.data), contentType: row.content_type };
  }

  /** Close the underlying database connection — see `SqliteTaskStore.close`'s doc comment; same rationale. */
  close(): void {
    this.db.close();
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
