import path from 'node:path';
import type { RuntimeAdapterDescriptor, RuntimeDetectResult, RuntimeExecutableSource } from '../types.js';
import type { ResolvedSdkReservedHelperBin } from '../sdk-reserved-helper-host.js';
import type { DaemonConfig } from './create-daemon.js';
import type { DaemonEffectiveRuntime } from './config-schema/effective.js';
import { SEARCH_RUNTIME_EVIDENCE } from './search-runtime-evidence.js';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment.js';
import { dshEnvironment } from '../adapters/dsh/dsh-profile.js';
import { agyEnvironment } from '../adapters/antigravity/agy-profile.js';

export interface SearchRuntimeEvidence {
  readonly runtimeId: string;
  readonly variant: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly lane: 'ordinary';
  readonly helper: 'dist-script' | 'single-file' | 'sea';
  readonly version: string;
  readonly executableSource: RuntimeExecutableSource | 'sdk-entry';
  readonly receipt: string;
  /** The receipt validates the native outer identity, call ID and raw arguments. */
  readonly innerAttempts?: true;
}

export interface SearchRuntimeQualification {
  readonly bin: Pick<ResolvedSdkReservedHelperBin, 'command' | 'args'>;
  readonly candidates: (descriptor: RuntimeAdapterDescriptor) => readonly SearchRuntimeEvidence[];
  readonly projectEnvironment?: (runtimeId: string, env: Readonly<Record<string, string>>) => Readonly<Record<string, string>>;
}

/** Match SDK construction and launch configuration before probing a runtime. */
export function searchRuntimeCandidates(
  config: Pick<DaemonConfig, 'sdkHelperHost' | 'piByokLauncher'>,
  runtimes: readonly DaemonEffectiveRuntime[],
): SearchRuntimeQualification['candidates'] {
  const helper = config.sdkHelperHost === undefined ? 'dist-script' : config.sdkHelperHost.entry === undefined ? 'sea' : 'single-file';
  const byId = new Map(runtimes.filter(runtime => runtime.source === 'sdk-built').map(runtime => {
    const { id, isolation } = runtime;
    // Paths and model selections are local values. Switches that select
    // runtime launch and isolation behavior are part of the qualification.
    const variant = Object.entries(isolation ?? {})
      .filter(([key]) => key !== 'home' && key !== 'model')
      .map(([key, value]) => `${key}=${key === 'packageDir' ? 'configured' : value}`);
    if (id === 'pi') variant.push(config.piByokLauncher === undefined ? 'launcher=sdk' : 'launcher=keys');
    return [id, variant.sort().join(',')];
  }));
  return (descriptor) => {
    if (descriptor.id === 'codex') return [];
    const variant = byId.get(descriptor.id);
    return SEARCH_RUNTIME_EVIDENCE.filter(row => row.runtimeId === descriptor.id && row.variant === variant
      && row.platform === process.platform && row.arch === process.arch && row.helper === helper && row.lane === 'ordinary');
  };
}

/** The Pi input here is already its MCP child environment. Other adapters use
 * the task environment and, where applicable, their owned profile projection. */
export function searchMcpEnvironmentFor(config: DaemonConfig): NonNullable<SearchRuntimeQualification['projectEnvironment']> {
  const dsh = config.runtimes?.dsh;
  const dshHome = dsh === undefined ? undefined : path.resolve(dsh.home);
  const dshSandbox = dsh?.sandbox ?? 'danger-full-access';
  const agy = config.runtimes?.agy;
  const agyHome = agy === undefined ? undefined : path.resolve(agy.home);
  return (runtimeId, env) => {
    if (runtimeId === 'dsh' && dshHome !== undefined) {
      return dshEnvironment(env, dshHome, dshSandbox);
    }
    if (runtimeId === 'agy' && agyHome !== undefined) return agyEnvironment(env, agyHome);
    return env;
  };
}

const providerCredentialNames = new Set(PROVIDER_CREDENTIAL_ENV_DENY_NAMES);

export function projectSearchMcpEnvironment(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(env).filter(([name]) => {
    const key = name.toUpperCase();
    return !key.startsWith('BYOK_') && key !== 'CLAUDECODE' && !providerCredentialNames.has(key);
  })));
}

export function matchSearchRuntimeEvidence(rows: readonly SearchRuntimeEvidence[], detected: Extract<RuntimeDetectResult, { kind: 'available' }>): SearchRuntimeEvidence | undefined {
  return rows.find(row => row.version === detected.version && row.executableSource === (detected.executableSource ?? 'sdk-entry'));
}
