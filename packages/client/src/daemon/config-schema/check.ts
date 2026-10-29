import type { LocalAgentReleaseIdentity } from '../../release-identity';
import type { RuntimeAdapter } from '../../types';
import { resolveDaemonConfig } from '../create-daemon/config';
import { resolveDaemonOperationalConfig } from '../create-daemon/operational-config';
import { buildDefaultAdapters } from '../create-daemon/support';
import type { DaemonConfig } from '../create-daemon';
import { resolveStorageConfig } from '../retention/config';
import { ScratchRootPathError } from '../retention/scratch';
import { DeviceStore } from '../store';
import { describeEffectiveDaemonConfig, type DaemonEffectiveConfig } from './effective';
import { validateDaemonConfig, type DaemonConfigIssue, type DaemonConfigSource } from './validate';

export interface DaemonConfigCheckOptions {
  readonly source: DaemonConfigSource;
  /**
   * `cli`: the distribution's release identity, added after validation,
   * because a config file must not carry `localAgentRelease`.
   */
  readonly localAgentRelease?: LocalAgentReleaseIdentity;
  /** The adapters a Host passes to `createDaemonWithAdapters`. Absent: the set `createDaemon` builds. */
  readonly adapters?: readonly RuntimeAdapter[];
}

export interface DaemonConfigCheck {
  /** No `error` issue. A caller that treats warnings as failures (`config check --strict`) checks `issues`. */
  readonly ok: boolean;
  readonly issues: readonly DaemonConfigIssue[];
  /** The effective values, when the config would construct a daemon. */
  readonly effective?: DaemonEffectiveConfig;
}

/**
 * Validates a `DaemonConfig` without constructing a daemon and, when it
 * would construct, reports its effective values (#1094). Literal problems
 * come from {@link validateDaemonConfig}; a value daemon construction would
 * refuse (a range, a cross-field rule, a scratch root past the socket budget)
 * is an `invalid_value` error. Reads the filesystem (helper assets, store
 * path canonicalization) but writes nothing and starts no process.
 */
export function checkDaemonConfig(input: unknown, options: DaemonConfigCheckOptions): DaemonConfigCheck {
  const { issues } = validateDaemonConfig(input, { source: options.source });
  if (issues.some((issue) => issue.severity === 'error')) return { ok: false, issues };
  const config = (options.localAgentRelease === undefined ? input : { ...(input as object), localAgentRelease: options.localAgentRelease }) as DaemonConfig;
  try {
    const scope = resolveDaemonConfig({ config, overrides: {} });
    resolveDaemonOperationalConfig(config);
    const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
    const storage = resolveStorageConfig(storeDir, config.storage);
    const adapters = options.adapters ?? buildDefaultAdapters(config, scope.piByokLauncher);
    const effective = describeEffectiveDaemonConfig({
      config, warnings: scope.configWarnings, memoryHelper: scope.memoryHelper,
      agentMemoryMcpAdmission: scope.agentMemoryMcpAdmission, storeDir, scratchRoot: storage.scratchRoot,
      adapters, runtimeSource: options.adapters === undefined ? 'sdk-built' : 'injected',
    });
    return { ok: true, issues, effective };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const path = error instanceof ScratchRootPathError ? 'storage.scratchRoot' : '';
    return { ok: false, issues: [...issues, { severity: 'error', code: 'invalid_value', path, message }] };
  }
}
