import type { Envelope } from '@byok-sdk/protocol';
import { encodeEnvelope, decodeEnvelope, createEnvelope, isSealedPayload, requiredReceiverCapabilities } from '@byok-sdk/protocol';
import { terminalKindOf } from './support';
import { journalHash, JournalRecordTooLargeError, type ReceivedEnvelopeRecord } from '../journal/journal';
import type { AgentRef } from '../../agent-home';
import { taskFailureField, DAEMON_TASK_FAILURE } from '../task-failure';
import { terminalIdentity } from '../terminal-identity';
import type { SealedTasks } from '../sealed-task';
import type { TaskRunnerDeps } from '../task-runner';
import { resultReplyFailureFromState } from '../result-reply-failure';
import type { DaemonScope } from './scope';
import type { StartRun } from './start-run';
import type { StartLanes } from './start-lanes';

/**
 * The third stage of `runStartUnderLease` (#926), synchronous: builds the
 * terminal pipeline — journal commit, sealing, the outbound send, refused and
 * over-bound terminal replacement, and the result-reply state transitions.
 */
export function composeStartTerminals(daemonScope: DaemonScope, run: Pick<StartRun & StartLanes, 'sealedRun' | 'activeJournal' | 'journalIdentity' | 'opened' | 'record'>) {
  const { terminalCommits, overrides, observer, daemonState, approvalRegistry } = daemonScope;
  const { sealedRun, activeJournal, journalIdentity, opened, record } = run;
  /** With `replaces`, the terminal replaces the refused terminal of that hash (#654 §77b). */
  const commitTerminal = (taskId: string, terminal: Envelope | (() => Promise<Envelope | undefined>), replaces?: string): void => {
    const ownerIdentity = sealedRun.ownSealIdentity;
    const plainBytes = typeof terminal === 'function' ? undefined : encodeEnvelope(terminal);
    // A sealed terminal is sealed once and its bytes are journaled; a retry
    // of the commit reuses them and never seals or uploads again (§9.2).
    let sealing: Promise<Envelope | undefined> | undefined;
    // The seal and its upload run before the commit joins the one commit
    // tail, so a slow upload holds no other task's terminal.
    const seal = typeof terminal === 'function'
      ? async (): Promise<void> => {
        sealing ??= terminal();
        try { await sealing; } catch (error) { sealing = undefined; throw error; }
      }
      : undefined;
    terminalCommits.enqueue(taskId, async () => {
      let envelope: Envelope | undefined;
      if (typeof terminal === 'function') {
        envelope = await sealing;
        if (envelope === undefined) return;
      } else envelope = terminal;
      const bytes = plainBytes ?? encodeEnvelope(envelope);
      try {
        const durableRecord = { taskId, terminalType: terminalKindOf(envelope.type)!, bytes,
          payloadHash: journalHash(bytes), truthState: 'pending' as const, attempt: 1, recordedAt: new Date().toISOString() };
        await (replaces === undefined ? activeJournal.recordTerminal(durableRecord) : activeJournal.replaceRefusedTerminal(taskId, replaces, durableRecord));
        // Read the first immutable winner, not an attempted replacement candidate.
        const durableTerminal = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
        if (!durableTerminal || durableTerminal.truthState !== 'pending') return;
        const durable = decodeEnvelope(durableTerminal.bytes);
        overrides.executionRecoveryFault?.('terminal:before-send');
        observer.captureOutboundApproval(durable);
        daemonState.connection?.send(durable);
      } catch (error: unknown) {
        if (!(error instanceof JournalRecordTooLargeError)) throw error;
        // A completed result can exceed the journal's bounded record size.
        // Do not truncate or invent a success: settle the exact task identity
        // with one small, canonical, non-retryable failure. The offer is the
        // sole source of AgentRef, so a foreign or missing ref is never guessed.
        const task = await activeJournal.readTask(taskId, journalIdentity);
        if (!task) throw new Error(`missing durable task ${taskId}`);
        if (!('envelopeBytes' in task)) throw new Error(`task ${taskId} has a withheld offer and no result`);
        const offer = decodeEnvelope(task.envelopeBytes);
        if (offer.type !== 'task.offer' || offer.task_id !== taskId) throw new Error(`invalid durable offer binding for ${taskId}`);
        const offerPayload = offer.payload as { agentRef?: AgentRef };
        const plainFailure = createEnvelope('task.fail', {
          reason: 'terminal_result_too_large', retryable: false,
          ...taskFailureField(DAEMON_TASK_FAILURE, daemonState.connection?.getServerCapabilities() ?? []),
          ...terminalIdentity(task.claimedRuntime, offerPayload.agentRef),
        }, { taskId });
        // Only the owner run's tenant, device and member seal this failure.
        const sameIdentity = ownerIdentity !== undefined && ownerIdentity === daemonState.latestSealIdentity?.();
        const failure = await daemonState.latestSealedTasks!.sealRecovered(offer, plainFailure, sameIdentity);
        const failureBytes = encodeEnvelope(failure);
        await activeJournal.recordTerminal({ taskId, terminalType: 'failed', bytes: failureBytes,
          payloadHash: journalHash(failureBytes), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
        const durableFailure = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
        if (!durableFailure || durableFailure.truthState !== 'pending') return;
        const decoded = decodeEnvelope(durableFailure.bytes);
        observer.captureOutboundApproval(decoded);
        daemonState.connection?.send(decoded);
        // Never recurse through arbitrary fallback terminals. A storage or
        // canonicalization failure remains visible and requires operator
        // recovery; the oversized result itself is never silently dropped.
      }
    }, seal);
  };

  /**
   * #654: seals a sealed task's terminal when the commit queue runs it. The
   * queue can hold it past a failed stop. Then it seals through the run it
   * runs in, after that run's start and member resume: a throw here is a
   * retry. A run whose resume found no member, or whose member is lost,
   * gives the closed plaintext form. Without an `owner` run, it always seals
   * through the task's journaled offer.
   */
  const sealQueuedTerminal = async (owner: SealedTasks | undefined, ownerIdentity: string | undefined, envelope: Envelope): Promise<Envelope | undefined> => {
    const taskId = envelope.task_id!;
    if (daemonState.startInProgress) throw new Error(`${envelope.type} for sealed task ${taskId} waits for the start under way`);
    const current = daemonState.latestSealedTasks!;
    if (current === owner) return owner.sealOutbound(envelope);
    if (daemonState.memberResuming) throw new Error(`${envelope.type} for sealed task ${taskId} waits for this run's member`);
    const task = await activeJournal.readTask(taskId, journalIdentity);
    if (!task || !('envelopeBytes' in task)) throw new Error(`missing durable offer of sealed task ${taskId}`);
    // A run under another tenant, device or member never seals this task's output.
    return current.sealRecovered(decodeEnvelope(task.envelopeBytes), envelope, ownerIdentity !== undefined && ownerIdentity === daemonState.latestSealIdentity?.());
  };

  // #654: a task waits on its approval request. One that cannot be sealed
  // (no sealing key, or over the inline frame) never reaches the Host, so
  // the device denies it locally and the task goes on or ends.
  const denyUnsentApproval = (envelope: Envelope): void => {
    const { approvalId } = envelope.payload as { approvalId?: string };
    if (envelope.type !== 'task.await_approval' || approvalId === undefined) return;
    console.error(`[byok/client] approval ${approvalId} of sealed task ${envelope.task_id} was not sent; denied locally`);
    try {
      approvalRegistry.resolve(approvalId, 'reject', 'the approval request could not be sealed for the Host', 'fail-closed');
    } catch {
      // Already resolved, for example by the approval timeout.
    }
  };

  // The journal owns terminal bytes; the transport owns one delivery queue.
  // A local write failure must never bypass durability and send different truth.
  // #654: a task that seals its output sends each outbound sealed, in order.
  const sendEnvelope: TaskRunnerDeps['send'] = (envelope) => {
    const terminal = envelope.task_id !== undefined && terminalKindOf(envelope.type) !== undefined;
    if (sealedRun.sealedTasks?.sealsOutbound(envelope)) {
      // The local observer reads the plaintext envelope; see `plainOf`.
      observer.captureOutboundApproval(envelope);
      const sealedTaskOutput = sealedRun.sealedTasks;
      if (terminal) {
        const ownerIdentity = sealedRun.ownSealIdentity;
        commitTerminal(envelope.task_id!, () => sealQueuedTerminal(sealedTaskOutput, ownerIdentity, envelope));
        return;
      }
      void sealedTaskOutput.sealOutbound(envelope).then(
        (sealed) => { if (sealed !== undefined) daemonState.connection?.send(sealed); else denyUnsentApproval(envelope); },
        (error: unknown) => {
          console.error(`[byok/client] ${envelope.type} for sealed task ${envelope.task_id} not sent`, error);
          denyUnsentApproval(envelope);
        },
      );
      return;
    }
    if (!terminal) {
      observer.captureOutboundApproval(envelope);
      daemonState.connection?.send(envelope);
      return;
    }
    commitTerminal(envelope.task_id!, envelope);
  };

  /**
   * #654 §77b: a sealed terminal that named its ciphertext blob and that the
   * Host refused gets one replacement, the failure of a terminal that cannot
   * be sealed. It seals with the member that sealed the refused terminal once
   * this run's start and member resume are over, else it is the closed
   * plaintext form. A journaled terminal is replaced in the journal, so the
   * Host receives exactly one terminal. Never throws: the caller is the
   * outbound settlement, which would post the refused bytes again.
   */
  const replaceRefusedTerminal = (refused: Envelope): void => {
    const failure = opened.refusedReplacement(refused);
    if (failure === undefined) return;
    const taskId = refused.task_id!;
    const refusedHash = journalHash(encodeEnvelope(refused));
    const ownerIdentity = JSON.stringify([record.tenantId, record.deviceId, (refused.payload as { sealed: { sender: string } }).sealed.sender]);
    commitTerminal(taskId, async () => {
      // A repeated trigger after the replacement committed changes nothing.
      const durable = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
      if (durable?.payloadHash !== refusedHash || durable.truthState !== 'failed') return undefined;
      return sealQueuedTerminal(undefined, ownerIdentity, failure);
    }, refusedHash);
  };

  // #826: an inbound envelope above the journal record bound is never stored
  // or run, and it must not hold the cursor. An offer is declined once,
  // non-retryably, from a journal record kept without its bytes. Any other
  // envelope is dropped; for a task.cancel, the local task runs until it ends.
  const refuseOverBoundEnvelope = async (envelope: Envelope, record: ReceivedEnvelopeRecord, byteLength: number): Promise<void> => {
    const taskId = envelope.task_id;
    if (envelope.type !== 'task.offer' || taskId === undefined) {
      console.warn(`[byok/client] dropped inbound ${envelope.type} (seq=${record.seq}): ${byteLength} bytes is over the journal record bound`);
      return;
    }
    const { agentRef } = envelope.payload as { agentRef?: AgentRef };
    // A sealed offer this device cannot hold is one it cannot open; a device
    // with no keyring declines every sealed offer for want of a key. The
    // closed code is a value gate on the server's `sealed-payload-v1`.
    const code = sealedRun.sealedMember === undefined ? 'sealed_key_unavailable' : 'sealed_open_failed';
    const serverCapabilities = daemonState.connection?.getServerCapabilities() ?? [];
    const closedCode = isSealedPayload(envelope.type, envelope.payload)
      && requiredReceiverCapabilities('task.decline', { reason: code, code }).every((flag) => serverCapabilities.includes(flag));
    const decline = createEnvelope('task.decline', {
      ...(closedCode ? { reason: code, code } : { reason: 'inbound_envelope_too_large' }),
      retryable: false, ...(agentRef === undefined ? {} : { agentRef }),
    }, { taskId });
    const bytes = encodeEnvelope(decline);
    const receipt = await activeJournal.appendWithheldOffer({
      identity: journalIdentity, envelopeId: record.envelopeId, taskId, seq: record.seq, bytesHash: record.bytesHash,
      byteLength, receivedAt: record.receivedAt, decline: { bytes, payloadHash: journalHash(bytes) },
    });
    // The decline is already durable. A new receipt sends it; a redelivery
    // retries a send still in flight (startup replays any other pending one).
    if (receipt.created) sendEnvelope(decline);
    else if (terminalCommits.hasPending(taskId)) await terminalCommits.retry(taskId);
    await terminalCommits.receipt(taskId);
  };

  // Serialize the marker/acceptance handshake across inbound dispositions
  // and turn_end. Acceptance evidence precedes deletion of the exact draft.
  let resultReplyTransitionTail: Promise<void> = Promise.resolve();
  const withReplyTransition = (write: () => Promise<void>): Promise<void> => {
    const operation = resultReplyTransitionTail.then(write);
    resultReplyTransitionTail = operation.catch(() => {});
    return operation;
  };
  const recordReplyState = (taskId: string, failure?: import('../result-reply-failure').ResultReplyFailure): Promise<void> => {
    return withReplyTransition(async () => {
      const task = await activeJournal.readTask(taskId, journalIdentity);
      if (!task || task.localState.startsWith('terminal:')) return;
      const priorFailure = resultReplyFailureFromState(task.localState);
      const accepted = failure === undefined || task.localState === 'required-reply-accepted' || task.localState.endsWith('-accepted');
      const kind = failure ?? priorFailure;
      const state = kind === undefined ? 'required-reply-accepted' : `${kind}${accepted ? '-accepted' : ''}`;
      await activeJournal.recordTransition({ transitionId: `result-reply:${taskId}:${state}`, taskId,
        to: state, occurredAt: new Date().toISOString() });
    });
  };
  return {
    sendEnvelope, replaceRefusedTerminal, refuseOverBoundEnvelope, withReplyTransition,
    recordReplyState,
  };
}

export type StartTerminals = ReturnType<typeof composeStartTerminals>;
