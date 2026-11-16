import { validateDaemonConfig } from './validate.js';
import { versionPolicyConfigIssues } from '../../daemon-config-version-policy.js';
import { DaemonConfigInvalidError } from '../../daemon-config-invalid-error.js';

/**
 * Construction-time validation (#1094): throws a {@link DaemonConfigInvalidError}
 * on any schema issue, unknown fields included, then on any version-policy issue.
 */
export function assertDaemonConfigValid(config: unknown): void {
  const { issues } = validateDaemonConfig(config, { source: 'embedded' });
  // Semantic policy checks only make sense once the JSON shape is valid.
  const errors = issues.length > 0 ? issues : versionPolicyConfigIssues(config);
  if (errors.length > 0) throw new DaemonConfigInvalidError(errors);
}
