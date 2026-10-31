import { acquireDaemonOwner, DaemonOwnerActiveError } from '../../util/daemon-owner';
import { DaemonHaltError } from '../daemon-lifecycle';
import { AuthRequestAbortedError } from '../auth-manager';
import { DeviceCredentialCommandAbortedError } from '../device-credential-store';
import path from 'node:path';
import { TaskRunner } from '../task-runner';
import type { DaemonScope } from './scope';
import { openStartRun } from './start-run';
import { composeStartLanes } from './start-lanes';
import { composeStartTerminals } from './start-terminals';
import { composeStartRunnerDeps } from './start-runner';
import { composeStartEnvelopes } from './start-envelopes';
import { createStartConnection } from './start-connection';

/** One daemon start under the owner lease (#926). */

export async function runStartUnderLease(daemonScope: DaemonScope, requestEpoch: number): Promise<void> {
  const {
    terminalCommits, daemonState, setLifecycle, storeDir, config, startPresenceProducer,
    startDeviceMember, startupHaltReason, operationalHealth, halted, runShutdownSequence,
  } = daemonScope;
  terminalCommits.resume();
  // A new run begins; a previous run's halt or crash no longer describes it.
  if (daemonState.lifecycle.phase === 'halted' || daemonState.lifecycle.phase === 'crashed') setLifecycle({ phase: 'stopped' });
  if (!daemonState.daemonOwnerLease) {
    try {
      daemonState.daemonOwnerLease = await acquireDaemonOwner(storeDir, 'daemon');
    } catch (err) {
      if (err instanceof DaemonOwnerActiveError) throw new DaemonHaltError('store_owned', { cause: err });
      throw err;
    }
  }
  try {
  const run = await openStartRun(daemonScope, requestEpoch);
  if (run === undefined) return;
  const {
    record, activeJournal, activePressureEngine, journalIdentity, resultReplyRecoveryTasks,
    sealedRun, recordRecoveryFailure, runtimes, harnesses, runtimeUnavailable, blobClient, agentMemoryIntentBackend,
  } = run;
  const {
    capabilities, agentHomeProjectionCompletion, processProviderProvisioningNotice,
    processAgentMemoryIntentNotice, handleRemoteInputPreparation, opened,
  } = composeStartLanes(daemonScope, { agentMemoryIntentBackend, record, blobClient, sealedRun });

  const {
    sendEnvelope, replaceRefusedTerminal, refuseOverBoundEnvelope, withReplyTransition,
    recordReplyState,
  } = composeStartTerminals(daemonScope, { sealedRun, activeJournal, journalIdentity, opened, record });
  const { deps } = composeStartRunnerDeps(daemonScope, {
    record, sendEnvelope, withReplyTransition, activeJournal, journalIdentity, recordReplyState,
    blobClient, opened, activePressureEngine,
  });
  daemonState.runner = new TaskRunner(deps);
  if (config.agentHome !== undefined && config.agentEgress !== undefined) {
    await daemonState.runner.recoverAgentMessageOutboxes(path.join(config.agentHome.hostStorageRoot, 'agents'), resultReplyRecoveryTasks,
      async taskId => (await activeJournal.readTask(taskId, journalIdentity))?.localState === 'terminal:cancelled');
  }
  const {
    replayRecoveryTerminals, handleAgentHomeProjectionEnvelope, handleAgentInputPreparationEnvelope,
    handleAgentMemoryIntentEnvelope, handleProviderProvisioningEnvelope,
    handleE2eeKeyPackageEnvelope, handleAgentEgressEnvelope, handleAgentContentReadEnvelope,
  } = composeStartEnvelopes(daemonScope, {
    resultReplyRecoveryTasks, activeJournal, journalIdentity, recordRecoveryFailure,
    replaceRefusedTerminal, agentHomeProjectionCompletion, handleRemoteInputPreparation,
    processAgentMemoryIntentNotice, processProviderProvisioningNotice, record, capabilities,
    blobClient,
  });

  daemonState.connection = createStartConnection(daemonScope, {
    record, capabilities, runtimes, harnesses, runtimeUnavailable, handleAgentHomeProjectionEnvelope,
    handleAgentInputPreparationEnvelope, handleProviderProvisioningEnvelope,
    handleAgentMemoryIntentEnvelope, handleE2eeKeyPackageEnvelope, handleAgentEgressEnvelope,
    handleAgentContentReadEnvelope, activePressureEngine, journalIdentity, activeJournal,
    refuseOverBoundEnvelope, resultReplyRecoveryTasks, sendEnvelope, opened, replayRecoveryTerminals,
    replaceRefusedTerminal, sealedRun,
  });
  await replayRecoveryTerminals();
  startPresenceProducer();
  // Before the connection, so a key package notice in the first poll waits for the resume.
  startDeviceMember(record);
  await daemonState.connection.start();
  daemonState.daemonStarted = true;
  } catch (err) {
    // A failed start opens no session: its teardown settles a queued
    // terminal as a stop does.
    daemonState.startInProgress = false;
    const haltReason = startupHaltReason(err);
    // stop() cancelled this start; an operator stop is not a crash.
    const cancelledByStop = daemonState.shuttingDown && (
      (err instanceof DeviceCredentialCommandAbortedError && err.reason === 'cancelled') ||
      (err instanceof AuthRequestAbortedError && err.reason === 'stopped'));
    if (haltReason === undefined) {
      // #394: a crash, the one start failure a restart may fix. Recorded so
      // that a crash loop degrades operational health.
      if (!cancelledByStop) {
        try {
          await operationalHealth.startRun();
          await operationalHealth.recordFailure('lifecycle');
        } catch (healthError) {
          console.warn(`[byok/client] failed to persist operational health: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
        }
      }
    } else if (haltReason !== 'store_owned') {
      halted(haltReason);
    }
    const thrown = haltReason === undefined || err instanceof DaemonHaltError ? err : new DaemonHaltError(haltReason, { cause: err });
    try {
      // startUnderLease already owns the process-local lifecycle slot. Run
      // teardown directly; queueing requestShutdown here would wait on this
      // operation itself and deadlock.
      await runShutdownSequence('startup failed', { drainTimeoutMs: 0 });
    } catch (cleanupError) {
      throw new AggregateError([thrown, cleanupError], 'daemon startup failed and teardown was incomplete');
    }
    throw thrown;
  }
}
