import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ProviderProfileBinding } from '@byok-sdk/protocol';
import { buildAllowlistedEnv } from '../../runtime/environment';
import type { RuntimeAdapterPrepareInput } from '../../types';
import type { HermesModelSelection } from './hermes-adapter';
import { assertHermesModelSelection } from './hermes-home';

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
  // Copy only non-secret binding fields. The keys launcher owns strict validation;
  // keep the adapters entry free of runtime protocol/Zod dependencies.
  const selected = await launcher.selectProfile(offer);
  const binding: ProviderProfileBinding = {
    profileRef: selected.profileRef, profileRevision: selected.profileRevision,
    profileHash: selected.profileHash, modelId: selected.modelId,
    requiredCapabilities: [...selected.requiredCapabilities],
  };
  const stdout = await new Promise<string>((resolve, reject) => execFile(launcher.command, hermesCustodyArgs(launcher, binding),
    { env: buildAllowlistedEnv({ ambient: process.env }), timeout: 5000, maxBuffer: 16_384, encoding: 'utf8' },
    (error, output) => error ? reject(new Error('Hermes custody admission failed')) : resolve(output)));
  const model = JSON.parse(stdout) as HermesModelSelection;
  assertHermesModelSelection(model, 'Hermes custody model');
  if (model.provider !== 'custom' || model.model !== binding.modelId || model.keyEnv !== 'SDK_HERMES_PROVIDER_KEY' || model.baseUrl === undefined) throw new Error('Hermes custody model mismatch');
  return { binding, model };
}
