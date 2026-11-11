/** The Host side of the keys bridge domain (`src/bridge/domains/keys.ts`). Owned by A6 #1810. */
import type { KeysMethods } from '../../bridge/domains/keys.ts';
import type { HostDomain, HostContext } from '../domains.ts';

/** The Host never sees a key: it only rereads the keys store when main reports a custody receipt. */
export async function createKeysDomain(context: HostContext): Promise<HostDomain<KeysMethods>> {
  return {
    handlers: {
      'keys.profilesChanged': async () => {
        await context.profiles.changed();
        return null;
      },
    },
  };
}
