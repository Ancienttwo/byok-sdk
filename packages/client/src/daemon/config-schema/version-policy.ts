import { runtimeVersionPolicyIssues } from '../../runtime-version-policy';
import type { DaemonConfigIssue } from './validate';

const RUNTIMES = ['pi', 'claude', 'codex'] as const;

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
  for (const id of RUNTIMES) {
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
