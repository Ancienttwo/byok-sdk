/**
 * The keys bridge domain: provider keys (write-only). Owned by A6 #1810.
 * Methods are named `keys.<verb>`; the Host handlers live in `src/host/keys/domain.ts`.
 * The secret travels renderer -> main -> custody child stdin and nowhere else:
 * main answers `keys.submit` itself, and no method returns a secret.
 */
import type { ProviderStatus } from '@byok-sdk/keys';
import type { CustodyRequest } from '../../custody/protocol.ts';
import type { BridgeDomain } from '../domain.ts';

export interface KeysMethods {
  /** Main only: one custody child writes the profile and key; the result is the registry's secret-free status. */
  'keys.submit': { params: CustodyRequest; result: ProviderStatus };
  /** Main to Host after a custody receipt: the Host rereads the keys store. Not callable from the renderer. */
  'keys.profilesChanged': { params: undefined; result: null };
}

export const KEYS_DOMAIN = { renderer: [], main: ['keys.submit'] } as const satisfies BridgeDomain<KeysMethods>;
