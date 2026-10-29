import { DaemonConfigFieldRemovedError } from '../daemon-errors';
import { removedDaemonConfigField, validateDaemonConfig, type DaemonConfigIssue } from './validate';

/**
 * `DaemonConfig` failed {@link validateDaemonConfig} at daemon construction:
 * a missing required field, or a value of the wrong JSON type or literal.
 * A removed field throws {@link DaemonConfigFieldRemovedError} instead.
 */
export class DaemonConfigInvalidError extends Error {
  readonly code = 'daemon_config_invalid' as const;

  constructor(readonly issues: readonly DaemonConfigIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'DaemonConfigInvalidError';
  }
}

/** The typed error for a removed field `path` (config or overrides). */
export function removedFieldError(path: string): DaemonConfigFieldRemovedError {
  const removed = removedDaemonConfigField(path);
  if (removed === undefined) throw new Error(`${path} is not a removed DaemonConfig field`);
  return new DaemonConfigFieldRemovedError(removed.path, removed.message, removed.migration);
}

/**
 * Construction-time validation (#1094): throws on the first removed field,
 * then on any other error, and returns the unknown-field warnings (Q4':
 * never rejected). Daemon construction logs them once and reports them in
 * `Daemon.status().config`; `checkDaemonConfig` only reports them.
 */
export function assertDaemonConfigValid(config: unknown): readonly DaemonConfigIssue[] {
  const { issues } = validateDaemonConfig(config, { source: 'embedded' });
  const removed = issues.find((issue) => issue.code === 'removed_field');
  if (removed !== undefined) throw removedFieldError(removed.path);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) throw new DaemonConfigInvalidError(errors);
  return issues.filter((issue) => issue.severity === 'warning');
}
