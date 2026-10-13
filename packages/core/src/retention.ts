import { ByokCoreError } from './errors';
import { assertCanonicalTimestamp } from './time';

export interface CollectExpiredInput {
  readonly now: string;
  readonly limit: number;
}
export interface CollectExpiredResult {
  readonly removed: number;
  readonly expired: number;
  readonly releasedBytes: bigint;
  readonly more: boolean;
}
export function assertCollectExpiredInput(input: CollectExpiredInput): void {
  assertCanonicalTimestamp(input.now, 'now');
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new ByokCoreError('retention_input_invalid', 'collectExpired limit must be a positive safe integer.');
  }
}
/** A committed partial result remains visible when external deletion fails. */
export class CollectExpiredFailure extends ByokCoreError {
  constructor(readonly partial: CollectExpiredResult, options?: ErrorOptions, readonly failures = 1) {
    super('retention_collect_failed', 'Retention collection did not complete.', options);
  }
}
