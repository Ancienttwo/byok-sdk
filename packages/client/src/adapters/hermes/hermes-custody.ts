import { buildAllowlistedEnv } from '../../daemon/environment';
import { assertHermesModelSelection } from './hermes-home';
import path from 'node:path';
import type { ProviderProfileBinding } from '@byok-sdk/protocol';
import type { RuntimeAdapterPrepareInput } from '../../types';
import type { HermesModelSelection } from './hermes-adapter';

type SelectedProfile = Omit<ProviderProfileBinding, 'requiredCapabilities'> & { readonly requiredCapabilities: readonly ProviderProfileBinding['requiredCapabilities'][number][] };

export interface HermesByokLauncher {
  /** Dedicated Host executable running keys.runHermesProviderLauncher; not the Hermes executable. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly profileDbPath: string;
  /** Host local authority, called before claim. Returns exact non-secret binding, never a credential. */
  readonly selectProfile: (offer: RuntimeAdapterPrepareInput['offer']) => SelectedProfile | Promise<SelectedProfile>;
}
export interface PreparedHermesCustody { binding: ProviderProfileBinding; model: HermesModelSelection }
export function ownHermesLauncher(value: HermesByokLauncher): HermesByokLauncher {
  if ((value.args !== undefined && !Array.isArray(value.args)) || !path.isAbsolute(value.command) || !path.isAbsolute(value.profileDbPath) || typeof value.selectProfile !== 'function'
    || [value.command, value.profileDbPath, ...(value.args ?? [])].some(part => typeof part !== 'string' || /[\0\r\n]/u.test(part))) throw new TypeError('Invalid Hermes custody launcher');
  return Object.freeze({ ...value, args: Object.freeze([...(value.args ?? [])]) });
}
export function hermesCustodyArgs(launcher: HermesByokLauncher, binding: ProviderProfileBinding, launch?: { hermesBin: string; home: string; role: 'gateway' | 'viewer' }): string[] {
  return [...(launcher.args ?? []), '--hermes-custody-request', JSON.stringify({ profileDbPath: launcher.profileDbPath, binding, ...(launch ? { launch } : {}) })];
}
export async function prepareHermesCustody(launcher: HermesByokLauncher, offer: RuntimeAdapterPrepareInput['offer']): Promise<PreparedHermesCustody> {
  const runtime = await import('#byok-hermes-async');
  return runtime.prepareHermesCustody(launcher, offer, { hermesCustodyArgs, buildAllowlistedEnv, assertHermesModelSelection });
}
