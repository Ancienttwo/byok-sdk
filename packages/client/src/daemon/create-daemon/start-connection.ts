import { ConnectionManager } from '../connection-manager';
import { toJournalEnvelopeRecord, terminalKindOf } from './support';
import { JournalRecordTooLargeError, journalHash } from '../journal/journal';
import { isTaskOfferType, createEnvelope, decodeEnvelope, encodeEnvelope, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY } from '@byok-sdk/protocol';
import { terminalIdentity } from '../terminal-identity';
import type { DaemonScope } from './scope';
import type { StartRun } from './start-run';
import type { StartLanes } from './start-lanes';
import type { StartTerminals } from './start-terminals';
import type { StartEnvelopes } from './start-envelopes';

/**
 * The last stage of `runStartUnderLease` (#926), synchronous: builds this
 * start's connection manager — its transport, settlement and inbound routing.
 */
export function createStartConnection(daemonScope: DaemonScope, run: Pick<StartRun & StartLanes & StartTerminals & StartEnvelopes, 'record' | 'capabilities' | 'runtimes' | 'harnesses' | 'handleAgentHomeProjectionEnvelope' | 'handleAgentInputPreparationEnvelope' | 'handleProviderProvisioningEnvelope' | 'handleAgentMemoryIntentEnvelope' | 'handleE2eeKeyPackageEnvelope' | 'handleAgentEgressEnvelope' | 'handleAgentContentReadEnvelope' | 'activePressureEngine' | 'journalIdentity' | 'activeJournal' | 'refuseOverBoundEnvelope' | 'resultReplyRecoveryTasks' | 'sendEnvelope' | 'opened' | 'replayRecoveryTerminals' | 'replaceRefusedTerminal' | 'sealedRun'>) {
  const {
    daemonState, config, localAgentRelease, toolsetRegistry, cursorStore, observer, terminalCommits,
    overrides, outbound, setLifecycle, runPresenceDiscovery, halted, crashed, dispatchReliableRecord,
    operationalHealth,
  } = daemonScope;
  const {
    record, capabilities, runtimes, harnesses, handleAgentHomeProjectionEnvelope,
    handleAgentInputPreparationEnvelope, handleProviderProvisioningEnvelope,
    handleAgentMemoryIntentEnvelope, handleE2eeKeyPackageEnvelope, handleAgentEgressEnvelope,
    handleAgentContentReadEnvelope, activePressureEngine, journalIdentity, activeJournal,
    refuseOverBoundEnvelope, resultReplyRecoveryTasks, sendEnvelope, opened, replayRecoveryTerminals,
    replaceRefusedTerminal, sealedRun,
  } = run;
  return new ConnectionManager({
    serverUrl: config.serverUrl,
    deviceId: record.deviceId,
    productId: config.productId,
    capabilities,
    clientVersion: localAgentRelease.version,
    runtimes,
    harnesses,
    getConfiguredToolsets: () => toolsetRegistry.snapshot().configuredToolsets,
    auth: daemonState.auth,
    cursorStore,
    // Finding F3: return (not void-and-forget) so ConnectionManager can
    // await this handler and only advance/persist its redelivery cursor
    // once it actually resolves — see connection-manager.ts's `process`.
    // M3-2a: also this file's own closure, unrelated to F3's redelivery
    // semantics above — `handleInboundEnvelope` only ever looks at
    // `task.offer` (the one event with no corresponding outbound envelope
    // of its own) and never throws, so it can't affect cursor advancement.
    // S3b (L-002): where "ack after durable commit" stops being a
    // discipline and becomes the only expressible behaviour.
    //
    // `ConnectionManager.process` advances (and persists) the redelivery
    // cursor ONLY when this handler resolves, and merely records a stall
    // when it throws (`connection-manager.ts`) — that was already true, and
    // is not changed by this slice. Putting the journal transaction INSIDE
    // this handler therefore makes the ordering structural: the cursor
    // cannot move past a seq whose envelope is not yet committed, because
    // the only thing that moves the cursor is this function resolving, and
    // this function does not resolve until the commit does. There is no
    // second path to the cursor to keep in step, and the transport is
    // untouched.
    //
    // Placed after the observer (which never throws and owns no durable
    // state) and before the runner, so the bytes are on disk before any
    // work is scheduled off them. A redelivered envelope is absorbed by the
    // journal's own receipt and costs one no-op transaction.
    onEnvelope: async (envelope) => {
      if (daemonState.tenantRebinding) {
        throw new Error('tenant enrollment is being re-paired; inbound work is blocked until restart');
      }
      observer.handleInboundEnvelope(envelope);
      if (await handleAgentHomeProjectionEnvelope(envelope)) return;
      if (await handleAgentInputPreparationEnvelope(envelope)) return;
      if (await handleProviderProvisioningEnvelope(envelope)) return;
      if (await handleAgentMemoryIntentEnvelope(envelope)) return;
      if (await handleE2eeKeyPackageEnvelope(envelope)) return;
      if (await handleAgentEgressEnvelope(envelope)) return;
      if (await handleAgentContentReadEnvelope(envelope)) return;
      // S3b (L-003): §12.7.2.1's `emergency` row — "fail-closed，不 ack
      // 新 mailbox row；保留现有 recovery evidence". Throwing HERE, ahead
      // of the append, reuses the ordering the journal branch already
      // established: the handler rejects, so the cursor does not move,
      // so the mailbox keeps the row and redelivers it later. The task
      // is not lost; it is left in the one place that still has room
      // for it. Nothing is deleted to make space.
      activePressureEngine?.assertAckCriticalAllowed();
      const record = toJournalEnvelopeRecord(envelope, journalIdentity);
      try {
        await activeJournal.appendEnvelope(record);
      } catch (error: unknown) {
        if (!(error instanceof JournalRecordTooLargeError)) throw error;
        await refuseOverBoundEnvelope(envelope, record, error.actualBytes);
        return;
      }
      if (isTaskOfferType(envelope.type) && envelope.task_id !== undefined) {
        // A selected terminal fences admission even if its transaction rolled
        // back to received. Check before reading a possibly stale task row.
        if (terminalCommits.hasPending(envelope.task_id)) {
          await terminalCommits.retry(envelope.task_id);
          return;
        }
        const task = await activeJournal.readTask(envelope.task_id, journalIdentity);
        if (!task) throw new Error('durable offer has no execution record');
        if (task.localState !== 'received') {
          await terminalCommits.retry(envelope.task_id);
          return;
        }
      }
      if (envelope.type === 'task.cancel' && envelope.task_id !== undefined && resultReplyRecoveryTasks.has(envelope.task_id)) {
        const taskId = envelope.task_id;
        const binding = resultReplyRecoveryTasks.get(taskId)!;
        await daemonState.runner!.cancelRecoveredAgentMessage(taskId, async () => {
          // Without its offer the cancel cannot tell a sealed task: it is never sent.
          const task = await activeJournal.readTask(taskId, journalIdentity);
          if (!task || !('envelopeBytes' in task)) throw new Error(`missing durable offer of recovered task ${taskId}`);
          const cancelled = createEnvelope('task.cancelled', { reason: envelope.payload.reason,
            ...terminalIdentity(task.claimedRuntime, binding.agentRef) }, { taskId });
          sendEnvelope(await opened.sealRecovered(decodeEnvelope(task.envelopeBytes), cancelled));
          await terminalCommits.receipt(taskId);
        });
        resultReplyRecoveryTasks.delete(taskId);
      } else await daemonState.runner?.handleEnvelope(envelope);
      if (envelope.type === 'agent.message.disposition') {
        // handleEnvelope fsyncs only an exact disposition before this
        // gate opens. A crash before sending leaves the journal pending.
        await replayRecoveryTerminals(envelope.task_id);
      }
      // In particular, a pre-claim decline must be durable before ack.
      if (envelope.task_id !== undefined) await terminalCommits.receipt(envelope.task_id);
    },
    onOutboundQueued: (envelope) => {
      if (terminalKindOf(envelope.type) !== undefined) overrides.executionRecoveryFault?.('terminal:queued');
    },
    beforeOutboundPost: (envelopes) => {
      if (envelopes.some((envelope) => terminalKindOf(envelope.type) !== undefined)) overrides.executionRecoveryFault?.('outbound:before-post');
    },
    onOutboundSettled: async (settlements) => {
      // All terminal fsyncs must succeed before publishing any observation.
      // A retry after a partial local write can repeat the idempotent journal
      // operation, without double-counting an earlier part of this batch.
      for (const settlement of settlements) {
        const { envelope } = settlement;
        if (terminalKindOf(envelope.type) === undefined || envelope.task_id === undefined) continue;
        const hash = journalHash(encodeEnvelope(envelope));
        if (settlement.outcome === 'rejected') {
          await activeJournal.rejectTerminal(envelope.task_id, hash, settlement.reason);
          replaceRefusedTerminal(envelope);
        } else {
          overrides.executionRecoveryFault?.('outbound:after-ack');
          await activeJournal.confirmTerminal(envelope.task_id, hash);
        }
      }
      for (const settlement of settlements) {
        const { envelope } = settlement;
        outbound[settlement.outcome] += 1;
        if (settlement.outcome !== 'rejected') { observer.handleOutboundEnvelope(sealedRun.sealedTasks?.plainOf(envelope) ?? envelope); continue; }
        const rejection = {
          envelopeId: envelope.id, type: envelope.type,
          ...(envelope.task_id === undefined ? {} : { taskId: envelope.task_id }),
          reason: settlement.reason, terminal: terminalKindOf(envelope.type) !== undefined,
        };
        outbound.rejectedByReason[rejection.reason] = (outbound.rejectedByReason[rejection.reason] ?? 0) + 1;
        if (rejection.terminal) outbound.rejectedTerminals += 1;
        outbound.lastRejection = rejection;
        observer.noteOutboundRejected(sealedRun.sealedTasks?.plainOf(envelope) ?? envelope, rejection);
      }
    },
    onStateChange: (state) => {
      setLifecycle({ phase: 'running', connection: state });
      // Discovery is armed before the first connection can deliver offers.
      // Every open replaces the read, so rollout/reconnect facts cannot be
      // borrowed from a previous connection generation.
      if (state === 'open') {
        daemonState.runner?.retryRecoveredAgentMessages();
        runPresenceDiscovery();
      }
    },
    onHalted: (reason) => halted(reason),
    onCrashed: () => crashed(),
    // Reliable records held for `capability_missing` go out as soon as an
    // advertisement carries the ack capability — on every reconnect, not
    // only at start.
    onCapabilitiesAdvertised: (added) => {
      if (!added.includes(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY) || daemonState.connection === undefined) return;
      for (const record of daemonState.agentEgress.retryableReliableRecords(daemonState.connection.getServerCapabilities())) {
        dispatchReliableRecord(record);
      }
    },
    longPollRetryDelayMs: overrides.longPoll?.retryDelayMs,
    longPollIdleDelayMs: overrides.longPoll?.idleDelayMs,
    fleetJitter: daemonState.fleetJitter,
    onOperationalOutcome: (outcome, source) => {
      const write = outcome === 'success'
        ? operationalHealth.recordSuccess(source)
        : operationalHealth.recordFailure(source);
      void write.catch((err: unknown) => {
        console.warn(`[byok/client] failed to persist operational health: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  });
}
