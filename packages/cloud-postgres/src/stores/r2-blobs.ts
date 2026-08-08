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
 * 3. `pending → committed` is driven by an unconditional `HEAD` re-verification
 *    on first download. Unconditional because §12.7.7 step 4 is about what the
 *    store OBSERVES versus what the client DECLARED, and signing the length
 *    proves what one client sent, not what is at the key now. Observed size or
 *    type disagreeing is `storage_integrity_mismatch`, and the row stays
 *    `pending` so the S4B GC worker can reclaim it rather than a truth record
 *    pointing at bytes nobody vouched for.
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
  type TenantId,
} from '@byok/core';
import type { BlobDeclaration, CloudBlobStore } from '@byok/cloud';
import { AwsClient } from 'aws4fetch';

/** 15 minutes, matching the in-memory reference's `BLOB_URL_TTL_MS`. */
export const DEFAULT_PRESIGN_TTL_SECONDS = 15 * 60;

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

export interface R2BlobStoreOptions {
  /**
   * The manifest authority. Same `ObjectStore` the core composition supplies —
   * one row per (tenant, hash), and this store never opens a second one.
   */
  readonly objects: ObjectStore;
  readonly clock: Clock;
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
  readonly #clock: Clock;
  readonly #client: AwsClient;
  readonly #origin: string;
  readonly #bucket: string;
  readonly #presignTtlSeconds: number;
  readonly #fetch: ObjectStoreFetch;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;

  constructor(options: R2BlobStoreOptions) {
    this.#objects = options.objects;
    this.#clock = options.clock;
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
    this.#presignTtlSeconds = options.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /**
   * Reserve the manifest row, then hand back a PUT bound to this tenant, this
   * key, this length, this type, and this expiry.
   *
   * `putManifest` is idempotent per (tenant, hash), so a device that declares
   * the same content twice gets the same row and the same key — a duplicate
   * upload is a no-op, not a second object. It is idempotent per TENANT, which
   * is the same reason the key embeds the tenant: two tenants holding identical
   * bytes hold two independent objects, and neither can learn of the other's.
   */
  async createUpload(
    tenant: TenantId,
    input: BlobDeclaration,
  ): Promise<{ readonly blobId: string; readonly uploadUrl: string }> {
    // Mint first: this is the gate a non-canonical digest dies at, and it is
    // upstream of every path that could reach key construction.
    const hash = contentHash(input.contentHash);
    const byteSize = this.#declaredSize(hash, input.size);

    const entry = await this.#objects.putManifest(tenant, {
      hash,
      byteSize,
      contentType: input.contentType,
    });
    // `putManifest` returns an existing non-`deleted` row untouched, which is
    // what makes a retried upload idempotent. The flip side is that a SECOND
    // declaration of the same hash under a different size or type would
    // silently get a URL signed for the FIRST declaration's headers, so the
    // disagreement is refused here rather than discovered as a 403.
    if (entry.byteSize !== byteSize || entry.contentType !== input.contentType) {
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Object ${hash} is already declared as ${String(entry.byteSize)} bytes of ${entry.contentType}; this upload declares ${String(byteSize)} bytes of ${input.contentType}.`,
      );
    }

    const url = this.#objectUrl(tenant, hash);
    url.searchParams.set('X-Amz-Expires', String(this.#presignTtlSeconds));
    const signed = await this.#client.sign(
      new Request(url, {
        method: 'PUT',
        headers: {
          'content-length': String(byteSize),
          'content-type': input.contentType,
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

  /**
   * A GET for a committed object this tenant owns; `undefined` otherwise.
   *
   * Every miss answers identically — unknown hash, another tenant's object, a
   * malformed id, bytes that never landed, a tombstoned row. A caller cannot
   * tell them apart, which is what keeps `getDownloadUrl` from being an
   * existence oracle across tenants.
   *
   * The one thing it does besides read: a `pending` row whose bytes are
   * actually there is re-verified and committed here. First download is the
   * first moment anyone needs the object to be real, and §12.7.7 puts the
   * observed-versus-declared check exactly there.
   */
  async getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined> {
    // Not an error: a caller holding a junk id learns the same nothing a caller
    // holding another tenant's id learns. It is also the point past which a
    // non-hex value cannot travel — key construction is downstream of here.
    if (!isContentHash(blobId)) return undefined;
    const hash: ContentHash = blobId;

    const entry = await this.#objects.get(tenant, hash);
    if (entry === undefined) return undefined;

    if (entry.state === 'pending') {
      const observed = await this.#head(tenant, hash);
      if (!observed.present) return undefined;
      // Throws `storage_integrity_mismatch` when what is at the key disagrees
      // with what was declared, and leaves the row `pending`.
      await this.#objects.commit(tenant, {
        hash,
        observedByteSize: observed.byteSize,
        observedContentType: observed.contentType,
      });
    } else if (entry.state !== 'committed') {
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
   * The ONLY place an object key is built.
   *
   * `tenantObjectKey` is core's, and it takes a `ContentHash` — a branded type
   * with exactly one mint point that rejects anything but 64 lowercase hex.
   * A traversal segment, an absolute path, an uppercase digest, or another
   * tenant's prefix cannot be smuggled through a parameter that will not accept
   * them. Nothing else in this file concatenates a path.
   */
  #objectUrl(tenant: TenantId, hash: ContentHash): URL {
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
    const response = await this.#send(new Request(url, { method: 'HEAD' }));

    if (response.status === 404) {
      return { present: false, byteSize: 0n, contentType: '' };
    }
    if (!response.ok) {
      throw new ObjectStoreRequestError(
        `HEAD on the object store answered ${response.status}.`,
        1,
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
        1,
        response.status,
      );
    }
    return { present: true, byteSize: BigInt(length), contentType };
  }

  /** Signs, sends, and retries 5xx/429/network faults with a doubling delay. */
  async #send(request: Request): Promise<Response> {
    const failures: string[] = [];

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const signed = await this.#client.sign(request.clone(), {
        aws: { datetime: this.#datetime() },
      });

      const outcome = await this.#attempt(signed);
      if (outcome.response !== undefined) return outcome.response;
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

  /** SigV4's `YYYYMMDDTHHmmssZ`, read off the injected clock like every other instant here. */
  #datetime(): string {
    return this.#clock.now().toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
  }

  #declaredSize(hash: ContentHash, size: number): bigint {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Object ${hash} was declared with a size of ${String(size)}, which is not a byte count.`,
      );
    }
    return BigInt(size);
  }
}
