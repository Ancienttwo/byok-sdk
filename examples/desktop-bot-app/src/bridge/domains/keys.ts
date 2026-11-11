/**
 * The keys bridge domain: provider keys (write-only). Owned by A6 #1810.
 * Methods are named `keys.<verb>`; the Host handlers live in `src/host/keys/domain.ts`.
 */
import type { BridgeDomain } from '../domain.ts';

export interface KeysMethods {}

export const KEYS_DOMAIN = { renderer: [], main: [] } as const satisfies BridgeDomain<KeysMethods>;
