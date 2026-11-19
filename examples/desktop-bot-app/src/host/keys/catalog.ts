import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { exactProviderProfileBinding, inspectProviderProfileStore, SqliteProviderProfileStore, type ModelProviderProfile } from '@byok-sdk/keys';

/**
 * Pins a Pi catalog entry to one provider profile (R6): lane `byok-profile`
 * with the SDK's exact binding. `enabled` marks the keys default and is not a
 * gate here; any later edit of the profile changes its revision or hash, and
 * the launcher refuses the stale binding until the catalog is rebuilt. A
 * profile Pi cannot launch (no `pi_model`) yields no entry.
 */
export function catalogEntryFor(profile: ModelProviderProfile, base: ExecutionTemplate): ExecutionTemplate | undefined {
  const { target } = base.payload;
  if (target.lane !== 'harness' || target.harnessId !== 'pi') throw new Error('A provider profile pins only Pi entries');
  if (profile.pi_model === undefined) return undefined;
  const binding = exactProviderProfileBinding(profile);
  return { ...base, payload: { ...base.payload, target: {
    lane: 'harness', harnessId: 'pi', selection: {
      mode: 'byok-profile',
      providerProfile: { ...binding, requiredCapabilities: [...binding.requiredCapabilities] },
    },
  } } };
}

/**
 * The Host's read-only view of the keys store. The catalog builds from `load()`
 * at Host start and rebuilds through `changed()` after custody receipts and lists.
 */
export class ProviderProfiles {
  readonly #keysDb: string;
  readonly #listeners = new Set<(profiles: readonly ModelProviderProfile[]) => unknown>();

  constructor(keysDb: string) {
    this.#keysDb = keysDb;
  }

  /**
   * The store's profiles: none before custody first writes the store (the store's own verdict `absent`). Any verdict
   * but `absent` or `accepted` refuses, with the store's reason.
   */
  async load(): Promise<readonly ModelProviderProfile[]> {
    const inspected = await inspectProviderProfileStore(this.#keysDb);
    if (inspected.verdict === 'absent') return [];
    if (inspected.verdict !== 'accepted') throw new Error(`Keys store ${this.#keysDb} is ${inspected.verdict}: ${inspected.reason}`);
    const store = new SqliteProviderProfileStore({ path: this.#keysDb, readOnly: true });
    try {
      return await store.list();
    } finally {
      await store.close();
    }
  }

  subscribe(listener: (profiles: readonly ModelProviderProfile[]) => unknown): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Rereads the store and hands every listener the current profiles; a listener's failure rejects. Safe without a change. */
  async changed(): Promise<void> {
    const profiles = await this.load();
    for (const listener of this.#listeners) await listener(profiles);
  }
}
