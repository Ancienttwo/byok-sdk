import type { RuntimeFailureClass, RuntimeQuotaScope, TaskFailure } from '@byok-sdk/protocol';
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

/** Scopes of Claude Code 2.1.302 `rate_limit_info.rateLimitType` values (#1271); any other names none. */
const RATE_LIMIT_SCOPES: Readonly<Record<string, RuntimeQuotaScope>> = {
  five_hour: 'account',
  seven_day: 'account',
  seven_day_opus: 'model',
  seven_day_sonnet: 'model',
};

/** 9999-12-31T23:59:59Z: the last second the wire's four-digit-year timestamp can carry. */
const MAX_RESETS_AT_SECONDS = 253_402_300_799;

/**
 * The failure class of one Claude session's failed turns, from structured
 * frame fields only (#869): the turn's last `assistant.error`, else the
 * result's `api_error_status`, else `unknown`. `reason` is never read.
 * `observe` takes every raw frame before it is mapped; a `result` frame ends
 * the turn and its error. The latest `rate_limit_info` is kept across turns:
 * it is the runtime's last report. `attach` gives a failed `result` frame's
 * failure the class of its turn.
 */
export class ClaudeFailureEvidence {
  #error: string | undefined;
  #rateLimit: Record<string, unknown> | undefined;
  #turn: TaskFailure | undefined;

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
      const { resetsAt, rateLimitType } = this.#rateLimit;
      return {
        class: 'quota',
        ...(typeof resetsAt === 'number' && Number.isInteger(resetsAt) && resetsAt >= 0 && resetsAt <= MAX_RESETS_AT_SECONDS
          ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
        ...(typeof rateLimitType === 'string' && Object.hasOwn(RATE_LIMIT_SCOPES, rateLimitType) ? { scope: RATE_LIMIT_SCOPES[rateLimitType]! } : {}),
      };
    }
    if (error !== undefined) return { class: Object.hasOwn(ASSISTANT_ERROR_CLASSES, error) ? ASSISTANT_ERROR_CLASSES[error]! : 'unknown' };
    return { class: typeof status === 'number' && Number.isInteger(status) ? failureFromStatus(status) : 'unknown' };
  }
}
