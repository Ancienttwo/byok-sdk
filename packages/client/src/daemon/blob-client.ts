import { createHash, randomUUID } from 'node:crypto';
import { BYOK_BLOBS_PATH, byokBlobFinalizePath, byokBlobUrlPath } from '@byok-sdk/protocol';
import type { BlobRef } from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

export type BlobRequestAbortReason = 'deadline' | 'cancelled';

/** A blob request/body read did not complete before its deadline or its owner cancelled it. */
export class BlobRequestAbortedError extends Error {
  constructor(readonly reason: BlobRequestAbortReason) {
    super(reason === 'deadline' ? 'blob request deadline elapsed' : 'blob request cancelled');
    this.name = 'BlobRequestAbortedError';
  }
}

export interface BlobClientOptions {
  /** Bound for each individual HTTP request and response-body read. Default: 15 seconds. */
  requestDeadlineMs?: number;
  /** Daemon lifecycle authority; aborting it stops all in-flight blob I/O. */
  signal?: AbortSignal;
}

export interface BlobRequestOptions {
  /** Task lifecycle authority; aborting it stops this transfer before finalization. */
  signal?: AbortSignal;
}

/** Seam `TaskRunner` depends on, so tests can substitute a fake without spinning up real HTTP endpoints. */
export interface BlobResolver {
  resolveInstruction(blobRef: BlobRef, options?: BlobRequestOptions): Promise<string>;
  uploadArtifact(
    content: string | Uint8Array,
    contentType: string,
    options?: BlobRequestOptions & { readonly idempotencyKey?: string },
  ): Promise<BlobRef>;
}

/**
 * HTTP-side blob transfer (protocol §7): resolving an instruction `blobRef`
 * into its actual content, and uploading an artifact too large to inline.
 * Both require a valid bearer token, handled via `authedFetch`.
 */
export class BlobClient implements BlobResolver {
  private readonly requestDeadlineMs: number;

  constructor(
    private readonly serverUrl: string,
    private readonly auth: AuthManager,
    private readonly options: BlobClientOptions = {},
  ) {
    const requestDeadlineMs = options.requestDeadlineMs ?? 15_000;
    if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs <= 0) {
      throw new Error('BlobClient requestDeadlineMs must be a positive safe integer');
    }
    this.requestDeadlineMs = requestDeadlineMs;
  }

  /** `blobRef` -> `GET /byok/blobs/:id/url` -> fetch the presigned download URL -> text content. Always resolves fresh rather than trusting any inlined `BlobRef.url`, per docs/protocol.md §7. */
  async resolveInstruction(blobRef: BlobRef, options: BlobRequestOptions = {}): Promise<string> {
    const base = toHttpBase(this.serverUrl);
    const urlRes = await this.#request(
      (signal) => authedFetch(new URL(byokBlobUrlPath(blobRef.blobId), base), { method: 'GET', signal }, this.auth),
      options.signal,
    );
    if (!urlRes.ok) {
      throw new Error(`failed to resolve blob download url: HTTP ${urlRes.status} ${await this.#safeErrorText(urlRes, options.signal)}`.trimEnd());
    }
    const { downloadUrl } = await this.#readJson<{ downloadUrl?: unknown }>(urlRes, options.signal);
    if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) {
      throw new Error('failed to resolve blob download url: response omitted downloadUrl');
    }

    // LocalDiskBlobStore returns a same-origin relative URL while object stores
    // return an absolute presigned URL; URL resolution is structural for both.
    const contentRes = await this.#request((signal) => fetch(new URL(downloadUrl, base), { signal }), options.signal);
    if (!contentRes.ok) {
      throw new Error(`failed to download blob content: HTTP ${contentRes.status}`);
    }
    const bytes = await this.#readBody(contentRes, options.signal);
    const observedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (observedHash !== blobRef.contentHash || bytes.length !== blobRef.size) {
      throw new Error(
        `downloaded blob failed declared integrity: expected ${blobRef.contentHash}/${blobRef.size} bytes, observed ${observedHash}/${bytes.length} bytes`,
      );
    }
    return new TextDecoder().decode(bytes);
  }

  /** `POST /byok/blobs` -> PUT the bytes to the presigned URL -> finalize into a `BlobRef`. */
  async uploadArtifact(
    content: string | Uint8Array,
    contentType: string,
    options: BlobRequestOptions & { readonly idempotencyKey?: string } = {},
  ): Promise<BlobRef> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const base = toHttpBase(this.serverUrl);
    const reservationId = options.idempotencyKey ?? `blob_${randomUUID()}`;

    const createRes = await this.#request(
      (signal) => authedFetch(
        new URL(BYOK_BLOBS_PATH, base),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': reservationId },
          body: JSON.stringify({ size: bytes.length, contentType, contentHash }),
          signal,
        },
        this.auth,
      ),
      options.signal,
    );
    if (!createRes.ok) {
      throw new Error(`failed to create blob: HTTP ${createRes.status} ${await this.#safeErrorText(createRes, options.signal)}`.trimEnd());
    }
    const { blobId, uploadUrl } = await this.#readJson<{ blobId?: unknown; uploadUrl?: unknown }>(createRes, options.signal);
    if (typeof blobId !== 'string' || blobId.length === 0 || typeof uploadUrl !== 'string' || uploadUrl.length === 0) {
      throw new Error('failed to create blob: response omitted blobId or uploadUrl');
    }
    const blobRef: BlobRef = { blobId, contentHash, size: bytes.length, contentType };

    if (options.idempotencyKey !== undefined && await this.#hasExactCommittedBlob(base, blobRef, options.signal)) {
      return blobRef;
    }

    const putRes = await this.#request(
      (signal) => fetch(new URL(uploadUrl, base), {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: bytes,
        signal,
      }),
      options.signal,
    );
    if (!putRes.ok) {
      throw new Error(`failed to upload blob content: HTTP ${putRes.status}`);
    }

    this.#throwIfAborted(options.signal);
    await this.#finalize(base, blobId, reservationId, options.signal);
    return blobRef;
  }

  async #hasExactCommittedBlob(base: string, blobRef: BlobRef, signal: AbortSignal | undefined): Promise<boolean> {
    const urlRes = await this.#request(
      (requestSignal) => authedFetch(new URL(byokBlobUrlPath(blobRef.blobId), base), { method: 'GET', signal: requestSignal }, this.auth),
      signal,
    );
    if (urlRes.status === 404) return false;
    if (!urlRes.ok) {
      throw new Error(`failed to read back idempotent blob: HTTP ${urlRes.status} ${await this.#safeErrorText(urlRes, signal)}`.trimEnd());
    }
    const { downloadUrl } = await this.#readJson<{ downloadUrl?: unknown }>(urlRes, signal);
    if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) {
      throw new Error('failed to read back idempotent blob: response omitted downloadUrl');
    }
    const contentRes = await this.#request((requestSignal) => fetch(new URL(downloadUrl, base), { signal: requestSignal }), signal);
    if (contentRes.status === 404) return false;
    if (!contentRes.ok) {
      throw new Error(`failed to read back idempotent blob content: HTTP ${contentRes.status}`);
    }
    const bytes = await this.#readBody(contentRes, signal);
    const observedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (observedHash !== blobRef.contentHash || bytes.length !== blobRef.size) {
      throw new Error(
        `idempotent blob readback failed declared integrity: expected ${blobRef.contentHash}/${blobRef.size} bytes, observed ${observedHash}/${bytes.length} bytes`,
      );
    }
    return true;
  }

  async #finalize(base: string, blobId: string, reservationId: string, signal: AbortSignal | undefined): Promise<void> {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.#throwIfAborted(signal);
      let response: Response;
      try {
        response = await this.#request(
          (requestSignal) => authedFetch(
            new URL(byokBlobFinalizePath(blobId), base),
            { method: 'POST', headers: { 'idempotency-key': reservationId }, signal: requestSignal },
            this.auth,
          ),
          signal,
        );
      } catch (error) {
        lastFailure = error;
        if (attempt === 2) throw error;
        continue;
      }
      if (response.ok) return;
      if (response.status < 500 || attempt === 2) {
        throw new Error(
          `failed to finalize blob: HTTP ${response.status} ${await this.#safeErrorText(response, signal)}`.trimEnd(),
        );
      }
      lastFailure = new Error(`failed to finalize blob: HTTP ${response.status}`);
    }
    throw lastFailure;
  }

  async #readJson<T>(res: Response, signal: AbortSignal | undefined): Promise<T> {
    return JSON.parse(await this.#readText(res, signal)) as T;
  }

  async #safeErrorText(res: Response, signal: AbortSignal | undefined): Promise<string> {
    try {
      return await this.#readText(res, signal);
    } catch (error) {
      if (error instanceof BlobRequestAbortedError) throw error;
      return '';
    }
  }

  async #readText(res: Response, signal: AbortSignal | undefined): Promise<string> {
    return new TextDecoder().decode(await this.#readBody(res, signal));
  }

  /**
   * `Response.arrayBuffer()` only leaves cancellation observable through the
   * Fetch implementation. Read the body directly so our lifecycle/deadline
   * authority cancels the actual stream even when a fetch implementation has
   * already resolved at headers.
   */
  async #readBody(res: Response, signal: AbortSignal | undefined): Promise<Uint8Array> {
    return this.#request(async (requestSignal) => {
      if (res.body === null) return new Uint8Array();
      const reader = res.body.getReader();
      const cancelBody = (): void => {
        void reader.cancel().catch(() => undefined);
      };
      requestSignal.addEventListener('abort', cancelBody, { once: true });
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          length += value.byteLength;
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      } finally {
        requestSignal.removeEventListener('abort', cancelBody);
        reader.releaseLock();
      }
    }, signal);
  }

  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (this.options.signal?.aborted || signal?.aborted) {
      throw new BlobRequestAbortedError('cancelled');
    }
  }

  async #request<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    this.#throwIfAborted(signal);
    const controller = new AbortController();
    let abortReason: BlobRequestAbortReason = 'cancelled';
    const abort = (reason: BlobRequestAbortReason): void => {
      if (controller.signal.aborted) return;
      abortReason = reason;
      controller.abort();
    };
    const inheritedSignals = [this.options.signal, signal].filter((value): value is AbortSignal => value !== undefined);
    const abortForCancellation = (): void => abort('cancelled');
    for (const inheritedSignal of inheritedSignals) {
      inheritedSignal.addEventListener('abort', abortForCancellation, { once: true });
    }
    const deadline = setTimeout(() => abort('deadline'), this.requestDeadlineMs);
    deadline.unref?.();
    let rejectAbort: (error: BlobRequestAbortedError) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const rejectOnAbort = (): void => rejectAbort(new BlobRequestAbortedError(abortReason));
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    try {
      return await Promise.race([request(controller.signal), aborted]);
    } catch (error) {
      if (error instanceof BlobRequestAbortedError) throw error;
      if (controller.signal.aborted) throw new BlobRequestAbortedError(abortReason);
      throw error;
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', rejectOnAbort);
      for (const inheritedSignal of inheritedSignals) {
        inheritedSignal.removeEventListener('abort', abortForCancellation);
      }
    }
  }
}
