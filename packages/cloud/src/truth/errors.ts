export const TRUTH_COMMIT_ERROR_CODES = [
  'proof_request_conflict',
  'truth_object_not_committed',
] as const;

export type TruthCommitErrorCode = (typeof TRUTH_COMMIT_ERROR_CODES)[number];

export class TruthCommitError extends Error {
  readonly code: TruthCommitErrorCode;
  readonly current?: unknown;

  constructor(code: TruthCommitErrorCode, message: string, current?: unknown) {
    super(message);
    this.name = 'TruthCommitError';
    this.code = code;
    this.current = current;
  }
}

export function isTruthCommitError(value: unknown): value is TruthCommitError {
  return value instanceof TruthCommitError;
}
