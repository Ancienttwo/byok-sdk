/**
 * The result type of the store compatibility precheck (#1102).
 *
 * Each local store is inspected by the package that owns it, with that
 * package's own open path run on a private copy of the files, so the store's
 * code stays the one authority on what it accepts:
 *
 * - `server-sqlite`: `inspectSqliteStore` in `@byok-sdk/server`
 * - `keys-profile-store`: `inspectProviderProfileStore` in `@byok-sdk/keys`
 * - `client-journal` and `pi-durable`: `inspectDaemonStores` in `@byok-sdk/client`
 *
 * The ids are the `store:<id>` items of the upgrade manifest
 * (`docs/upgrade-manifest.md`). The hosted Postgres store is checked by
 * `release-pack-migrate`, not here.
 */
export type LocalStoreId = 'server-sqlite' | 'client-journal' | 'keys-profile-store' | 'pi-durable';

/**
 * What the build that ran the check does when it opens the store:
 *
 * - `accepted`: it opens the store and keeps its data.
 * - `new-path-repair`: it refuses the store as an older format. Start on a new
 *   path and pair or provision again; the old files stay as they are.
 * - `rejected`: it refuses the store for another reason (a newer format, a
 *   damaged file, or data this build will not adopt). The operator resolves
 *   it; `code` and `reason` say what the store reported.
 * - `absent`: there is no store at the path yet, so nothing blocks the switch.
 */
export type StoreCompatibilityVerdict = 'accepted' | 'new-path-repair' | 'rejected' | 'absent';

export interface StoreCompatibility {
  readonly store: LocalStoreId;
  /** The store file that was inspected. */
  readonly path: string;
  readonly verdict: StoreCompatibilityVerdict;
  /** The error code the store reported when it refused the file. */
  readonly code?: string;
  readonly reason: string;
}
