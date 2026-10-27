import { attachOwnedProcessGroupLedger } from '../../adapters/process-tree';
import { InputPreparationUnsupportedRecordVersionError } from '../input-preparation-store';
import type { DeviceRecord } from '../store';
import { DaemonHaltError } from '../daemon-lifecycle';
import { AgentEgressController } from '../agent-egress-controller';
import path from 'node:path';
import { createFleetJitter } from '../deterministic-jitter';
import { type JournalIdentity, journalHash } from '../journal/journal';
import type { AgentRef } from '../../agent-home';
import type { SealedRunState } from './state';
import { decodeEnvelope, createEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { taskFailureField, DAEMON_TASK_FAILURE } from '../task-failure';
import { terminalIdentity } from '../terminal-identity';
import { assertJournalEnvelopeProtocol } from '../daemon-errors';
import { resultReplyFailureFromState } from '../result-reply-failure';
import { serviceEnvironmentStatus } from '../../lifecycle/service-environment';
import { detectRuntimes } from './support';
import { BlobClient } from '../blob-client';
import type { DaemonScope } from './scope';

/**
 * The first stage of `runStartUnderLease` (#926), under the owner lease:
 * reaps owned process groups left by a killed daemon, opens scratch and hosted
 * storage, loads the device record, binds egress, runs startup recovery and
 * the first retention pass, starts the control server, resolves the service
 * environment and detects runtimes. It ends at its own last `await`.
 */
export async function openStartRun(daemonScope: DaemonScope) {
  const {
    ownedProcessLedger, scratchRoot, storeDir, daemonState, initializeInputPreparation, config,
    retentionSweeper, replaceControlServer, setLifecycle, initializeOwnedHostedStorage,
    storagePressure, egressPolicy, agentHomeManager, cursorStore, terminalCommits, operationalHealth,
    observer, adapters, provenAgentMemoryIntentBackend,
  } = daemonScope;
  // #384 item 3 / #393: on POSIX a SIGKILLed or OOM-killed daemon leaves its
  // owned runtime groups running, and a tool process in one could still be
  // writing the Agent home or Git workspace a recovered task is handed back
  // for. With the owner lease held, every ledger record is such a residue:
  // end it before anything else here — before `daemon_interrupted` is
  // recorded, before admission, and so before any Agent home lease marker is
  // reclaimed as crash residue — and refuse to start while one survives.
  // Only then does this run's own ledger begin. win32 records none: its job
  // object already ended them.
  const reconciliation = await ownedProcessLedger.reconcile();
  if (reconciliation.recorded > 0) {
    console.warn(
      `[byok/client] previous daemon run left owned runtime process groups: recorded=${reconciliation.recorded} found=${reconciliation.found} terminated=${reconciliation.terminated} survived=${reconciliation.survived} liveWriter=${reconciliation.liveWriter}`,
    );
  }
  await scratchRoot.open(storeDir);
  daemonState.detachOwnedProcessGroupLedger?.();
  daemonState.detachOwnedProcessGroupLedger = attachOwnedProcessGroupLedger(ownedProcessLedger);
  // Initialization is one instance promise, including refusal. Even the
  // enrollment-only control endpoint must not expose a half-initialized service.
  await initializeInputPreparation();
  // Retention is owned by daemon lifecycle, including idle restarts. Open
  // only under the store lease and before exposing any control endpoint.
  //
  // A record log written in an older record schema version turns THIS LANE
  // off, not the daemon: the refusal stays fail-closed (no record is read
  // forward, migrated or deleted) but it is scoped to input preparation, so
  // ordinary tasks keep running while the operator archives the log. Every
  // other open failure still fails startup, exactly as before.
  try {
    await daemonState.inputPreparationService?.open();
  } catch (error) {
    if (!(error instanceof InputPreparationUnsupportedRecordVersionError)) throw error;
    daemonState.inputPreparationLaneOff = { code: 'input_preparation_record_log_unsupported', message: error.message };
    daemonState.inputPreparationService = undefined;
    console.error(`[byok/client] input preparation is disabled on this daemon: ${error.message}`);
  }
  // Only the explicitly enabled service-enrollment path resolves credential
  // custody before hosted storage. A WinSW service has a different Windows
  // logon token from the operator CLI, so an unpaired service must be able to
  // bind the authenticated local control endpoint without first opening any
  // hosted writer. Default daemon startup preserves the established ordering
  // below: acquire the lease, initialize hosted storage, then load identity.
  let record: DeviceRecord | undefined;
  if (config.serviceEnrollment?.enabled === true) {
    record = await daemonState.auth.loadExisting();
    if (!record) {
      daemonState.startedAt = Date.now();
      daemonState.serviceEnrollmentWaiting = true;
      daemonState.serviceEnrollmentTransitioning = false;
      await retentionSweeper.runPass('startup');
      retentionSweeper.start();
      await replaceControlServer(true, true);
      setLifecycle({ phase: 'awaiting-enrollment' });
      return;
    }
  }
  daemonState.serviceEnrollmentWaiting = false;
  daemonState.serviceEnrollmentTransitioning = false;
  // This is the first point at which daemon-owned hosted storage may touch
  // the filesystem. The lease was acquired above, so SQLite open/schema/
  // quarantine and every pressure-engine writer are inside the same
  // authority boundary as auth renewal and the rest of daemon lifecycle.
  const activeJournal = initializeOwnedHostedStorage();
  record ??= await daemonState.auth.loadExisting();
  if (!record) {
    throw new DaemonHaltError('unpaired');
  }
  const activePressureEngine = storagePressure;
  daemonState.retentionIdentity = { tenantId: record.tenantId, productId: config.productId, deviceId: record.deviceId };
  // Loading an existing record arms proactive token renewal, whose final
  // step writes device.json. Acquire the store mutation lease first so a
  // rejected second daemon can never leave that timer behind as a writer.
  if (config.agentEgress !== undefined) {
    daemonState.agentEgress = new AgentEgressController({
      policy: egressPolicy,
      tenantId: record.tenantId,
    });
  }
  // Capability publication happens only after this SDK-owned preflight has
  // proved the canonical root/agents namespace can be materialized and
  // mutated. A configured-but-unusable root must never admit cloud work.
  await agentHomeManager?.preflight();
  if (config.agentEgress !== undefined && config.agentHome !== undefined) {
    await daemonState.agentEgress.recover(path.join(config.agentHome.hostStorageRoot, 'agents'));
  }
  daemonState.fleetJitter = createFleetJitter(config.productId, record.deviceId);

  const journalIdentity: JournalIdentity = { tenantId: record.tenantId, productId: config.productId, deviceId: record.deviceId };
  const resultReplyRecoveryTasks = new Map<string, { agentRef: AgentRef; contract: string }>();
  const sealedRun: SealedRunState = { sealedTasks: undefined, sealedMember: undefined, ownSealIdentity: undefined };
  const recordRecoveryFailure = async (task: import('../journal/journal').RecoverableTask, reason: string, interrupted = false) => {
    const offer = decodeEnvelope(task.envelopeBytes);
    const { agentRef } = offer.payload as { agentRef?: AgentRef };
    const failure = createEnvelope('task.fail', { reason, retryable: false,
      ...taskFailureField(DAEMON_TASK_FAILURE, daemonState.connection?.getServerCapabilities() ?? []),
      ...terminalIdentity(task.claimedRuntime, agentRef),
      ...(interrupted ? { recovery: { kind: 'daemon_interrupted' as const, offerId: offer.id } } : {}),
    }, { taskId: task.taskId });
    const envelope = sealedRun.sealedTasks === undefined ? failure : await sealedRun.sealedTasks.sealRecovered(offer, failure);
    const bytes = encodeEnvelope(envelope);
    await activeJournal.recordTerminal({ taskId: task.taskId, terminalType: 'failed', bytes, payloadHash: journalHash(bytes),
      truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString(),
      recovery: { disposition: interrupted ? 'interrupted' : 'abandoned', reason } });
  };
  const durableCursor = await cursorStore.load(config.serverUrl, record.deviceId) ?? 0;
  const recoveryTasks = await activeJournal.listRecoveryTasks(journalIdentity);
  // Scan every stored envelope before acting on any: a row of another
  // wire major stops startup with no journal row written, rewritten or
  // deleted (no daemon_interrupted terminal for a v2 offer, no replay).
  for (const task of recoveryTasks) assertJournalEnvelopeProtocol(task.envelopeBytes, task.taskId, 'recovery-offer');
  for (const terminal of await activeJournal.listPendingTerminals(journalIdentity)) {
    assertJournalEnvelopeProtocol(terminal.bytes, terminal.taskId, 'pending-terminal');
  }
  for (const task of recoveryTasks) {
    // No execution commitment and no local ack: let the authoritative cloud
    // mailbox redeliver (or suppress a cancelled offer). Never replay a cached
    // offer independently of cancellation/placement authority.
    if (task.localState === 'received' && task.seq > durableCursor) continue;
    const offer = decodeEnvelope(task.envelopeBytes);
    if (offer.type !== 'task.offer' || offer.task_id !== task.taskId) throw new Error('invalid durable recovery offer binding');
    const payload = offer.payload as { agentRef?: AgentRef; messageEgress?: { mode: string; contract?: string }; terminalProjection?: { mode: string; contract?: string } };
    const resultFailure = resultReplyFailureFromState(task.localState);
    if (resultFailure && (payload.agentRef === undefined || payload.messageEgress?.mode !== 'required' || typeof payload.messageEgress.contract !== 'string'
      || payload.terminalProjection?.mode !== 'result-document' || typeof payload.terminalProjection.contract !== 'string')) {
      throw new Error('durable result-reply failure does not match its original offer');
    }
    // A start after a failed stop in this process: the commit queue still
    // holds this task's real terminal and `resume()` above retries it. The
    // journal keeps the first terminal it records, so a recovery terminal
    // here would replace that result.
    if (terminalCommits.hasPending(task.taskId)) continue;
    if (resultFailure) { resultReplyRecoveryTasks.set(task.taskId, { agentRef: payload.agentRef!, contract: payload.messageEgress!.contract! }); continue; }
    await recordRecoveryFailure(task, 'daemon_interrupted', true);
  }

  // S3b (L-003): one measurement before this daemon can accept anything, so
  // the admission guard's first answer comes from a real reading rather than
  // the optimistic `normal` a fresh engine starts in — a device that booted
  // already over its hard watermark must decline the first offer, not the
  // second. Awaited, and deliberately not caught: hosted mode plus a storage
  // policy is an explicit request to gate on local storage, and a daemon that
  // cannot measure it cannot honour that (§12.7.2's fail-closed posture).
  // An INJECTED engine is left alone — its owner drives its cadence.
  await retentionSweeper.runPass('startup');
  retentionSweeper.start();

  daemonState.startedAt = Date.now();
  // M4 Phase 2: a second start() on THIS SAME Daemon instance (e.g. the
  // revoke -> re-pair -> start() again recovery flow) restarts its own
  // control socket rather than colliding with itself — `stop()` was not
  // necessarily called in between (mirrors `connection`/`runner` above,
  // which are also silently replaced on a second start()). Only a
  // DIFFERENT process/instance still holding this storeDir's control
  // socket open is the "another daemon is running" fatal case below.
  // The control socket must never brick the rest of the daemon: "another
  // daemon's control server is already running against this exact
  // storeDir" is the one bind failure that stays fatal (a second daemon
  // writing to the same store concurrently is a real hazard); any other
  // bind failure (e.g. an unsupported filesystem) is logged and the
  // daemon proceeds without a control socket at all.
  await replaceControlServer(false);
  // The run marker begins only after this process has passed the daemon's
  // existing single-owner bind check. Writing it before that check would let
  // a rejected second process overwrite the live daemon's marker and create
  // a false crash record on the next restart.
  await operationalHealth.startRun();
  // The owner alone publishes this host-process observation into the event
  // stream. CLI audit persistence uses that same event, with no second writer.
  daemonState.resolvedEnvironment = { ...serviceEnvironmentStatus() };
  daemonState.environmentResolvedAt = new Date().toISOString();
  // A later start() (re-pair) detects again: until it does, report nothing
  // rather than the previous start's outcomes.
  daemonState.runtimeObservations = [];
  observer.noteEnvironmentResolved({ ...daemonState.resolvedEnvironment }, daemonState.environmentResolvedAt);

  daemonState.blobLifecycleAbort = new AbortController();
  const [{ runtimes, harnesses, observations }, blobClient] = await Promise.all([
    detectRuntimes(adapters),
    Promise.resolve(new BlobClient(config.serverUrl, daemonState.auth, { signal: daemonState.blobLifecycleAbort.signal })),
  ]);
  // Startup owns detection: local status keeps every outcome, while
  // conn.hello advertises only available runtimes. Neither re-probes.
  daemonState.runtimeObservations = observations.map(observation => Object.freeze({ ...observation }));
  observer.noteRuntimesDetected(daemonState.runtimeObservations.map(observation => ({ ...observation })));
  daemonState.detectedRuntimeFacts = runtimes;
  const agentMemoryIntentBackend = await provenAgentMemoryIntentBackend();
  return {
    record, activeJournal, activePressureEngine, journalIdentity, resultReplyRecoveryTasks,
    sealedRun, recordRecoveryFailure, runtimes, harnesses, blobClient, agentMemoryIntentBackend,
  };
}

/** The values of a start that got past enrollment; `openStartRun` returns `undefined` when it waits for enrollment. */
export type StartRun = NonNullable<Awaited<ReturnType<typeof openStartRun>>>;
