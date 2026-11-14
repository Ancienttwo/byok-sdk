import type { DaemonConfigIssue } from './daemon/config-schema/validate.js';

/**
 * Daemon construction rejected configuration or injected runtime adapters:
 * a missing required field, an invalid value, or a duplicate adapter ID.
 * Schema failures come from {@link validateDaemonConfig}; construction also
 * checks invariants that the schema cannot express.
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
