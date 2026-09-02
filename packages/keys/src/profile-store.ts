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
 */
export interface ProviderProfileStore {
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

  async close(): Promise<void> {
    this.#profiles.clear();
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
