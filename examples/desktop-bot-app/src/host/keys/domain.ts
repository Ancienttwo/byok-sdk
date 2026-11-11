/** The Host side of the keys bridge domain (`src/bridge/domains/keys.ts`). Owned by A6 #1810. */
import type { KeysMethods } from '../../bridge/domains/keys.ts';
import type { HostDomain, HostContext } from '../domains.ts';
import { ProviderProfiles } from './catalog.ts';
import { keysDbPath } from './launcher.ts';

/** The Host never sees a key: it only rereads the keys store when main reports a custody receipt. */
export async function createKeysDomain(context: HostContext): Promise<HostDomain<KeysMethods> & { readonly profiles: ProviderProfiles }> {
  const profiles = new ProviderProfiles(keysDbPath(context.hostStorageRoot));
  return {
    profiles,
    handlers: {
      'keys.profilesChanged': async () => {
        await profiles.changed();
        return null;
      },
    },
  };
}
