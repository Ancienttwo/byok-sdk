export const CLOUD_CLEANUP_ERROR_CODES = {
  cleanup_invalid_input: 'cleanup_invalid_input',
  cleanup_policy_missing: 'cleanup_policy_missing',
  cleanup_dead_letter_not_found: 'cleanup_dead_letter_not_found',
  cleanup_dead_letter_is_recovery_floor: 'cleanup_dead_letter_is_recovery_floor',
  cleanup_accounting_drift: 'cleanup_accounting_drift',
} as const;

export type CloudCleanupErrorCode =
  (typeof CLOUD_CLEANUP_ERROR_CODES)[keyof typeof CLOUD_CLEANUP_ERROR_CODES];

export class CloudCleanupError extends Error {
  readonly code: CloudCleanupErrorCode;

  constructor(code: CloudCleanupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CloudCleanupError';
    this.code = code;
  }
}

