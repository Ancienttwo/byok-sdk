/**
 * The R2/S3 {@link CloudBlobStore} — grants, and only grants (§12.7.4, §12.7.7).
 *
 * Zero bytes cross this file either, but for the opposite reason to
 * `stores/core/objects.ts`: the manifest store holds metadata because bytes are
 * not its job, and this store holds no bytes because the DEVICE talks to the
 * object store directly. What it mints is a presigned URL; what the device does
 * with it is between the device and R2. That is why this composition supplies
 * no `BlobContentProxy` — there is no byte path here to proxy, and the absence
 * is the honest declaration (`@byok/cloud`'s `ports.ts`, design §6).
 *
 * Manifest and bytes are one transaction authority split across two systems
 * with no shared transaction, so the protocol is reserve/verify rather than
 * write/trust:
 *
 * 1. `createUpload` writes the `pending` manifest row FIRST, then signs a PUT.
 *    Row-before-bytes is what makes an abandoned upload a reclaimable
 *    tombstone instead of an object nobody has a record of.
 * 2. The device PUTs straight to the object store. `Content-Length` and
 *    `Content-Type` are in the signed headers, so a body of the wrong size or
 *    the wrong type is refused by the object store itself — before a byte is
 *    stored, and without this process being in the path.
 * 3. The explicit finalize route calls `observeUpload`, which performs an
 *    unconditional `HEAD`. Unconditional because §12.7.7 step 4 is about what
 *    the store OBSERVES versus what the client DECLARED, and signing the length
 *    proves what one client sent, not what is at the key now. The quota
 *    authority then commits manifest/reservation/usage in one Postgres
 *    statement; download never performs that transition.
 * 4. `committed` is terminal for writes. Step 1 is re-runnable while a row is
 *    `pending` — that is what makes a retried upload idempotent — and refused
 *    once it is `committed`, because §12.7.4 lets truth reference a committed
 *    manifest and the reference means nothing if the bytes can still be
 *    replaced by a same-shaped body under a freshly signed PUT.
 *
 * **No checksum header.** `x-amz-checksum-sha256` was probed rather than
 * assumed (design §3 marked it `[unverified]`): MinIO honors it in a presigned
 * PUT and rejects mismatched bytes with `XAmzContentChecksumMismatch`, but R2's
 * S3 compatibility table lists SHA-256 as `COMPOSITE` only — `FULL_OBJECT`, the
 * type a single-shot PutObject uses, is ❌, and R2's PutObject feature row names
 * no `x-amz-checksum-*` header at all. Signing one would mint URLs that work
 * against the test substrate and fail against production, which is worse than
 * not signing it. The `HEAD` above was never conditional on it.
 *
 * The `blobId` this store mints IS the content hash. That is what makes "no
 * naked object index" constructive rather than disciplinary: there is no
 * surrogate id to look up, every read is `(tenant, hash)` against the manifest
 * primary key, and the object key is derived — once, in {@link #objectUrl} —
 * from a `ContentHash` that core already validated. A non-hex id cannot reach
 * key construction because it cannot become a `ContentHash`.
 */
import {
  ByokCoreError,
  contentHash,
  isContentHash,
  tenantObjectKey,
  type Clock,
  type ContentHash,
  type ObjectStore,
  type StorageReservation,
  type TenantId,
} from '@byok/core';
import type { BlobObservation, CloudBlobStore } from '@byok/cloud';
import { AwsClient } from 'aws4fetch';

/** 15 minutes, matching the in-memory reference's `BLOB_URL_TTL_MS`. */
export const DEFAULT_PRESIGN_TTL_SECONDS = 15 * 60;

/** `X-Amz-Expires` floor. Below a second there is no grant, only a signature. */
export const MIN_PRESIGN_TTL_SECONDS = 1;

/** `X-Amz-Expires` ceiling: seven days, the longest lifetime R2 will honor. */
export const MAX_PRESIGN_TTL_SECONDS = 604_800;

/** Three total attempts: the first plus two retries. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Doubles per retry. Deterministic — no jitter, so a test can assert the sequence. */
export const DEFAULT_RETRY_DELAY_MS = 100;

/** The subset of `fetch` this store uses. The seam a fault injector replaces. */
export type ObjectStoreFetch = (request: Request) => Promise<Response>;

/**
 * Raised when the object store answered something this adapter cannot act on —
 * a 4xx that is not "absent", or a transient failure that outlived its retries.
 *
 * A local class rather than a core code: core's taxonomy describes the manifest
 * contract, and "R2 returned 503 three times" is an adapter fault, not a
 * statement about the object.
 */
export class ObjectStoreRequestError extends Error {
  public readonly status: number | undefined;
  public readonly attempts: number;

  constructor(message: string, attempts: number, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ObjectStoreRequestError';
    this.attempts = attempts;
    this.status = status;
  }
}

/**
 * What this adapter refuses on its own account, before anything is signed.
 *
 * A second local class rather than more core codes, for the same reason
 * {@link ObjectStoreRequestError} is one: core's taxonomy describes the
 * manifest contract, and "this deployment's tenant ids cannot be key segments"
 * or "this deployment configured a lifetime R2 will not honor" are facts about
 * an S3 adapter's configuration and inputs, not about an object. Core's code
 * union is closed and deliberately so; widening it from an adapter would put
 * an adapter's vocabulary on a wire contract every composition shares.
 *
 * Code-based branching, matching the idiom of every other error type here.
 */
export const R2_BLOB_ERROR_CODES = {
  /**
   * A tenant id that cannot be one safe path segment. Wire-relevant: it is the
   * only signal a control plane gets that the id it issued cannot address
   * object storage, and it is raised BEFORE any key is built.
   */
  storage_tenant_key_unsafe: 'storage_tenant_key_unsafe',
  /** A presign lifetime outside `[MIN_PRESIGN_TTL_SECONDS, MAX_PRESIGN_TTL_SECONDS]`. Construction-time only. */
  storage_presign_ttl_invalid: 'storage_presign_ttl_invalid',
} as const;

export type R2BlobErrorCode = (typeof R2_BLOB_ERROR_CODES)[keyof typeof R2_BLOB_ERROR_CODES];

export class R2BlobStoreError extends Error {
  public readonly code: R2BlobErrorCode;

  constructor(code: R2BlobErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'R2BlobStoreError';
    this.code = code;
  }
}

export interface R2BlobStoreOptions {
  /**
   * The manifest authority. Same `ObjectStore` the core composition supplies —
   * one row per (tenant, hash), and this store never opens a second one.
   */
  readonly objects: ObjectStore;
  /**
   * The clock SigV4's `X-Amz-Date` is read from — WALL time, and deliberately
   * NOT the composition's logical clock.
   *
   * Every other instant in this program comes from an injected clock so TTLs
   * are assertable without sleeping, and a store reaching for wall time is a
   * bug. A request signature is the exception, and not a soft one: its validity
   * window is adjudicated by the object store against the object store's own
   * clock. Signing with a logical instant produces a credential the remote side
   * rejects as skewed the moment the two disagree — a 403 at upload time, from
   * a decision made at composition time.
   *
   * Separate and required rather than defaulted, so the distinction is a choice
   * someone makes rather than one they inherit. A test that needs an EXPIRED
   * grant backdates this clock, which is also the only way to assert expiry
   * without sleeping through it.
   */
  readonly signingClock: Clock;
  /** Origin only, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * `auto` for R2. Required rather than defaulted: a signature scoped to the
   * wrong region fails as a 403 at upload time, which is a terrible place to
   * discover a config default nobody chose.
   */
  readonly region: string;
  readonly presignTtlSeconds?: number;
  /** Injected so a fault injector can sit in front of the real one. */
  readonly fetch?: ObjectStoreFetch;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

interface HeadResult {
  readonly present: boolean;
  readonly byteSize: bigint;
  readonly contentType: string;
}

export class R2CloudBlobStore implements CloudBlobStore {
  readonly #objects: ObjectStore;
  readonly #signingClock: Clock;
  readonly #client: AwsClient;
  readonly #origin: string;
  readonly #bucket: string;
  readonly #presignTtlSeconds: number;
  readonly #fetch: ObjectStoreFetch;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;

  constructor(options: R2BlobStoreOptions) {
    this.#objects = options.objects;
    this.#signingClock = options.signingClock;
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: 's3',
      region: options.region,
      // The client's own retry loop is bypassed: this store only ever calls
      // `sign`, and drives its own bounded, jitter-free retries below so the
      // transient-error dimension can assert an exact attempt sequence.
      retries: 0,
    });
    this.#origin = options.endpoint.replace(/\/+$/, '');
    this.#bucket = options.bucket;
    this.#presignTtlSeconds = assertPresignTtl(options.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS);
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /**
   * Reserve the manifest row, then hand back a PUT bound to this tenant, this
   * key, this length, this type, and this expiry.
   *
   * `putManifest` is idempotent per (tenant, hash), so a device that declares
   * the same content twice while it is still `pending` gets the same row and
   * the same key — an interrupted upload is retried, not duplicated. It is
   * idempotent per TENANT, which is the same reason the key embeds the tenant:
   * two tenants holding identical bytes hold two independent objects, and
   * neither can learn of the other's.
   *
   * Idempotence stops at `committed`, and that boundary is the point: a
   * committed object is what a truth record is allowed to reference, so it has
   * to be immutable, and re-issuing a write grant for one is the only way this
   * adapter could make it otherwise.
   */
  async createUpload(
    tenant: TenantId,
    reservation: StorageReservation,
  ): Promise<{ readonly blobId: string; readonly uploadUrl: string }> {
    this.#assertReservedObject(tenant, reservation);
    const hash = contentHash(reservation.contentHash);
    const byteSize = reservation.expectedBytes;
    // The same guard {@link #objectUrl} enforces, run before the manifest is
    // touched. Ordering only — the authority is still the one key-construction
    // point — but a tenant whose id can never address a key should not get to
    // reserve a row on the way to being refused.
    assertKeySegmentTenant(tenant);

    const entry = await this.#objects.putManifest(tenant, {
      hash,
      byteSize,
      contentType: reservation.contentType,
    });
    // `putManifest` returns an existing non-`deleted` row untouched, which is
    // what makes a retried upload idempotent. The flip side is that a SECOND
    // declaration of the same hash under a different size or type would
    // silently get a URL signed for the FIRST declaration's headers, so the
    // disagreement is refused here rather than discovered as a 403.
    if (entry.byteSize !== byteSize || entry.contentType !== reservation.contentType) {
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Object ${hash} is already declared as ${String(entry.byteSize)} bytes of ${entry.contentType}; this upload declares ${String(byteSize)} bytes of ${reservation.contentType}.`,
      );
    }
    // A committed object is immutable, so no write authorization exists to
    // hand out for one. §12.7.4 lets a truth record reference only a committed
    // manifest, and the attestation is worth exactly as much as the promise
    // that the bytes under `sha256/<hex>` do not change afterwards. A fresh PUT
    // grant would be that promise's only counterexample: the object store
    // accepts any body matching the signed length and type, and the digest is
    // never recomputed anywhere. `pending` stays grantable — a device retrying
    // an interrupted upload is the case idempotence is FOR, and there is
    // nothing yet for a replacement to invalidate.
    if (entry.state === 'committed') {
      throw new ByokCoreError(
        'object_state_invalid',
        `Object ${hash} is already committed; a committed object is immutable, so no upload grant is issued for it.`,
      );
    }

    const url = this.#objectUrl(tenant, hash);
    url.searchParams.set('X-Amz-Expires', String(this.#presignTtlSeconds));
    const signed = await this.#client.sign(
      new Request(url, {
        method: 'PUT',
        headers: {
          'content-length': String(byteSize),
          'content-type': reservation.contentType,
        },
      }),
      {
        // `allHeaders` is load-bearing: aws4fetch treats `content-length` and
        // `content-type` as unsignable by default (they are per-hop headers for
        // most services), and without this the grant would bind the key and the
        // expiry but not the SHAPE of what may be written to it.
        aws: { signQuery: true, allHeaders: true, datetime: this.#datetime() },
      },
    );

    return { blobId: hash, uploadUrl: signed.url };
  }

  async observeUpload(
    tenant: TenantId,
    blobId: string,
    reservation: StorageReservation,
  ): Promise<BlobObservation | undefined> {
    if (
      !isContentHash(blobId) ||
      reservation.tenantId !== tenant ||
      reservation.kind !== 'object' ||
      reservation.contentHash !== blobId
    ) {
      return undefined;
    }
    const entry = await this.#objects.get(tenant, reservation.contentHash);
    if (entry === undefined || (entry.state !== 'pending' && entry.state !== 'committed')) {
      return undefined;
    }
    const observed = await this.#head(tenant, reservation.contentHash);
    if (!observed.present) return undefined;
    return {
      observedByteSize: observed.byteSize,
      observedContentType: observed.contentType,
    };
  }

  /**
   * A GET for a committed object this tenant owns; `undefined` otherwise.
   *
   * Every miss answers identically — unknown hash, another tenant's object, a
   * malformed id, bytes that never landed, a tombstoned row. A caller cannot
   * tell them apart, which is what keeps `getDownloadUrl` from being an
   * existence oracle across tenants.
   *
   * This is a pure committed-manifest gate. Observation and commit belong to
   * the explicit finalize route; a download must never decide accounting.
   */
  async getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined> {
    // Not an error: a caller holding a junk id learns the same nothing a caller
    // holding another tenant's id learns. It is also the point past which a
    // non-hex value cannot travel — key construction is downstream of here.
    if (!isContentHash(blobId)) return undefined;
    const hash: ContentHash = blobId;

    const entry = await this.#objects.get(tenant, hash);
    if (entry === undefined) return undefined;

    if (entry.state !== 'committed') {
      // `delete_pending` and `deleted` are tombstones. Handing out a GET for
      // one would be a URL whose object the GC worker is entitled to remove.
      return undefined;
    }

    const url = this.#objectUrl(tenant, hash);
    url.searchParams.set('X-Amz-Expires', String(this.#presignTtlSeconds));
    const signed = await this.#client.sign(new Request(url, { method: 'GET' }), {
      aws: { signQuery: true, datetime: this.#datetime() },
    });
    return signed.url;
  }

  /**
   * The ONLY place an object key is built, and therefore the only place the
   * key's two segments have to be safe.
   *
   * The hash half is closed by construction: `tenantObjectKey` is core's and it
   * takes a `ContentHash` — a branded type with exactly one mint point that
   * rejects anything but 64 lowercase hex — so a traversal segment, an absolute
   * path, or an uppercase digest cannot be smuggled through a parameter that
   * will not accept them.
   *
   * The tenant half is NOT, and that asymmetry is why the guard below exists.
   * `tenantId()` fails closed on empty, padded, over-long, and `NUL`-bearing
   * values, and deliberately normalizes nothing else — normalizing would make
   * the SDK disagree with the control plane that issued the id about its
   * canonical form (`@byok/core`'s `tenant.ts`). So `a/../b` is a legitimate
   * tenant id, and the line below would otherwise hand it to `new URL()`, which
   * resolves the traversal and returns tenant `b`'s key. That is a cross-tenant
   * alias: `a/../b` could probe, overwrite, and read what `b` owns.
   *
   * Refused rather than encoded. Percent-encoding the segment would keep the
   * key distinct, and would also give every tenant id two spellings — the one
   * the control plane issued and the one at rest in the object store — which is
   * the second source of truth core refused to create in the first place.
   */
  #objectUrl(tenant: TenantId, hash: ContentHash): URL {
    assertKeySegmentTenant(tenant);
    return new URL(`${this.#origin}/${this.#bucket}/${tenantObjectKey(tenant, hash)}`);
  }

  /**
   * `HEAD` the key, with bounded retries for transient faults.
   *
   * `HEAD` is idempotent by construction, so a retry can never double an
   * effect — which is the whole reason the retry loop is allowed to exist here
   * and not around anything that writes.
   */
  async #head(tenant: TenantId, hash: ContentHash): Promise<HeadResult> {
    const url = this.#objectUrl(tenant, hash);
    const { response, attempts } = await this.#send(new Request(url, { method: 'HEAD' }));

    if (response.status === 404) {
      return { present: false, byteSize: 0n, contentType: '' };
    }
    if (!response.ok) {
      throw new ObjectStoreRequestError(
        `HEAD on the object store answered ${response.status}.`,
        attempts,
        response.status,
      );
    }

    const length = response.headers.get('content-length');
    const contentType = response.headers.get('content-type');
    if (length === null || contentType === null) {
      // Fail closed. A HEAD without the two fields the commit guard compares
      // cannot be turned into a commit decision, and guessing either one would
      // be inventing the observation the check exists to make.
      throw new ObjectStoreRequestError(
        `HEAD on the object store omitted content-length or content-type, so ${hash} cannot be verified.`,
        attempts,
        response.status,
      );
    }
    return { present: true, byteSize: BigInt(length), contentType };
  }

  /**
   * Signs, sends, and retries 5xx/429/network faults with a doubling delay.
   *
   * Returns the attempt count alongside the response because the caller is what
   * decides the answer was a failure. A 4xx costs however many attempts the
   * transient faults before it did, and `attempts` is the only field
   * {@link ObjectStoreRequestError} carries that an operator can use to tell a
   * flapping remote from a hard refusal — so it has to be counted here, where
   * the loop is, rather than assumed to be 1 at the throw site.
   */
  async #send(request: Request): Promise<{ readonly response: Response; readonly attempts: number }> {
    const failures: string[] = [];

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const signed = await this.#client.sign(request.clone(), {
        aws: { datetime: this.#datetime() },
      });

      const outcome = await this.#attempt(signed);
      if (outcome.response !== undefined) return { response: outcome.response, attempts: attempt };
      failures.push(outcome.failure);

      if (attempt < this.#maxAttempts) {
        await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new ObjectStoreRequestError(
      `The object store failed ${this.#maxAttempts} attempt(s): ${failures.join(', ')}.`,
      this.#maxAttempts,
    );
  }

  async #attempt(signed: Request): Promise<{ response?: Response; failure: string }> {
    try {
      const response = await this.#fetch(signed);
      // 429 and 5xx are the two the S3 contract calls retryable. Everything
      // else — including 403 and 404 — is an answer, not a fault.
      if (response.status !== 429 && response.status < 500) return { response, failure: '' };
      return { failure: `HTTP ${response.status}` };
    } catch (cause) {
      return { failure: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** SigV4's `YYYYMMDDTHHmmssZ`, off the signing clock — see its doc for why that is a separate one. */
  #datetime(): string {
    return this.#signingClock.now().toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
  }

  #assertReservedObject(tenant: TenantId, reservation: StorageReservation): void {
    if (
      reservation.tenantId === tenant &&
      reservation.kind === 'object' &&
      reservation.state === 'reserved' &&
      reservation.expectedBytes >= 0n
    ) {
      return;
    }
    throw new ByokCoreError(
      'storage_integrity_mismatch',
      'An upload grant requires a reserved object reservation owned by this tenant.',
    );
  }
}

/**
 * The character set a tenant id may use once it is a KEY SEGMENT.
 *
 * RFC 3986's unreserved set, and nothing else: those are exactly the characters
 * that survive `new URL()` unchanged. Anything outside it either changes the
 * path's STRUCTURE (`/`, `\`) or changes its SPELLING (percent-encoding), and
 * both are disqualifying for the same reason — an id with two forms is an id
 * with two owners.
 */
const SAFE_TENANT_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * A tenant id is usable here only if it is ONE safe path segment.
 *
 * Conservative on purpose: it rejects rather than repairs, and it rejects
 * everything it is not certain survives URL resolution unchanged — separators
 * in either direction, a leading `.` (which covers `.` and `..`), and every
 * character that would be percent-encoded. A permissive guard that "handles"
 * traversal by rewriting it would be a second normalization authority, and the
 * one thing worse than a tenant id the object store cannot address is a tenant
 * id the object store addresses under a name the control plane never issued.
 */
function assertKeySegmentTenant(tenant: TenantId): void {
  if (SAFE_TENANT_SEGMENT.test(tenant) && !tenant.startsWith('.')) return;
  throw new R2BlobStoreError(
    'storage_tenant_key_unsafe',
    `Tenant id ${JSON.stringify(tenant)} is not a single safe object-key segment, so no key can be built for it.`,
  );
}

function assertPresignTtl(seconds: number): number {
  if (
    Number.isInteger(seconds) &&
    seconds >= MIN_PRESIGN_TTL_SECONDS &&
    seconds <= MAX_PRESIGN_TTL_SECONDS
  ) {
    return seconds;
  }
  throw new R2BlobStoreError(
    'storage_presign_ttl_invalid',
    `A presign lifetime of ${String(seconds)} is not a whole number of seconds in [${String(MIN_PRESIGN_TTL_SECONDS)}, ${String(MAX_PRESIGN_TTL_SECONDS)}], which is the range R2 will honor.`,
  );
}
