/** The Host side of the settings bridge domain (`src/bridge/domains/settings.ts`). Owned by A5 #1809. */
import type { SettingsMethods } from '../../bridge/domains/settings.ts';
import type { HostDomain, HostContext } from '../domains.ts';

export async function createSettingsDomain(_context: HostContext): Promise<HostDomain<SettingsMethods>> {
  return { handlers: {} };
}
