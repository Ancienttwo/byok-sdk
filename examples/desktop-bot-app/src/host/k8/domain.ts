/** The Host side of the k8 bridge domain (`src/bridge/domains/k8.ts`). Owned by A2b #1806. */
import type { K8Methods } from '../../bridge/domains/k8.ts';
import type { HostDomain, HostContext } from '../domains.ts';

export async function createK8Domain(_context: HostContext): Promise<HostDomain<K8Methods>> {
  return { handlers: {} };
}
