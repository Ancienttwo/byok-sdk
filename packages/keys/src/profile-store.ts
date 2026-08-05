import { ByokKeysError } from './errors';
import {
  type ModelProviderId,
  type ModelProviderProfile,
  parseModelProviderProfile,
} from './provider-profile';

/**
 * Storage contract for provider profiles — everything needed to address a
 * provider except the API key, which lives in a {@link SecretStore}.
 *
 * Shaped after `@byok/server`'s `TaskStore` (`packages/server/src/task-store.ts`)
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
  close(): void;
  /** Remove `providerId`; `false` when it was not configured. */
  delete(providerId: ModelProviderId): boolean;
  /** Read one provider's profile, configured or not enabled alike. */
  get(providerId: ModelProviderId): ModelProviderProfile | undefined;
  /** The single enabled profile, or `undefined` when none is enabled. */
  getEnabled(): ModelProviderProfile | undefined;
  /** Every configured profile, ordered by provider id. */
  list(): ModelProviderProfile[];
  /** Insert or update `profile`, enforcing both invariants above. */
  save(profile: ModelProviderProfile): ModelProviderProfile;
  /**
   * Make `providerId` the enabled profile. Throws `PROVIDER_NOT_CONFIGURED`
   * when it has no profile — a fail-closed port of `providers.ts:1243-1250`.
   */
  setEnabled(providerId: ModelProviderId): ModelProviderProfile;
}

/** Shared by both implementations so their error text cannot drift apart. */
export function providerNotConfigured(
  providerId: ModelProviderId,
): ByokKeysError {
  return new ByokKeysError(
    'PROVIDER_NOT_CONFIGURED',
    `${providerId} model provider is not configured`,
  );
}

/**
 * Profile store held in process memory: the default, and the one every test
 * that does not specifically exercise SQLite should use.
 *
 * Mirrors `InMemoryTaskStore`'s role in `@byok/server` — a real implementation
 * of the contract, not a stub, so behaviour proven here is the behaviour the
 * SQLite store must match (`profile-store.test.ts` runs one suite against both).
 */
export class InMemoryProviderProfileStore implements ProviderProfileStore {
  readonly #profiles = new Map<ModelProviderId, ModelProviderProfile>();

  close(): void {
    this.#profiles.clear();
  }

  delete(providerId: ModelProviderId): boolean {
    return this.#profiles.delete(providerId);
  }

  get(providerId: ModelProviderId): ModelProviderProfile | undefined {
    return this.#profiles.get(providerId);
  }

  getEnabled(): ModelProviderProfile | undefined {
    return this.list().find((profile) => profile.enabled);
  }

  list(): ModelProviderProfile[] {
    return [...this.#profiles.values()].sort((left, right) =>
      left.provider_id.localeCompare(right.provider_id),
    );
  }

  save(profile: ModelProviderProfile): ModelProviderProfile {
    const validated = parseModelProviderProfile({
      ...profile,
      created_at:
        this.#profiles.get(profile.provider_id)?.created_at ??
        profile.created_at,
    });
    if (validated.enabled) {
      for (const [providerId, existing] of this.#profiles) {
        if (providerId !== validated.provider_id && existing.enabled) {
          this.#profiles.set(providerId, { ...existing, enabled: false });
        }
      }
    }
    this.#profiles.set(validated.provider_id, validated);
    return validated;
  }

  setEnabled(providerId: ModelProviderId): ModelProviderProfile {
    const existing = this.#profiles.get(providerId);
    if (existing === undefined) throw providerNotConfigured(providerId);
    return this.save({ ...existing, enabled: true });
  }
}
