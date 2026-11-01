import type { LocalAgentReleaseIdentity } from '../../release-identity';
import { DaemonConfigInvalidError } from './errors';
import type { RuntimeAdapter } from '../../types';
import { AgentEgressPolicyError, resolveAgentEgressPolicy } from '../agent-egress-policy';
import { resolveDaemonConfig } from '../create-daemon/config';
import { resolveDaemonOperationalConfig } from '../create-daemon/operational-config';
import { buildDefaultAdapters, injectedAdapterConfigConflicts } from '../create-daemon/support';
import type { DaemonConfig } from '../create-daemon';
import { resolveStorageConfig } from '../retention/config';
import { ScratchRootPathError } from '../retention/scratch';
import { DeviceStore } from '../store';
import { describeEffectiveDaemonConfig, type DaemonEffectiveConfig } from './effective';
import { toolAuthorizationIssues } from './static-tool-authorization';
import { validateDaemonConfig, type DaemonConfigIssue, type DaemonConfigSource } from './validate';
import { versionPolicyConfigIssues } from './version-policy';

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
 * refuse (a range, a cross-field rule, a scratch root past the socket budget,
 * a static tool-authorization mode the adapters cannot run) is an
 * `invalid_value` error. Reads the filesystem (helper assets, store
 * path canonicalization) but writes nothing and starts no process.
 */
export function checkDaemonConfig(input: unknown, options: DaemonConfigCheckOptions): DaemonConfigCheck {
  const { issues } = validateDaemonConfig(input, { source: options.source });
  if (issues.some((issue) => issue.severity === 'error')) return { ok: false, issues };
  if (options.adapters !== undefined) {
    const conflicts = injectedAdapterConfigConflicts(input as object);
    if (conflicts.length > 0) {
      return { ok: false, issues: [...issues, ...conflicts.map(({ key, message }): DaemonConfigIssue => ({ severity: 'error', code: 'invalid_value', path: key, message }))] };
    }
  }
  const policyIssues = versionPolicyConfigIssues(input);
  if (policyIssues.length > 0) return { ok: false, issues: [...issues, ...policyIssues] };
  const config = (options.localAgentRelease === undefined ? input : { ...(input as object), localAgentRelease: options.localAgentRelease }) as DaemonConfig;
  try {
    const scope = resolveDaemonConfig({ config, overrides: {} });
    if (config.agentEgress !== undefined) resolveAgentEgressPolicy(config.agentEgress.policy);
    resolveDaemonOperationalConfig(config);
    const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
    const storage = resolveStorageConfig(storeDir, config.storage);
    const adapters = options.adapters ?? buildDefaultAdapters(config, scope.piByokLauncher);
    const runtimeSource = options.adapters === undefined ? 'sdk-built' : 'injected';
    const authorizationIssues = toolAuthorizationIssues(config, adapters, runtimeSource);
    if (authorizationIssues.length > 0) return { ok: false, issues: [...issues, ...authorizationIssues] };
    const effective = describeEffectiveDaemonConfig({
      config, warnings: scope.configWarnings, memoryHelper: scope.memoryHelper,
      agentMemoryMcpAdmission: scope.agentMemoryMcpAdmission, storeDir, scratchRoot: storage.scratchRoot,
      adapters, runtimeSource,
    });
    return { ok: true, issues, effective };
  } catch (error) {
    if (error instanceof AgentEgressPolicyError) {
      return { ok: false, issues: [...issues, ...error.issues.map(({ path, message }): DaemonConfigIssue => ({
        severity: 'error', code: 'invalid_value', path: ['agentEgress', 'policy', ...path].join('.'), message,
      }))] };
    }
    if (error instanceof DaemonConfigInvalidError) return { ok: false, issues: [...issues, ...error.issues] };
    const message = error instanceof Error ? error.message : String(error);
    const path = error instanceof ScratchRootPathError ? 'storage.scratchRoot' : '';
    return { ok: false, issues: [...issues, { severity: 'error', code: 'invalid_value', path, message }] };
  }
}
