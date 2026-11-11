/**
 * The settings bridge domain: device status, settings and diagnostics export. Owned by A5 #1809.
 * Methods are named `settings.<verb>`; the Host handlers live in `src/host/settings/domain.ts`.
 */
import type { BridgeDomain } from '../domain.ts';
import type { DeviceView } from '../../host/settings/device.ts';
import type { DreamingSetting, HostSettings } from '../../host/settings/store.ts';

/** Whether the app opens at login, as the OS reports it. Linux has no login item: `supported` is false there. */
export interface LoginItemView {
  readonly supported: boolean;
  readonly enabled: boolean;
}

export interface SettingsMethods {
  'settings.device': { params: undefined; result: DeviceView };
  'settings.get': { params: undefined; result: HostSettings };
  /** Persists the switch and model list; K8 reads them when the Host next starts. */
  'settings.setDreaming': { params: DreamingSetting; result: HostSettings };
  /** Writes the SDK support bundle to a new file under the Host's diagnostics directory and returns its path; the renderer never names the path. */
  'settings.exportDiagnostics': { params: undefined; result: { path: string } };
  /** Main only: the OS's login item setting is the authority, read on every call. */
  'settings.loginItem': { params: undefined; result: LoginItemView };
  /** Main only: applies the switch through the OS and returns what the OS then reports; refused on Linux. */
  'settings.setLoginItem': { params: { enabled: boolean }; result: LoginItemView };
}

export const SETTINGS_DOMAIN = {
  renderer: ['settings.device', 'settings.get', 'settings.setDreaming', 'settings.exportDiagnostics'],
  main: ['settings.loginItem', 'settings.setLoginItem'],
} as const satisfies BridgeDomain<SettingsMethods>;
