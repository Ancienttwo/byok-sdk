import { toolAuthorizationMode } from '../../tool-authorization';
import type { RuntimeAdapter } from '../../types';
import type { DaemonConfig } from '../create-daemon';
import type { DaemonEffectiveRuntime } from './effective';
import type { DaemonConfigIssue } from './validate';

/**
 * The construction checks of a `DaemonConfig.toolAuthorization` policy
 * (#1094), which need the daemon's adapters. Daemon construction throws
 * them as a `DaemonConfigInvalidError`; `checkDaemonConfig` reports them.
 *
 * - A `byRuntime` key must name a runtime of this daemon: it is a permission
 *   setting, and a misspelled key would leave that runtime on `default`.
 * - A runtime whose mode resolves to `auto` must declare
 *   `toolAuthorizationAuto`; otherwise every offer to it would be declined.
 */
export function toolAuthorizationIssues(
  config: Pick<DaemonConfig, 'toolAuthorization'>,
  adapters: readonly RuntimeAdapter[],
  runtimeSource: DaemonEffectiveRuntime['source'],
): DaemonConfigIssue[] {
  const policy = config.toolAuthorization;
  if (policy === undefined) return [];
  const issues: DaemonConfigIssue[] = [];
  const ids = adapters.map((adapter) => adapter.descriptor.id);
  for (const key of Object.keys(policy.byRuntime ?? {})) {
    if (ids.includes(key)) continue;
    const path = `toolAuthorization.byRuntime.${key}`;
    issues.push({
      severity: 'error', code: 'invalid_value', path,
      message: `DaemonConfig.${path} names no runtime of this daemon (runtimes: ${ids.length === 0 ? 'none' : ids.join(', ')})`,
    });
  }
  for (const adapter of adapters) {
    const id = adapter.descriptor.id;
    if (toolAuthorizationMode(policy, id) !== 'auto' || adapter.descriptor.capabilities.toolAuthorizationAuto === true) continue;
    const path = policy.byRuntime !== undefined && Object.hasOwn(policy.byRuntime, id) ? `toolAuthorization.byRuntime.${id}` : 'toolAuthorization.default';
    const remove = runtimeSource === 'sdk-built' ? `remove ${id} from runtimeAllowlist` : `do not pass the ${id} adapter`;
    issues.push({
      severity: 'error', code: 'invalid_value', path,
      message: `DaemonConfig.${path} gives runtime ${id} the auto mode, which ${id} does not support (no toolAuthorizationAuto); set toolAuthorization.byRuntime.${id} to "all" or ${remove}`,
    });
  }
  return issues;
}
