import type { RuntimeFailureClass, TaskFailure } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../../runtime-failure';
import { failureFromStatus } from '../../runtime/oar-failure-runtime';
import type { ClaudeStreamMessage } from './events';

/**
 * Classes of the public `assistant.error` values of Claude Code 2.1.302
 * stream-json. `rate_limit` is classified with the rate-limit report.
 */
const ASSISTANT_ERROR_CLASSES: Readonly<Record<string, RuntimeFailureClass>> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  cloud_credential_error: 'auth',
  verification_required: 'auth',
  billing_error: 'billing',
  account_on_hold: 'billing',
  overloaded: 'overloaded',
  invalid_request: 'invalid_request',
  model_not_found: 'model_unavailable',
  server_error: 'provider',
};

/** `Date`'s range, in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/**
 * The failure class of one Claude session's failed turns, from structured
 * frame fields only (#869): the turn's last `assistant.error`, else the
 * result's `api_error_status`, else `unknown`. `reason` is never read.
 */
export class ClaudeFailureEvidence {
  /** The current turn's last `assistant.error`. */
  #error: string | undefined;
  /** The latest `rate_limit_event.rate_limit_info`, kept across turns: the runtime's last report. */
  #rateLimit: Record<string, unknown> | undefined;
  /** The class of the last `result` frame. */
  #turn: TaskFailure | undefined;

  /** Every raw frame, before it is mapped. A `result` frame ends the turn. */
  observe(frame: ClaudeStreamMessage): void {
    if (frame.type === 'assistant' && typeof frame.error === 'string') {
      this.#error = frame.error;
    } else if (frame.type === 'rate_limit_event' && typeof frame.rate_limit_info === 'object' && frame.rate_limit_info !== null) {
      this.#rateLimit = frame.rate_limit_info as Record<string, unknown>;
    } else if (frame.type === 'result') {
      this.#turn = this.#classify(frame.api_error_status);
      this.#error = undefined;
    }
  }

  /** A failed `result` frame's failure, with the class of its turn. */
  attach(frame: ClaudeStreamMessage, failure: RuntimeExecutionFailure): RuntimeExecutionFailure {
    if (frame.type !== 'result' || frame.is_error !== true || this.#turn === undefined) return failure;
    return new RuntimeExecutionFailure({
      phase: failure.phase,
      category: failure.category,
      retry: failure.retry,
      reason: failure.message,
      failure: this.#turn,
    }, { cause: failure.cause });
  }

  #classify(status: unknown): TaskFailure {
    const error = this.#error;
    if (error === 'rate_limit') {
      // A rejected limit is the subscription limit (OAR); otherwise it is throttling.
      if (this.#rateLimit?.status !== 'rejected') return { class: 'rate_limited' };
      const resetsAt = this.#rateLimit.resetsAt;
      return typeof resetsAt === 'number' && Number.isInteger(resetsAt) && Math.abs(resetsAt * 1000) <= MAX_DATE_MS
        ? { class: 'quota', resetsAt: new Date(resetsAt * 1000).toISOString() }
        : { class: 'quota' };
    }
    if (error !== undefined) return { class: Object.hasOwn(ASSISTANT_ERROR_CLASSES, error) ? ASSISTANT_ERROR_CLASSES[error]! : 'unknown' };
    return { class: typeof status === 'number' && Number.isInteger(status) ? failureFromStatus(status) : 'unknown' };
  }
}
