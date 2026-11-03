import type { AgentEvent } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../runtime-failure';
import type { RuntimeAdapterDescriptor, Session, SessionEvidence } from '../types';

/**
 * The optional `Session` members that the adapter descriptor declares, bound
 * once when the session started. The daemon reads these and never
 * `session.<member>?.()`, so a Host wrapper that drops a declared member
 * cannot pass for an adapter without the capability.
 */
export interface DeclaredSessionMembers {
  /** Bound exactly when the descriptor declares `progressMessageBoundary: 'session'`. */
  readonly progressStartsMessage?: (event: Extract<AgentEvent, { type: 'progress' }>) => boolean;
  /**
   * Bound exactly when the descriptor declares `trajectoryEvidence`.
   * `'missing'`: the session has no `evidence()`, so its execution record is
   * `unknown` (`evidence_missing`).
   */
  readonly evidence?: (() => SessionEvidence) | 'missing';
}

/**
 * Binds the members `descriptor` declares on a started `session`. Throws a
 * non-retryable start failure when the descriptor declares
 * `progressMessageBoundary: 'session'` and the session has no
 * `progressStartsMessage()`; the caller still owns and closes the session.
 */
export function bindDeclaredSessionMembers(descriptor: RuntimeAdapterDescriptor, session: Session): DeclaredSessionMembers {
  let progressStartsMessage: DeclaredSessionMembers['progressStartsMessage'];
  if (descriptor.progressMessageBoundary === 'session') {
    if (typeof session.progressStartsMessage !== 'function') {
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: 'authority',
        retry: 'non-retryable',
        reason: `runtime_session_incomplete: runtime "${descriptor.id}" declares progressMessageBoundary "session" but its Session has no progressStartsMessage()`,
      });
    }
    progressStartsMessage = session.progressStartsMessage.bind(session);
  }
  let evidence: DeclaredSessionMembers['evidence'];
  if (descriptor.trajectoryEvidence === 'event-stream') {
    evidence = typeof session.evidence === 'function' ? session.evidence.bind(session) : 'missing';
  }
  return Object.freeze({
    ...(progressStartsMessage === undefined ? {} : { progressStartsMessage }),
    ...(evidence === undefined ? {} : { evidence }),
  });
}
