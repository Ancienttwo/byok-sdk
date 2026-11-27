import { acquireDaemonOwner, DaemonOwnerActiveError } from '../../util/daemon-owner.js';
import { DaemonHaltError } from '../daemon-lifecycle.js';
import { installationHoldsStart } from '../../util/service-installation-record.js';
import { AuthRequestAbortedError } from '../auth-manager.js';
import { DeviceCredentialCommandAbortedError } from '../device-credential-store.js';
import path from 'node:path';
import { HARNESS_SERVICE_TIER_CAPABILITY, INPUT_IMAGES_CAPABILITY } from '@byok-sdk/protocol/constants';
import { TaskRunner } from '../task-runner.js';
import type { DaemonScope } from './scope.js';
import { openStartRun } from './start-run.js';
import { composeStartLanes } from './start-lanes.js';
import { composeStartTerminals } from './start-terminals.js';
import { composeStartRunnerDeps } from './start-runner.js';
import { composeStartEnvelopes } from './start-envelopes.js';
import { createStartConnection } from './start-connection.js';
import { detectRuntimes } from './support.js';
import { abortableSleep } from '../../util/timer-delay.js';

const HARNESS_SCAN_INTERVAL_MS = 60_000;

async function refreshHarnessInventory(scope: DaemonScope, signal: AbortSignal): Promise<void> {
  const { adapters, config, daemonState } = scope;
  const connection = daemonState.connection!;
  while (!signal.aborted) {
    await abortableSleep(HARNESS_SCAN_INTERVAL_MS, signal);
    if (signal.aborted) return;
    try {
      const scan = await detectRuntimes(adapters, config.runtimeAllowlist, signal);
      if (signal.aborted) return;
      const previous = new Map(daemonState.runtimeObservations.map(observation => [observation.id, observation]));
      daemonState.runtimeObservations = scan.observations.map(observation => {
        const prior = previous.get(observation.id);
        const versionChange = prior?.version === observation.version ? prior?.versionChange : undefined;
        return Object.freeze({ ...observation, ...(versionChange === undefined ? {} : { versionChange }) });
      });
      daemonState.detectedHarnessFacts = scan.harnesses;
      daemonState.detectedRuntimeUnavailable = scan.runtimeUnavailable;
      const imagesChanged = scope.setHelloCapability(INPUT_IMAGES_CAPABILITY, scan.harnesses.some(({ capabilities }) => capabilities.images !== false));
      const tierChanged = scope.setHelloCapability(HARNESS_SERVICE_TIER_CAPABILITY, scan.harnesses.some(({ capabilities }) => capabilities.serviceTier === true));
      const inventoryChanged = connection.updateHarnessInventory(scan.harnesses, scan.runtimeUnavailable);
      if ((imagesChanged || tierChanged) && !inventoryChanged) connection.refreshHello();
    } catch {
      if (!signal.aborted) console.warn('[byok/client] executor inventory scan failed');
    }
  }
}

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
    if (requestEpoch !== daemonState.authCancellationEpoch) throw new AuthRequestAbortedError('stopped');
    daemonState.shuttingDown = false;
  // An installation mid-restore owns the stores even after its installer died (#2011).
  if (await installationHoldsStart(storeDir)) throw new DaemonHaltError('store_owned');
  const run = await openStartRun(daemonScope, requestEpoch);
  if (run === undefined) return;
  const {
    record, activeJournal, activePressureEngine, journalIdentity, resultReplyRecoveryTasks,
    sealedRun, recordRecoveryFailure, harnesses, runtimeUnavailable, blobClient, agentMemoryBackend, agentMemoryIntentBackend,
  } = run;
  const {
    capabilities, agentHomeProjectionCompletion, processProviderProvisioningNotice,
    processAgentMemoryIntentNotice, handleRemoteInputPreparation, opened,
  } = composeStartLanes(daemonScope, { agentMemoryBackend, agentMemoryIntentBackend, record, blobClient, sealedRun, harnesses });

  const {
    sendEnvelope, replaceRefusedTerminal, refuseOverBoundEnvelope, withReplyTransition,
    recordReplyState, awaitClaimSettlement, settleClaim,
  } = composeStartTerminals(daemonScope, { sealedRun, activeJournal, journalIdentity, opened, record });
  const { deps } = composeStartRunnerDeps(daemonScope, {
    capabilities,
    record, sendEnvelope, awaitClaimSettlement, withReplyTransition, activeJournal, journalIdentity, recordReplyState,
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
    record, capabilities, harnesses, runtimeUnavailable, handleAgentHomeProjectionEnvelope,
    handleAgentInputPreparationEnvelope, handleProviderProvisioningEnvelope,
    handleAgentMemoryIntentEnvelope, handleE2eeKeyPackageEnvelope, handleAgentEgressEnvelope,
    handleAgentContentReadEnvelope, activePressureEngine, journalIdentity, activeJournal,
    refuseOverBoundEnvelope, resultReplyRecoveryTasks, sendEnvelope, opened, replayRecoveryTerminals,
    replaceRefusedTerminal, sealedRun, settleClaim,
  });
  await replayRecoveryTerminals();
  startPresenceProducer();
  // Before the connection, so a key package notice in the first poll waits for the resume.
  startDeviceMember(record);
  await daemonState.connection.start();
  void refreshHarnessInventory(daemonScope, daemonState.blobLifecycleAbort!.signal);
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
      halted({ reason: haltReason });
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
