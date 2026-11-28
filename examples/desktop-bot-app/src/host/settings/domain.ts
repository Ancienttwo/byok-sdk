/** The Host side of the settings bridge domain (`src/bridge/domains/settings.ts`). Owned by A5 #1809. */
import { BridgeError } from '../../bridge/protocol.ts';
import type { DeviceParams, SettingsMethods } from '../../bridge/domains/settings.ts';
import type { HostDomain, HostContext } from '../domains.ts';
import { deviceSettings, exportDiagnostics } from './device.ts';
import { settingsFile, settingsStore, type DreamingSetting } from './store.ts';

/** Validates optional `settings.device` params once at the Host boundary (`null` arrives from FFI when omitted). */
function deviceParams(params: unknown): DeviceParams {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new BridgeError('invalid_params', 'settings.device takes optional { checkAuth?: boolean }');
  }
  const value = params as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'checkAuth') || (value.checkAuth !== undefined && typeof value.checkAuth !== 'boolean')) {
    throw new BridgeError('invalid_params', 'settings.device takes optional { checkAuth?: boolean }');
  }
  return value.checkAuth === undefined ? {} : { checkAuth: value.checkAuth };
}

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
  const device = deviceSettings(context.daemon, context.daemonConfig, context.adapters, {
    ...(context.shutdownSignal === undefined ? {} : { shutdownSignal: context.shutdownSignal }),
  });
  return {
    handlers: {
      'settings.device': async params => device.device(deviceParams(params)),
      'settings.get': () => store.read(),
      'settings.setDreaming': async params => store.setDreaming(dreamingParams(params)),
      'settings.exportDiagnostics': () => exportDiagnostics(context.hostStorageRoot, context.daemonConfig),
    },
  };
}
