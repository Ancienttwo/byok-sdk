/**
 * The keys bridge domain: provider keys, written through custody and listed as secret-free statuses. Owned by A6 #1810.
 * Methods are named `keys.<verb>`; the Host handlers live in `src/host/keys/domain.ts`.
 * The secret travels renderer -> main -> custody child stdin and nowhere else:
 * main answers `keys.submit` and `keys.list` itself, and no method returns a secret.
 */
import type { ProviderStatus } from '@byok-sdk/keys';
import type { CustodyChange } from '../../custody/protocol.ts';
import type { BridgeDomain } from '../domain.ts';

export interface KeysMethods {
  /** Main only: one custody child writes the profile and key; the result is the registry's secret-free status. */
  'keys.submit': { params: CustodyChange; result: ProviderStatus };
  /** Main only: one custody child reads statuses, then the Host reconciles its catalog from the persisted profiles. */
  'keys.list': { params: undefined; result: readonly ProviderStatus[] };
  /** Main to Host after a custody receipt or list: the Host rereads the keys store. Not callable from the renderer. */
  'keys.profilesChanged': { params: undefined; result: null };
}

export const KEYS_DOMAIN = { renderer: [], main: ['keys.submit', 'keys.list'] } as const satisfies BridgeDomain<KeysMethods>;
