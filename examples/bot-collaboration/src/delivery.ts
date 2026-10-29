import { hash } from '@byok-sdk/server/execution-core';
import type { ChannelPort, Delivery } from './channel';

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
type SendResult = Awaited<ReturnType<ChannelPort['send']>>;
type ReadbackResult = Awaited<ReturnType<NonNullable<ChannelPort['readback']>>>;

/** Manual resend supplies a nonce. The original delivery keeps its audit identity. */
export function deliveryId(taskId: string, messageId: string, route: Delivery['route'], nonce?: string): string {
  const key = route.kind === 'reply' ? ['reply', route.inboundId] : ['push', route.pushRouteId];
  return hash(nonce === undefined ? [taskId, messageId, key] : [taskId, messageId, key, nonce]);
}

/** The caller persists this claim before it calls the channel. */
export function startDelivery(row: Delivery, now: number): boolean {
  if (row.state !== 'pending' || row.attempts >= MAX_ATTEMPTS || (row.nextAttemptAt !== undefined && now < row.nextAttemptAt)) return false;
  row.state = 'sending';
  row.attempts++;
  delete row.nextAttemptAt;
  delete row.code;
  return true;
}

function currentAttempt(row: Delivery, attempt: number): boolean {
  return row.state === 'sending' && row.attempts === attempt;
}

function retryDelivery(row: Delivery, now: number, retryAfterMs: number): void {
  const wait = Math.max(retryAfterMs, 1_000 * 2 ** (row.attempts - 1));
  if (wait > MAX_WAIT_MS) {
    row.state = 'rejected';
    return;
  }
  row.state = 'pending';
  row.nextAttemptAt = now + wait;
}

/** A stale completion cannot replace an echo or a later attempt's outcome. */
export function settleDelivery(row: Delivery, attempt: number, result: SendResult, now: number): void {
  if (!currentAttempt(row, attempt)) return;
  if (result?.result === 'accepted' && typeof result.platformMessageId === 'string' && result.platformMessageId.length > 0) {
    row.state = 'accepted';
    row.platformMessageId = result.platformMessageId;
    delete row.code;
    return;
  }
  if (result?.result !== 'rejected' || typeof result.code !== 'string' || result.code.length === 0 || typeof result.retryable !== 'boolean') {
    unknownDelivery(row, attempt, 'invalid_send_result');
    return;
  }
  row.code = result.code;
  if (!result.retryable || row.attempts >= MAX_ATTEMPTS) {
    row.state = 'rejected';
    return;
  }
  const retryAfter = result.retryAfterMs === undefined ? 0 : result.retryAfterMs;
  if (!Number.isFinite(retryAfter) || retryAfter < 0) {
    row.state = 'rejected';
    row.code = 'invalid_retry_after';
    return;
  }
  retryDelivery(row, now, retryAfter);
}

export function unknownDelivery(row: Delivery, attempt: number, code: string): void {
  if (!currentAttempt(row, attempt)) return;
  row.state = 'unknown';
  row.code = code;
  delete row.nextAttemptAt;
}

/** A persisted send claim does not prove that the platform received the message. */
export function recoverDelivery(row: Delivery): void {
  if (row.state === 'sending') unknownDelivery(row, row.attempts, 'interrupted');
}

/**
 * Only authoritative absence permits a new attempt after uncertain I/O. `attempt` is the attempt that the readback observed:
 * a result that comes after a later attempt changes nothing, as `settleDelivery` is fenced by its attempt.
 */
export function readbackDelivery(row: Delivery, attempt: number, result: ReadbackResult, now: number): void {
  if (row.state !== 'unknown' || row.attempts !== attempt) return;
  if (result === 'accepted') {
    row.state = 'accepted';
    delete row.code;
  } else if (result === 'absent') {
    if (row.attempts >= MAX_ATTEMPTS) {
      row.state = 'rejected';
      row.code = 'attempts_exhausted';
    } else {
      delete row.code;
      retryDelivery(row, now, 0);
    }
  }
}

/** The caller has already checked the verified self principal and exact identity. */
export function acceptDeliveryEcho(row: Delivery, platformMessageId: string): boolean {
  if (!platformMessageId) return false;
  if (row.state === 'accepted') {
    if (row.platformMessageId && row.platformMessageId !== platformMessageId) return false;
    row.platformMessageId = platformMessageId;
    return true;
  }
  // A readback can report absence before a delayed platform echo arrives.
  const waitingRetry = row.state === 'pending' && row.attempts > 0;
  if (row.state !== 'sending' && row.state !== 'unknown' && !waitingRetry) return false;
  row.state = 'accepted';
  row.platformMessageId = platformMessageId;
  delete row.code;
  delete row.nextAttemptAt;
  return true;
}
