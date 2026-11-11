/**
 * The settings bridge domain: device status, settings and diagnostics export. Owned by A5 #1809.
 * Methods are named `settings.<verb>`; the Host handlers live in `src/host/settings/domain.ts`.
 */
import type { BridgeDomain } from '../domain.ts';

export interface SettingsMethods {}

export const SETTINGS_DOMAIN = { renderer: [], main: [] } as const satisfies BridgeDomain<SettingsMethods>;
