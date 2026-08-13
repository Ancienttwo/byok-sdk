/**
 * A deterministic fault injector for the object-store `fetch` seam.
 *
 * This is NOT a shadow S3, and the distinction is the whole reason it is only
 * fifty lines. MinIO is the S3 implementation under test: it verifies
 * signatures, enforces expiry, and stores bytes, and every protocol-level
 * assertion goes through it. What MinIO cannot be made to do on cue is fail —
 * a 503 on the first two attempts and a 200 on the third, in that order, every
 * run. Retry and backoff semantics are the one thing that needs scripting, so
 * this wraps the real fetch and replaces individual attempts with faults
 * (design §3).
 *
 * An injector that answered requests itself would be a fake S3, and every
 * assertion made through it would be a statement about the fake.
 */
import type { ObjectStoreFetch } from '../../stores/r2-blobs';

/**
 * What one attempt does.
 *
 * - `'pass'` — the real object store answers.
 * - a number — that HTTP status, with no body.
 * - `'timeout'` — `fetch` rejects, the way a socket failure surfaces.
 */
export type FaultStep = 'pass' | 'timeout' | number;

export interface RecordedAttempt {
  readonly method: string;
  readonly url: string;
  readonly outcome: FaultStep;
}

export interface FaultInjector {
  /** Hand this to `R2BlobStoreOptions.fetch`. */
  readonly fetch: ObjectStoreFetch;
  /** Every attempt, in order, including the ones that reached the real store. */
  readonly attempts: readonly RecordedAttempt[];
}

/**
 * Wraps `real` with a script consumed one attempt at a time.
 *
 * Attempts past the end of the script reach the real store. That is not a
 * fallback: the script describes the FAULTS, and the point of a bounded retry
 * test is that the call eventually succeeds against the thing that was there
 * all along.
 */
export function injectFaults(
  script: readonly FaultStep[],
  real: ObjectStoreFetch = (request) => globalThis.fetch(request),
): FaultInjector {
  const attempts: RecordedAttempt[] = [];

  return {
    attempts,
    async fetch(request) {
      const step = script[attempts.length] ?? 'pass';
      attempts.push({ method: request.method, url: request.url, outcome: step });

      if (step === 'pass') return real(request);
      if (step === 'timeout') throw new TypeError('fetch failed');
      return new Response(null, { status: step });
    },
  };
}

/** A pass-through that records what the adapter actually asked the object store to do. */
export function recordCalls(real: ObjectStoreFetch = (request) => globalThis.fetch(request)): FaultInjector {
  return injectFaults([], real);
}
