import { runtimeVersionPolicyIssues } from './runtime-version-policy';
import { DAEMON_CONFIG_SCHEMA } from './daemon/config-schema/schema.generated';
import type { DaemonConfigIssue } from './daemon/config-schema/validate';

const runtimeProperties = DAEMON_CONFIG_SCHEMA.properties?.runtimes?.properties;
if (!runtimeProperties) throw new Error('DAEMON_CONFIG_SCHEMA has no runtimes.properties; regenerate it with generate-schema.mjs');
const runtimeIds = Object.keys(runtimeProperties);

/**
 * Semantic checks the generated JSON schema cannot express (#1103): a
 * component-boundary prefix, no duplicate spec, and - should a descriptor
 * default ever be configured here - no SDK-level block. `config check` and
 * daemon construction share this one function.
 */
export function versionPolicyConfigIssues(config: unknown): DaemonConfigIssue[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [];
  const runtimes = (config as Record<string, unknown>).runtimes;
  if (runtimes === null || typeof runtimes !== 'object' || Array.isArray(runtimes)) return [];
  const issues: DaemonConfigIssue[] = [];
  for (const id of runtimeIds) {
    const runtime = (runtimes as Record<string, unknown>)[id];
    if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) continue;
    const policy = (runtime as Record<string, unknown>).versionPolicy;
    if (policy === undefined) continue;
    const path = `runtimes.${id}.versionPolicy`;
    for (const issue of runtimeVersionPolicyIssues(policy, { path, hostLayer: true })) {
      issues.push({
        severity: 'error',
        code: 'invalid_version_policy',
        path: issue.path,
        message: `DaemonConfig.${issue.message}`,
      });
    }
  }
  return issues;
}
