/**
 * The k8 bridge domain: Bots, their conversations and the clear divider. Owned by A2b #1806.
 * Methods are named `k8.<verb>`; the Host handlers live in `src/host/k8/domain.ts`.
 */
import type { BridgeDomain } from '../domain.ts';

export interface K8Methods {}

export const K8_DOMAIN = { renderer: [], main: [] } as const satisfies BridgeDomain<K8Methods>;
