import { z } from 'zod';

import { PROVIDER_PROVISIONING_OPERATIONS, type ProviderProvisioningOperation } from '@byok-sdk/core';

import { ByokKeysError } from './errors';
import type { ModelProviderProfile, ProviderProfileRef } from './provider-profile';

/**
 * Credential custody coordination (plan web-sealed-provisioning D5, A3, A4, A8, A9).
 *
 * The provider key lives in the OS credential store and the profile lives in
 * the profile database; there is no transaction spanning both. Custody makes
 * the pair crash-safe and race-free with three pieces of state and one lock,
 * all owned by the profile store:
 *
 * 1. **Configuration lock** — exclusive and, for a file-backed SQLite store,
 *    cross-process. Every credential writer holds it across "mark pending →
 *    OS write → commit", and every credential reader holds it across
 *    "re-read + exact-validate profile → pending check → key read". A reader
 *    can therefore never pair a profile with a key from a different
 *    configuration.
 * 2. **Pending marker** — durable and secret-free, written before the OS
 *    write and cleared only by the final profile transaction. While it exists
 *    no reader may read the key. A marker left behind by a crash is never
 *    resolved by guessing: only a new operation that supplies a key (or a
 *    delete) replaces it.
 * 3. **Operation watermark** — the highest `operationGeneration` a profile
 *    ref has consumed. A generation is consumed the moment its pending marker
 *    is written (same transaction), not only when it commits, so an older
 *    request can never overtake a newer one that started and was interrupted.
 *    It survives `delete` (a tombstone), so a replay of any older request stays
 *    rejected however many operations happened since and whatever the clock
 *    says.
 * 4. **Receipts** — the credential-free result of recent provisioning
 *    requests, keyed by request id and bounded by count. They let a request
 *    whose ACK was lost read back the same stored result; replay protection
 *    does not depend on them (that is the watermark's job), so evicting an old
 *    receipt never revives an old request.
 */

export const PROVIDER_CUSTODY_OPERATIONS = PROVIDER_PROVISIONING_OPERATIONS;
export type ProviderCustodyOperation = ProviderProvisioningOperation;

/** Receipts kept per profile database; older ones are evicted by insertion order. */
export const PROVIDER_CUSTODY_RECEIPT_LIMIT = 256;

/** How long a caller waits for the configuration lock before failing closed. */
export const PROVIDER_CONFIGURATION_LOCK_WAIT_MS = 10_000;

/** A secret-free marker that an OS credential write may be in flight or was interrupted. */
export interface ProviderCustodyPending {
  readonly profileRef: ProviderProfileRef;
  readonly operation: ProviderCustodyOperation;
  /** The provisioning request that set it; `null` for a direct registry write. */
  readonly requestId: string | null;
  readonly operationGeneration: number | null;
  readonly since: string;
}

/**
 * Closed set of device-side provisioning rejections. Never carries detail
 * beyond the code. Every code is the exact `@byok-sdk/protocol` rejection
 * string, so the Host maps 1:1; keys cannot import protocol, so
 * `scripts/api-surface/check-provisioning-code-alignment.test.mjs` proves the
 * two closed sets stay identical.
 */
export const PROVIDER_PROVISIONING_REJECTIONS = [
  'request_invalid',
  'enrollment_mismatch',
  'sealing_key_rotated',
  'agent_not_placed',
  'config_digest_mismatch',
  'seal_open_failed',
  'request_conflict',
  'operation_generation_stale',
  'request_window_invalid',
  'request_not_yet_valid',
  'request_expired',
  'provider_kind_unsupported',
  'pi_model_invalid',
  'capabilities_invalid',
  'profile_changed',
  'profile_not_found',
  'credential_scope_mismatch',
  'local_commit_interrupted',
  'secret_invalid',
  'secret_store_unavailable',
] as const;
export type ProviderProvisioningRejection = (typeof PROVIDER_PROVISIONING_REJECTIONS)[number];

/**
 * Closed set of key-check outcomes (D13, A10), using the protocol key-check
 * strings 1:1 (proven by the same alignment check). `credential_rejected`
 * means only an explicit credential rejection (HTTP 401); a check is a hint
 * and never a readiness decision.
 */
export const PROVIDER_KEY_CHECK_OUTCOMES = [
  'not_run',
  'ok',
  'credential_rejected',
  'rate_limited',
  'quota_or_billing',
  'model_not_permitted',
  'unreachable',
  'timeout',
  'provider_error',
] as const;
export type ProviderKeyCheckOutcome = (typeof PROVIDER_KEY_CHECK_OUTCOMES)[number];

/** Credential-free exact binding the Host records for a bot after an applied operation. */
export interface ProviderProvisioningBinding {
  readonly profileRef: ProviderProfileRef;
  readonly profileRevision: string;
  readonly profileHash: string;
  readonly modelId: string;
}

/**
 * The device's credential-free provisioning result. It is what a receipt
 * stores and what the Host receives; it never carries a secret, an endpoint
 * credential, or an OS error detail.
 */
export interface ProviderProvisioningResult {
  readonly requestId: string | null;
  /**
   * `providerProvisioningRequestDigest` of the immutable request (the value a
   * Host stores at submission and reports as the completion's operation
   * digest); `null` only when the request could not be parsed.
   */
  readonly requestDigest: string | null;
  readonly operation: ProviderCustodyOperation | null;
  readonly operationGeneration: number | null;
  readonly outcome: 'applied' | 'rejected';
  readonly code: ProviderProvisioningRejection | null;
  readonly profileRef: ProviderProfileRef | null;
  /** Exact binding after the operation; `null` after delete or on rejection. */
  readonly binding: ProviderProvisioningBinding | null;
  /** Whether the credential store holds this profile's key after the operation. */
  readonly secretConfigured: boolean | null;
  readonly keyCheck: ProviderKeyCheckOutcome;
}

const BindingSchema = z.strictObject({
  profileRef: z.string().min(1).max(64),
  profileRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u),
  profileHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  modelId: z.string().min(1).max(160),
});

export const ProviderProvisioningResultSchema = z.strictObject({
  requestId: z.string().min(1).max(200).nullable(),
  requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable(),
  operation: z.enum(PROVIDER_CUSTODY_OPERATIONS).nullable(),
  operationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  outcome: z.enum(['applied', 'rejected']),
  code: z.enum(PROVIDER_PROVISIONING_REJECTIONS).nullable(),
  profileRef: z.string().min(1).max(64).nullable(),
  binding: BindingSchema.nullable(),
  secretConfigured: z.boolean().nullable(),
  keyCheck: z.enum(PROVIDER_KEY_CHECK_OUTCOMES),
});

/** Parse a persisted result fail-closed. */
export function parseProviderProvisioningResult(value: unknown): ProviderProvisioningResult {
  const parsed = ProviderProvisioningResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ByokKeysError('PROVIDER_CUSTODY_STATE_INVALID', 'Stored provider provisioning result is invalid');
  }
  return parsed.data as ProviderProvisioningResult;
}

/** A durable completion record for one provisioning request. */
export interface ProviderCustodyReceipt {
  readonly requestId: string;
  readonly profileRef: ProviderProfileRef;
  readonly operationGeneration: number;
  readonly requestDigest: string;
  readonly result: ProviderProvisioningResult;
}

/**
 * The single final write of a custody operation. A store applies all of it
 * atomically: the profile mutation, the receipt (which also advances the
 * profile ref's watermark to the receipt's generation), and — only when
 * `clearPending` — removal of the pending marker.
 */
export interface ProviderCustodyCommit {
  readonly profileRef: ProviderProfileRef;
  readonly mutation:
    | { readonly kind: 'save'; readonly profile: ModelProviderProfile }
    | { readonly kind: 'delete' }
    | { readonly kind: 'none' };
  readonly receipt?: ProviderCustodyReceipt;
  readonly clearPending: boolean;
}

/** A held configuration lock. `release` is idempotent. */
export interface ProviderConfigurationLock {
  release(): Promise<void>;
}

/**
 * FIFO async mutex for exclusion inside one process. File-backed SQLite
 * stores put their cross-process lock behind it; in-memory and TruthStore
 * stores use it alone, because their custody state is process-local.
 */
export class ProcessLocalMutex {
  #tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<ProviderConfigurationLock> {
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        releaseNext();
      },
    };
  }
}

/** Run `body` while holding `store`'s configuration lock. */
export async function withConfigurationLock<T>(
  store: { acquireConfigurationLock(): Promise<ProviderConfigurationLock> },
  body: () => Promise<T>,
): Promise<T> {
  const lock = await store.acquireConfigurationLock();
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

export function configurationPendingError(): ByokKeysError {
  return new ByokKeysError(
    'PROVIDER_CONFIGURATION_PENDING',
    'Provider configuration has an unfinished credential change; re-submit the provider key before using this profile',
  );
}
