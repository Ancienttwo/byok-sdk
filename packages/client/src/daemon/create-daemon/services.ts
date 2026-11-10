import { createPiInputPreparationCompiler, resolvePinnedPiRuntimeIdentity } from '../../adapters/pi/input-preparation';
import { createInputPreparationService, type InputPreparationService, InputPreparationRequestError } from '../input-preparation-service';
import type { InputPreparationResult } from '../control-protocol';
import { ControlError } from '../control-protocol';
import type { LocalTaskJournal } from '../journal/journal';
import { SqliteLocalTaskJournal, JournalHandleCleanupError } from '../journal/sqlite-journal';
import { type AgentMemoryIntentBackend, NATIVE_AGENT_MEMORY_INTENT_BACKEND, helperAgentMemoryIntentBackend } from '../agent-memory-intent';
import { isAgentMemorySecureFilesystemAvailable, probeAgentMemoryStrictDirectorySync } from '../agent-memory';
import { promises as fs } from 'node:fs';
import { createAgentMemoryCommitStore, type AgentMemoryCommitStore } from '../agent-memory-commit';
import { openAgentMemoryFilesystemHelper } from '../agent-memory-fs-helper';
import type { DaemonScope } from './scope';

/** The daemon's lazily initialized local services: input preparation, the owned hosted journal and the Agent memory intent backend (#926). */

export function initializeInputPreparation(daemonScope: DaemonScope): Promise<void> {
  const { daemonState, config, inputPreparationLimits, storeDir, preparedToolSurface } = daemonScope;
  return daemonState.inputPreparationInitialization ??= (async () => {
    if (config.inputPreparation === undefined || inputPreparationLimits === undefined) return;
    const compiler = createPiInputPreparationCompiler(resolvePinnedPiRuntimeIdentity());
    daemonState.inputPreparationService = createInputPreparationService({
      storeDir, limits: inputPreparationLimits,
      authorityResolver: config.inputPreparation.authorityResolver,
      ...(config.inputPreparation.counter === undefined ? {} : { counter: config.inputPreparation.counter }),
      compiler, toolSurface: preparedToolSurface,
    });
  })();
}

/** Maps this service's typed refusals onto the wire. No refusal is ever widened into a result. */
export async function runInputPreparation(
  daemonScope: DaemonScope,
  call: (service: InputPreparationService) => Promise<InputPreparationResult['receipt']>,
): Promise<InputPreparationResult> {
  const { config, initializeInputPreparation, daemonState } = daemonScope;
  if (config.inputPreparation === undefined) {
    throw new ControlError(
      'input_preparation_unconfigured',
      'this daemon is not configured for input preparation (DaemonConfig.inputPreparation is absent)',
    );
  }
  await initializeInputPreparation();
  if (daemonState.inputPreparationLaneOff !== undefined) {
    throw new ControlError(daemonState.inputPreparationLaneOff.code, daemonState.inputPreparationLaneOff.message);
  }
  if (daemonState.inputPreparationService === undefined) throw new ControlError('runtime_identity_unavailable', 'input preparation initialization did not produce a service');
  if (daemonState.shuttingDown) {
    throw new ControlError('shutting_down', 'this daemon is shutting down and will not prepare new input');
  }
  try {
    return { receipt: await call(daemonState.inputPreparationService) };
  } catch (error) {
    if (error instanceof InputPreparationRequestError) throw new ControlError(error.code, error.message);
    throw error;
  }
}

/** Construct every daemon-owned hosted writer only after ownership exists. */
export function initializeOwnedHostedStorage(daemonScope: DaemonScope): LocalTaskJournal {
  const { daemonState, config, storeDir, overrides } = daemonScope;
  if (!daemonState.journal) {
    const tuning = config.storage?.journal;
    try {
      daemonState.ownedJournal = new SqliteLocalTaskJournal({
        storeDir,
        ...(tuning?.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: tuning.busyTimeoutMs }),
        ...(tuning?.maxRecordBytes === undefined ? {} : { maxRecordBytes: tuning.maxRecordBytes }),
        ...(overrides.journalOpenFaults === undefined ? {} : { openFaults: overrides.journalOpenFaults }),
      });
    } catch (err) {
      if (err instanceof JournalHandleCleanupError) daemonState.hostedStorageInitializationBarrierComplete = false;
      throw err;
    }
    daemonState.journal = daemonState.ownedJournal;
  }
  return daemonState.journal;
}

/**
 * The one memory backend whose writes are proven durable, or `undefined`. All
 * of: an Agent home, the secure memory filesystem on this platform, a backend
 * whose ledger write is a proven durable barrier, and — for the native backend
 * — runtime evidence that the Agent-home filesystem honors directory fsync (the
 * strict barrier would otherwise fail every write). Host-approved intents and
 * commit on success both need it; without it neither capability is advertised.
 */
export async function provenAgentMemoryBackend(daemonScope: DaemonScope): Promise<AgentMemoryIntentBackend | undefined> {
  const { config, agentHomeManager, resolveAgentMemoryFilesystemHelperBin } = daemonScope;
  if (config.agentHome === undefined || agentHomeManager === undefined) return undefined;
  let helperBin: string | undefined;
  let backend: AgentMemoryIntentBackend;
  try {
    helperBin = resolveAgentMemoryFilesystemHelperBin?.();
    if (!isAgentMemorySecureFilesystemAvailable(helperBin !== undefined)) return undefined;
    backend = helperBin === undefined
      ? NATIVE_AGENT_MEMORY_INTENT_BACKEND
      : helperAgentMemoryIntentBackend(helperBin, await fs.realpath(agentHomeManager.layout.hostRootInput()), config.agentMemoryHelperAssetRoot);
  } catch (error) {
    // Intents need this helper. Commit on success is asked of every Agent-home
    // daemon, and only its capability depends on the proof.
    if (config.agentMemoryIntents !== undefined) throw error;
    console.error(`[byok/client] agent memory commit on success is off: the memory helper failed verification: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!backend.strictLedgerBarrier) return undefined;
  if (helperBin !== undefined) {
    // Probe the actual branded volume before advertising. The helper open
    // validates the identity and strictly flushes the complete directory chain.
    try {
      const canonicalHome = await fs.realpath(config.agentHome.hostStorageRoot);
      const stat = await fs.stat(canonicalHome, { bigint: true });
      const probe = await openAgentMemoryFilesystemHelper({ helperBin, assetRoot: config.agentMemoryHelperAssetRoot, ancestorRoot: canonicalHome, canonicalHome, homeIdentity: { dev: stat.dev, ino: stat.ino } });
      await probe.close();
    } catch (error) {
      console.error(`[byok/client] agent memory intents and commit on success are off: the memory helper failed its volume probe: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  if (backend.openFilesystem === undefined && !(await probeAgentMemoryStrictDirectorySync(config.agentHome.hostStorageRoot))) {
    return undefined;
  }
  return backend;
}

/**
 * The commit store of this daemon. `backend` defaults to a fresh proof: the
 * lease hook runs from before a start has proved anything, and only a home with
 * a leftover copy gets that far. The journal answers for the task; before a
 * start opened it, a leftover copy fails its acquire.
 */
export function agentMemoryCommitStore(
  daemonScope: DaemonScope,
  backend: () => Promise<AgentMemoryIntentBackend | undefined> = () => provenAgentMemoryBackend(daemonScope),
): AgentMemoryCommitStore {
  const { daemonState } = daemonScope;
  return createAgentMemoryCommitStore({
    backend,
    taskCompleted: async (taskId) => {
      const { journal, retentionIdentity } = daemonState;
      if (journal === undefined || retentionIdentity === undefined) throw new Error('the task journal is not open');
      return (await journal.readTask(taskId, retentionIdentity))?.localState === 'terminal:complete';
    },
  });
}
