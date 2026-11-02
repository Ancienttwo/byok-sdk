import type { DaemonConfigIssue } from './daemon/config-schema/validate';

/**
 * `DaemonConfig` failed {@link validateDaemonConfig} at daemon construction:
 * a missing required field, or a value of the wrong JSON type or literal.
 * A removed field throws {@link DaemonConfigFieldRemovedError} instead.
 * `createRuntimeAdapters` throws it too, so this module stays free of the
 * schema and the validator that the `/adapters` entry must not load.
 */
export class DaemonConfigInvalidError extends Error {
  readonly code = 'daemon_config_invalid' as const;

  constructor(readonly issues: readonly DaemonConfigIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'DaemonConfigInvalidError';
  }
}
