/** The Host side of the settings bridge domain (`src/bridge/domains/settings.ts`). Owned by A5 #1809. */
import { BridgeError } from '../../bridge/protocol.ts';
import type { SettingsMethods } from '../../bridge/domains/settings.ts';
import type { HostDomain, HostContext } from '../domains.ts';
import { deviceSettings, exportDiagnostics } from './device.ts';
import { settingsFile, settingsStore, type DreamingSetting } from './store.ts';

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
  const store = settingsStore(settingsFile(context.hostStorageRoot));
  // A damaged settings file stops the Host at start, not at the first read.
  await store.read();
  const device = deviceSettings(context.daemon, context.daemonConfig);
  return {
    handlers: {
      'settings.device': () => device.device(),
      'settings.get': () => store.read(),
      'settings.setDreaming': async params => store.setDreaming(dreamingParams(params)),
      'settings.exportDiagnostics': () => exportDiagnostics(context.hostStorageRoot, context.daemonConfig),
    },
  };
}
