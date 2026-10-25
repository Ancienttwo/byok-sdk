import { resultReplyFailureFromState, resultReplyFailureReason } from '../result-reply-failure';
import { decodeEnvelope } from '@byok-sdk/protocol';
import type { AgentRef } from '../../agent-home';
import { assertJournalEnvelopeProtocol } from '../daemon-errors';
import { terminalKindOf, hasExactContentReadTransfer, policyRevisionMismatchPolicies } from './support';
import type { Envelope } from '@byok-sdk/protocol';
import { processE2eeKeyPackageNotice } from '../e2ee-key-package-notice';
import { type AgentContentSessionIdentity, AgentContentReadPolicyEngine, AGENT_CONTENT_READ_CAPABILITIES } from '../agent-content-read';
import { AgentContentAuditStore } from '../agent-content-audit-store';
import type { AgentContentReceiptWithoutReliableIdentity } from '../agent-egress-spool';
import type { DaemonScope } from './scope';
import type { StartRun } from './start-run';
import type { StartLanes } from './start-lanes';
import type { StartTerminals } from './start-terminals';

/**
 * The fifth stage of `runStartUnderLease` (#926), synchronous: builds the
 * recovery-terminal replay and the handlers for the Agent home projection,
 * input preparation, memory intent, provider provisioning, E2EE key package,
 * egress and content-read envelopes.
 */
export function composeStartEnvelopes(daemonScope: DaemonScope, run: Pick<StartRun & StartLanes & StartTerminals, 'resultReplyRecoveryTasks' | 'activeJournal' | 'journalIdentity' | 'recordRecoveryFailure' | 'replaceRefusedTerminal' | 'agentHomeProjectionCompletion' | 'handleRemoteInputPreparation' | 'processAgentMemoryIntentNotice' | 'processProviderProvisioningNotice' | 'record' | 'capabilities' | 'blobClient'>) {
  const {
    daemonState, terminalCommits, overrides, observer, agentHomeManager, memberStatus, logMember,
    config, agentSessionHandoffs, egressPolicy, agentContentReadPolicies, dispatchReliableRecord,
  } = daemonScope;
  const {
    resultReplyRecoveryTasks, activeJournal, journalIdentity, recordRecoveryFailure,
    replaceRefusedTerminal, agentHomeProjectionCompletion, handleRemoteInputPreparation,
    processAgentMemoryIntentNotice, processProviderProvisioningNotice, record, capabilities,
    blobClient,
  } = run;
  // Both prerequisites survive process death in their existing authorities:
  // immutable terminal bytes in the journal and exact disposition in the outbox.
  // Queueing the message first is insufficient: a failed POST must not let the
  // terminal close cloud admission while its message is still pending.
  const replayRecoveryTerminals = async (taskId?: string): Promise<void> => {
    for (const id of resultReplyRecoveryTasks.keys()) {
      if (taskId !== undefined && taskId !== id) continue;
      const task = await activeJournal.readTask(id, journalIdentity);
      const failure = task && resultReplyFailureFromState(task.localState);
      if (!task || !failure || !('envelopeBytes' in task)) { resultReplyRecoveryTasks.delete(id); continue; }
      const state = daemonState.runner?.recoveredAgentMessageState(id);
      const accepted = task.localState.endsWith('-accepted');
      if (!accepted && state !== 'refused') continue;
      const offer = decodeEnvelope(task.envelopeBytes);
      const payload = offer.payload as { agentRef?: AgentRef; terminalProjection: { contract: string } };
      const reason = accepted ? resultReplyFailureReason(failure, payload.terminalProjection.contract) : 'required Agent message was refused';
      await recordRecoveryFailure(task, reason);
      resultReplyRecoveryTasks.delete(id);
    }
    for (const terminal of await activeJournal.listPendingTerminals(journalIdentity)) {
      if (taskId !== undefined && terminal.taskId !== taskId) continue;
      // A refusal recorded before its replacement committed (#654 §77b).
      if (terminal.truthState === 'failed' && !terminalCommits.hasPending(terminal.taskId)) replaceRefusedTerminal(decodeEnvelope(terminal.bytes));
      if (terminal.truthState !== 'pending') continue;
      if (daemonState.runner?.hasPendingRecoveredAgentMessage(terminal.taskId)) continue;
      assertJournalEnvelopeProtocol(terminal.bytes, terminal.taskId, 'pending-terminal');
      const envelope = decodeEnvelope(terminal.bytes);
      if (envelope.task_id !== terminal.taskId || terminalKindOf(envelope.type) !== terminal.terminalType) {
        throw new Error('durable terminal execution binding mismatch');
      }
      overrides.executionRecoveryFault?.('terminal:before-send');
      observer.captureOutboundApproval(envelope);
      daemonState.connection?.send(envelope);
    }
  };

  const handleAgentHomeProjectionEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.home.projection') return false;
    if (agentHomeManager === undefined || agentHomeProjectionCompletion === undefined) {
      // A sender cannot turn a missing local consumer into a successful
      // no-op. Throwing retains the mailbox row/cursor for operator repair.
      throw new Error('task-free Agent-home projection is not configured on this daemon');
    }
    const outcome = await agentHomeManager.project(envelope.payload);
    await agentHomeProjectionCompletion.complete({
      requestId: envelope.payload.requestId,
      agentRef: envelope.payload.agentRef,
      projectionHash: envelope.payload.projectionHash,
      outcome,
    });
    return true;
  };
  const handleAgentInputPreparationEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.input.preparation') return false;
    // Resolves once the completion is durably recorded by the cloud. Anything
    // that prevents that recording throws, so the cursor stays put and the
    // row is redelivered — a redelivery reads the immutable cloud completion
    // before local readiness/deadline checks or a second compile/count.
    await handleRemoteInputPreparation(envelope.payload);
    return true;
  };
  const handleAgentMemoryIntentEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.memory.intent.available') return false;
    // Task-free and never journaled, like provisioning: resolves only after
    // the Host readback matched a durable terminal and the `ackedAt`
    // barrier succeeded. Any throw keeps the row and the cursor.
    await processAgentMemoryIntentNotice(envelope.payload);
    return true;
  };
  const handleProviderProvisioningEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'provider.provisioning.available') return false;
    // Task-free and never journaled: it is consumed here, ahead of the
    // journal append below, and resolves only on a durable terminal
    // readback. Any throw keeps the row and the cursor for redelivery.
    await processProviderProvisioningNotice(envelope.payload);
    return true;
  };
  const handleE2eeKeyPackageEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'e2ee.key_package.available') return false;
    // Task-free and never journaled, like provisioning. It throws only while
    // the member resumes or when a Host read fails or times out, which keeps
    // the row; a final Host answer is acknowledged.
    await processE2eeKeyPackageNotice(envelope.payload, memberStatus(), logMember);
    return true;
  };
  const handleAgentEgressEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.egress.ack') return false;
    if (config.agentEgress === undefined) return true;
    await daemonState.agentEgress.acknowledge({ ...envelope.payload, tenantId: record.tenantId });
    return true;
  };
  const handleAgentContentReadEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.content.read') return false;
    // This build could not have advertised a content-read capability without
    // both authorities. A stale or malicious sender gets no implicit local
    // path, tenant, or receipt synthesized from incomplete identity.
    if (config.agentEgress === undefined || agentHomeManager === undefined || agentSessionHandoffs === undefined) {
      return true;
    }

    const payload = envelope.payload;
    const session: AgentContentSessionIdentity = Object.freeze({
      agentRef: payload.agentRef,
      sessionRef: payload.sessionRef,
      runtimeId: payload.runtime,
      cwd: payload.cwd,
    });
    const canonicalHome = (await agentHomeManager.layout.resolve(payload.agentRef)).canonicalHome;
    const exactWirePolicy =
      payload.policyRevision === egressPolicy.policyRevision &&
      hasExactContentReadTransfer(egressPolicy.transfers[payload.surface], payload.policy);
    const policies = exactWirePolicy
      ? agentContentReadPolicies
      : policyRevisionMismatchPolicies(agentContentReadPolicies, payload.surface);
    const policyEngine = new AgentContentReadPolicyEngine({
      agentHomeLayout: agentHomeManager.layout,
      policies,
      capabilities,
      ...(config.agentEgress.contentRead?.runtimeAllowlistedRoots === undefined
        ? {}
        : { runtimeAllowlistedRoots: config.agentEgress.contentRead.runtimeAllowlistedRoots }),
      // `requireMatch` is the only session authority for every surface. A
      // wire cwd must be the exact canonical Agent home before any bytes can
      // be read; there is no workspace/artifact exception.
      resolveSessionIdentity: async (request) => {
        const requestedSession = request.session;
        if (requestedSession === undefined) return undefined;
        if (requestedSession.cwd !== canonicalHome) return undefined;
        const handoff = await agentSessionHandoffs.requireMatch({
          agentRef: request.agentRef,
          sessionRef: requestedSession.sessionRef,
          runtimeId: requestedSession.runtimeId,
          cwd: requestedSession.cwd,
        });
        if (handoff.cwd !== canonicalHome) return undefined;
        return Object.freeze({
          agentRef: handoff.agentRef,
          sessionRef: handoff.sessionRef,
          runtimeId: handoff.runtimeId,
          cwd: handoff.cwd,
        });
      },
      // This factory derives the SDK-owned address solely from the canonical
      // AgentHomeLayout resolution and shares its writer queue with every
      // same-Agent envelope in this daemon process.
      auditStore: AgentContentAuditStore.forCanonicalAgentHome(canonicalHome),
    });
    const result = await policyEngine.read({
      requestId: payload.requestId,
      actor: payload.actor,
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      agentRef: payload.agentRef,
      surface: payload.surface,
      relativeTarget: payload.target,
      mimeType: payload.mimeType,
      capability: AGENT_CONTENT_READ_CAPABILITIES[payload.surface],
      policyRevision: payload.policyRevision,
      maxBytes: payload.policy.maxBytes,
      allowedMimeTypes: payload.policy.allowedMimeTypes,
      decodeAs: payload.decodeAs,
      session,
    });

    const receipt = {
      requestId: payload.requestId,
      surface: payload.surface,
      actor: payload.actor,
      agentRef: payload.agentRef,
      sessionRef: payload.sessionRef,
      runtime: payload.runtime,
      cwd: payload.cwd,
      policyRevision: payload.policyRevision,
      target: payload.target,
      mimeType: payload.mimeType,
      decodeAs: payload.decodeAs,
    } as const;
    const appendAndDispatchContentReceipt = async (
      contentReceipt: AgentContentReceiptWithoutReliableIdentity,
    ): Promise<void> => {
      const appended = await daemonState.agentEgress.appendContentReceipt({
        homeDir: canonicalHome,
        agentRef: payload.agentRef,
        payload: contentReceipt,
      });
      if (!appended.ok) {
        // Throwing keeps the inbound request unacknowledged, so the server
        // redelivers rather than treating a non-durable content decision as
        // complete or silently moving it to latest-value activity.
        throw new Error(`content receipt could not enter reliable spool: ${appended.reason}`);
      }
      dispatchReliableRecord(appended.record);
    };
    if (result.decision === 'deny') {
      await appendAndDispatchContentReceipt({
        ...receipt,
        decision: 'denied',
        byteCount: 0,
        reason: result.reason,
      });
      return true;
    }

    // A committed audit receipt plus this requestId-stable blob reservation
    // makes a crash/redelivery retry the same upload rather than minting a
    // second cloud object.
    const blobRef = await blobClient.uploadArtifact(result.content, payload.mimeType, {
      idempotencyKey: payload.requestId,
    });
    await appendAndDispatchContentReceipt({
      ...receipt,
      decision: 'allowed',
      byteCount: result.byteCount,
      contentHash: `sha256:${result.contentHash}`,
      blobRef,
    });
    return true;
  };
  return {
    replayRecoveryTerminals, handleAgentHomeProjectionEnvelope, handleAgentInputPreparationEnvelope,
    handleAgentMemoryIntentEnvelope, handleProviderProvisioningEnvelope,
    handleE2eeKeyPackageEnvelope, handleAgentEgressEnvelope, handleAgentContentReadEnvelope,
  };
}

export type StartEnvelopes = ReturnType<typeof composeStartEnvelopes>;
