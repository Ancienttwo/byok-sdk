/** The Host side of the keys bridge domain (`src/bridge/domains/keys.ts`). Owned by A6 #1810. */
import type { KeysMethods } from '../../bridge/domains/keys.ts';
import type { HostDomain, HostContext } from '../domains.ts';

export async function createKeysDomain(_context: HostContext): Promise<HostDomain<KeysMethods>> {
  return { handlers: {} };
}
