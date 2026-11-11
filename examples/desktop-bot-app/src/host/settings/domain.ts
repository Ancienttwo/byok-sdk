/** The Host side of the settings bridge domain (`src/bridge/domains/settings.ts`). Owned by A5 #1809. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../../bridge/protocol.ts';
import type { SettingsMethods } from '../../bridge/domains/settings.ts';
import type { HostDomain, HostContext } from '../domains.ts';
import { deviceSettings } from './device.ts';
import { settingsStore, type DreamingSetting } from './store.ts';

/** The renderer's params are the untrusted boundary: validate once here and pass the typed value on. */
function dreamingParams(params: unknown): DreamingSetting {
  const value = params as { enabled?: unknown; models?: unknown } | null;
  if (typeof value?.enabled !== 'boolean' || !Array.isArray(value.models)
    || value.models.some(model => typeof model !== 'string' || model === '')
    || new Set(value.models).size !== value.models.length) {
    throw new BridgeError('invalid_params', 'settings.setDreaming needs { enabled: boolean, models: unique non-empty strings }');
  }
  return { enabled: value.enabled, models: value.models as string[] };
}

export async function createSettingsDomain(context: HostContext): Promise<HostDomain<SettingsMethods>> {
  const hostDir = path.join(context.hostStorageRoot, 'host');
  const store = settingsStore(path.join(hostDir, 'settings.json'));
  // A damaged settings file stops the Host at start, not at the first read.
  await store.read();
  const device = deviceSettings(context.daemon, context.daemonConfig);
  return {
    handlers: {
      'settings.device': () => device.device(),
      'settings.get': () => store.read(),
      'settings.setDreaming': async params => store.setDreaming(dreamingParams(params)),
      'settings.exportDiagnostics': async () => {
        const directory = path.join(hostDir, 'diagnostics');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `support-bundle-${new Date().toISOString().replaceAll(':', '-')}.json`);
        await device.exportDiagnostics(file);
        return { path: file };
      },
    },
  };
}
