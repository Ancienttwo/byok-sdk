import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { exactProviderProfileBinding, SqliteProviderProfileStore, type ModelProviderProfile } from '@byok-sdk/keys';

/**
 * Pins a Pi catalog entry to one provider profile (R6): lane `byok-profile`
 * with the SDK's exact binding. `enabled` marks the keys default and is not a
 * gate here; any later edit of the profile changes its revision or hash, and
 * the launcher refuses the stale binding until the catalog is rebuilt. A
 * profile Pi cannot launch (no `pi_model`) yields no entry.
 */
export function catalogEntryFor(profile: ModelProviderProfile, base: ExecutionTemplate): ExecutionTemplate | undefined {
  if (base.payload.runtime !== 'pi') throw new Error(`A provider profile pins only Pi entries, not ${base.payload.runtime}`);
  if (profile.pi_model === undefined) return undefined;
  const binding = exactProviderProfileBinding(profile);
  const dispatchSelection = {
    lane: 'byok-profile' as const, runtimeId: 'pi' as const,
    providerProfile: { ...binding, requiredCapabilities: [...binding.requiredCapabilities] },
  };
  return { ...base, payload: { ...base.payload, dispatchSelection } };
}

/**
 * The Host's read-only view of the keys store. The catalog rebuilds on exactly
 * two triggers: `load()` at Host start and `changed()` after a custody receipt.
 */
export class ProviderProfiles {
  readonly #keysDb: string;
  readonly #listeners = new Set<(profiles: readonly ModelProviderProfile[]) => void>();

  constructor(keysDb: string) {
    this.#keysDb = keysDb;
  }

  async load(): Promise<readonly ModelProviderProfile[]> {
    const store = new SqliteProviderProfileStore({ path: this.#keysDb, readOnly: true });
    try {
      return await store.list();
    } finally {
      await store.close();
    }
  }

  subscribe(listener: (profiles: readonly ModelProviderProfile[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A custody receipt arrived: reread the store and hand every listener the new profiles. */
  async changed(): Promise<void> {
    const profiles = await this.load();
    for (const listener of this.#listeners) listener(profiles);
  }
}
