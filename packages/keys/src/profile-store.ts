import {
  type ProviderConfigurationLock,
  type ProviderCustodyCommit,
  type ProviderCustodyPending,
  type ProviderCustodyReceipt,
  type ProviderKeyCheckOutcome,
  PROVIDER_CUSTODY_RECEIPT_LIMIT,
  ProcessLocalMutex,
} from './custody';
import { ByokKeysError } from './errors';
import {
  type ModelProviderProfile,
  type ProviderProfileRef,
  parseModelProviderProfile,
} from './provider-profile';

/**
 * Storage contract for provider profiles — everything needed to address a
 * provider except the API key, which lives in a {@link SecretStore}.
 *
 * Shaped after `@byok-sdk/server`'s `TaskStore` (`packages/server/src/task-store.ts`)
 * as a *pattern*, not a dependency: `keys` must not import `server`, and
 * `server` must not import `keys` (the plan's Security Boundary keeps the
 * agent-dispatch packages free of any credential-adjacent code).
 *
 * Two invariants every implementation MUST enforce, not just
 * {@link InMemoryProviderProfileStore}:
 *
 * 1. **At most one enabled profile.** The source expressed this as a partial
 *    unique index (`providers.ts:140-144`); saving an enabled profile disables
 *    every other one. {@link resolveDefaultModelProvider} relies on it to
 *    answer "which provider is the default" with a single row.
 * 2. **Validate on write.** `save` runs {@link parseModelProviderProfile}, so an
 *    invalid profile is refused at the boundary rather than discovered later by
 *    a reader.
 *
 * Every store also owns the credential-custody state described in
 * `custody.ts`: the configuration lock, pending markers, operation
 * watermarks, and receipts. The custody methods other than
 * `acquireConfigurationLock` must be called while holding that lock; the
 * registry, the provisioning applier, and the launcher are the only callers.
 */
export interface ProviderProfileStore {
  /**
   * Take the exclusive configuration lock. Cross-process for a file-backed
   * SQLite store; process-local otherwise. Fails closed with
   * `PROVIDER_CONFIGURATION_BUSY` when it cannot be acquired in time.
   */
  acquireConfigurationLock(): Promise<ProviderConfigurationLock>;
  /** The pending marker for `profileRef`, if a credential change is unfinished. */
  getPending(profileRef: ProviderProfileRef): Promise<ProviderCustodyPending | undefined>;
  /** Durably record a pending marker (replacing any existing one for the same ref). */
  markPending(pending: ProviderCustodyPending): Promise<void>;
  /** Highest operation generation `profileRef` has consumed; survives delete. */
  getOperationWatermark(profileRef: ProviderProfileRef): Promise<number | undefined>;
  /** Stored receipt for a provisioning request id, if still retained. */
  getReceipt(requestId: string): Promise<ProviderCustodyReceipt | undefined>;
  /** Apply a custody commit atomically (see {@link ProviderCustodyCommit}). */
  commitCustody(commit: ProviderCustodyCommit): Promise<void>;
  /**
   * Record a key-check outcome on a receipt, only if that receipt's
   * generation is still the profile's watermark. Returns whether it was
   * recorded; a stale check never overwrites newer state.
   */
  recordKeyCheck(requestId: string, operationGeneration: number, keyCheck: ProviderKeyCheckOutcome): Promise<boolean>;
  /** Release the underlying resource. Safe to call more than once. */
  close(): Promise<void>;
  /** Remove `profileRef`; `false` when it was not configured. */
  delete(profileRef: ProviderProfileRef): Promise<boolean>;
  /** Read one profile, configured or not enabled alike. */
  get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined>;
  /** The single enabled profile, or `undefined` when none is enabled. */
  getEnabled(): Promise<ModelProviderProfile | undefined>;
  /** Every configured profile, ordered by profile ref. */
  list(): Promise<ModelProviderProfile[]>;
  /** Insert or update `profile`, enforcing both invariants above. */
  save(profile: ModelProviderProfile): Promise<ModelProviderProfile>;
  /**
   * Make `profileRef` the enabled profile. Throws `PROVIDER_NOT_CONFIGURED`
   * when it has no profile — a fail-closed port of `providers.ts:1243-1250`.
   */
  setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile>;
}

/** Shared by both implementations so their error text cannot drift apart. */
export function providerNotConfigured(
  profileRef: ProviderProfileRef,
): ByokKeysError {
  return new ByokKeysError(
    'PROVIDER_NOT_CONFIGURED',
    `${profileRef} model provider is not configured`,
  );
}

/**
 * Profile store held in process memory: the default, and the one every test
 * that does not specifically exercise SQLite should use.
 *
 * Mirrors `InMemoryTaskStore`'s role in `@byok-sdk/server` — a real implementation
 * of the contract, not a stub, so behaviour proven here is the behaviour the
 * SQLite store must match (`profile-store.test.ts` runs one suite against both).
 */
export class InMemoryProviderProfileStore implements ProviderProfileStore {
  readonly #profiles = new Map<ProviderProfileRef, ModelProviderProfile>();
  readonly #mutex = new ProcessLocalMutex();
  readonly #pending = new Map<ProviderProfileRef, ProviderCustodyPending>();
  readonly #watermarks = new Map<ProviderProfileRef, number>();
  readonly #receipts = new Map<string, ProviderCustodyReceipt>();

  async close(): Promise<void> {
    this.#profiles.clear();
  }

  acquireConfigurationLock(): Promise<ProviderConfigurationLock> {
    return this.#mutex.acquire();
  }

  async getPending(profileRef: ProviderProfileRef): Promise<ProviderCustodyPending | undefined> {
    return this.#pending.get(profileRef);
  }

  async markPending(pending: ProviderCustodyPending): Promise<void> {
    this.#pending.set(pending.profileRef, { ...pending });
  }

  async getOperationWatermark(profileRef: ProviderProfileRef): Promise<number | undefined> {
    return this.#watermarks.get(profileRef);
  }

  async getReceipt(requestId: string): Promise<ProviderCustodyReceipt | undefined> {
    return this.#receipts.get(requestId);
  }

  async commitCustody(commit: ProviderCustodyCommit): Promise<void> {
    if (commit.mutation.kind === 'save') await this.save(commit.mutation.profile);
    if (commit.mutation.kind === 'delete') this.#profiles.delete(commit.profileRef);
    if (commit.receipt !== undefined) applyReceipt(this.#receipts, this.#watermarks, commit.receipt);
    if (commit.clearPending) this.#pending.delete(commit.profileRef);
  }

  async recordKeyCheck(requestId: string, operationGeneration: number, keyCheck: ProviderKeyCheckOutcome): Promise<boolean> {
    return recordReceiptKeyCheck(this.#receipts, this.#watermarks, requestId, operationGeneration, keyCheck);
  }

  async delete(profileRef: ProviderProfileRef): Promise<boolean> {
    return this.#profiles.delete(profileRef);
  }

  async get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined> {
    return this.#profiles.get(profileRef);
  }

  async getEnabled(): Promise<ModelProviderProfile | undefined> {
    return [...this.#profiles.values()].find((profile) => profile.enabled);
  }

  async list(): Promise<ModelProviderProfile[]> {
    return [...this.#profiles.values()].sort((left, right) =>
      left.profile_ref.localeCompare(right.profile_ref),
    );
  }

  async save(profile: ModelProviderProfile): Promise<ModelProviderProfile> {
    const validated = parseModelProviderProfile({
      ...profile,
      created_at:
        this.#profiles.get(profile.profile_ref)?.created_at ??
        profile.created_at,
    });
    if (validated.enabled) {
      for (const [profileRef, existing] of this.#profiles) {
        if (profileRef !== validated.profile_ref && existing.enabled) {
          this.#profiles.set(profileRef, { ...existing, enabled: false });
        }
      }
    }
    this.#profiles.set(validated.profile_ref, validated);
    return validated;
  }

  async setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile> {
    const existing = this.#profiles.get(profileRef);
    if (existing === undefined) throw providerNotConfigured(profileRef);
    return this.save({ ...existing, enabled: true });
  }
}

/**
 * Shared by the process-local stores: insert a receipt, advance the ref's
 * watermark (never backwards), and evict receipts beyond the retention limit
 * in insertion order. Replay protection is the watermark's, so eviction never
 * revives a request.
 */
export function applyReceipt(
  receipts: Map<string, ProviderCustodyReceipt>,
  watermarks: Map<ProviderProfileRef, number>,
  receipt: ProviderCustodyReceipt,
): void {
  receipts.set(receipt.requestId, receipt);
  const current = watermarks.get(receipt.profileRef);
  if (current === undefined || receipt.operationGeneration > current) {
    watermarks.set(receipt.profileRef, receipt.operationGeneration);
  }
  while (receipts.size > PROVIDER_CUSTODY_RECEIPT_LIMIT) {
    const oldest = receipts.keys().next().value as string;
    receipts.delete(oldest);
  }
}

export function recordReceiptKeyCheck(
  receipts: Map<string, ProviderCustodyReceipt>,
  watermarks: Map<ProviderProfileRef, number>,
  requestId: string,
  operationGeneration: number,
  keyCheck: ProviderKeyCheckOutcome,
): boolean {
  const receipt = receipts.get(requestId);
  if (receipt === undefined || receipt.operationGeneration !== operationGeneration) return false;
  if (watermarks.get(receipt.profileRef) !== operationGeneration) return false;
  receipts.set(requestId, { ...receipt, result: { ...receipt.result, keyCheck } });
  return true;
}
