/** Journal execution states, not wire terminals: cancellation may still win. */
export type ResultReplyFailure = 'required-reply-result-missing' | 'required-reply-result-unreadable';
export function isResultReplyFailure(value: string): value is ResultReplyFailure {
  return value === 'required-reply-result-missing' || value === 'required-reply-result-unreadable';
}
/** Stable across restart; do not persist filesystem/backend exception text. */
export function resultReplyFailureReason(kind: ResultReplyFailure, contract: string): string {
  return kind === 'required-reply-result-missing'
    ? `result_not_submitted: the offer requires result contract ${contract}, but the runtime ended its turn without a staged submit_result outcome`
    : `result_unreadable: the staged result for contract ${contract} could not be read or validated`;
}
