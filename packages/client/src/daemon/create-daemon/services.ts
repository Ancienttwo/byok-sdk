import { createPiInputPreparationCompiler, resolvePinnedPiRuntimeIdentity } from '../../adapters/pi/input-preparation.js';
import { createInputPreparationService, type InputPreparationService, InputPreparationRequestError } from '../input-preparation-service.js';
import type { InputPreparationResult } from '../control-protocol.js';
import { ControlError } from '../control-protocol.js';
import type { LocalTaskJournal } from '../journal/journal.js';
import { SqliteLocalTaskJournal, JournalHandleCleanupError } from '../journal/sqlite-journal.js';
import { type AgentMemoryIntentBackend, NATIVE_AGENT_MEMORY_INTENT_BACKEND, helperAgentMemoryIntentBackend } from '../agent-memory-intent.js';
import { isAgentMemorySecureFilesystemAvailable, probeAgentMemoryStrictDirectorySync } from '../agent-memory.js';
import { promises as fs } from 'node:fs';
import { createAgentMemoryCommitStore, type AgentMemoryCommitStore } from '../agent-memory-commit.js';
import { openAgentMemoryFilesystemHelper } from '../agent-memory-fs-helper.js';
import { isAgentMemoryHelperTimeout, withAgentMemoryHelperProbe } from '../agent-memory-helper-probe.js';
import { backoffCeilingMs } from '../deterministic-jitter.js';
import type { DaemonScope } from './scope.js';

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
type MemoryProof = {
  status: 'proven' | 'unproven' | 'refused' | undefined;
  backend: AgentMemoryIntentBackend | undefined;
  refusal?: string;
  pending?: Promise<AgentMemoryIntentBackend | undefined> | undefined;
};
const memoryProofs = new WeakMap<DaemonScope, MemoryProof>();

export function agentMemoryBackendProof(scope: DaemonScope): MemoryProof {
  let proof = memoryProofs.get(scope);
  if (proof === undefined) {
    proof = { status: undefined, backend: undefined };
    memoryProofs.set(scope, proof);
  }
  return proof;
}

/** Coalesced proof; only a missed deadline is retryable, never an authoritative refusal. */
export async function provenAgentMemoryBackend(scope: DaemonScope, signal?: AbortSignal): Promise<AgentMemoryIntentBackend | undefined> {
  const proof = agentMemoryBackendProof(scope);
  if (proof.status === 'proven' || proof.status === 'refused') return proof.backend;
  return proof.pending ??= (async () => {
    let status: MemoryProof['status'];
    let backend: AgentMemoryIntentBackend | undefined;
    try {
      backend = await probeAgentMemoryBackend(scope, signal);
      status = backend === undefined ? 'refused' : 'proven';
    } catch (error) {
      if (signal?.aborted) return undefined;
      if (!isAgentMemoryHelperTimeout(error)) throw error;
      status = 'unproven';
    }
    if (signal?.aborted) return undefined;
    if (proof.status !== status && scope.config.agentHome !== undefined) {
      const transition = status === 'proven' && proof.status === 'unproven' ? 'recovered' : status;
      console.error(`[byok/client] agent memory backend ${transition}${proof.refusal === undefined ? '' : `: ${proof.refusal}`}`);
    }
    proof.backend = backend;
    proof.status = status;
    return proof.backend;
  })().finally(() => { proof.pending = undefined; });
}

/** This run owns the timer and in-flight probe through its lifecycle signal. */
export function recoverAgentMemoryBackend(scope: DaemonScope, signal: AbortSignal, changed: () => void): void {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); };
  signal.addEventListener('abort', cancel, { once: true });
  const schedule = () => {
    if (signal.aborted || agentMemoryBackendProof(scope).status !== 'unproven') {
      signal.removeEventListener('abort', cancel);
      return;
    }
    timer = setTimeout(async () => {
      try {
        await provenAgentMemoryBackend(scope, signal);
        if (!signal.aborted) changed();
      } catch {
        // A newly invalid helper is authoritative; it must not spin forever.
        agentMemoryBackendProof(scope).status = 'refused';
        console.error('[byok/client] agent memory backend refused: helper verification failed');
      }
      schedule();
    }, Math.min(backoffCeilingMs(attempt++, 1_000), 30_000));
    timer.unref?.();
  };
  schedule();
}

async function probeAgentMemoryBackend(daemonScope: DaemonScope, signal?: AbortSignal): Promise<AgentMemoryIntentBackend | undefined> {
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
    agentMemoryBackendProof(daemonScope).refusal = 'helper verification failed';
    return undefined;
  }
  if (!backend.strictLedgerBarrier) return undefined;
  if (helperBin !== undefined) {
    // Probe the actual branded volume before advertising. The helper open
    // validates the identity and strictly flushes the complete directory chain.
    try {
      const canonicalHome = await fs.realpath(config.agentHome.hostStorageRoot);
      const stat = await fs.stat(canonicalHome, { bigint: true });
      const probe = await withAgentMemoryHelperProbe(() => openAgentMemoryFilesystemHelper({ helperBin, assetRoot: config.agentMemoryHelperAssetRoot, ancestorRoot: canonicalHome, canonicalHome, homeIdentity: { dev: stat.dev, ino: stat.ino } }), signal);
      await probe.close();
    } catch (error) {
      if (isAgentMemoryHelperTimeout(error) || signal?.aborted) throw error;
      agentMemoryBackendProof(daemonScope).refusal = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }
  if (backend.openFilesystem === undefined && !(await probeAgentMemoryStrictDirectorySync(config.agentHome.hostStorageRoot))) {
    return undefined;
  }
  return backend;
}

/**
 * The commit store shares this daemon's proof. The lease hook can run before
 * startup, and only a home with a leftover copy gets that far. The journal
 * answers for the task; before a start opened it, a leftover copy fails its acquire.
 */
export function agentMemoryCommitStore(daemonScope: DaemonScope): AgentMemoryCommitStore {
  const { daemonState } = daemonScope;
  return createAgentMemoryCommitStore({
    backend: () => provenAgentMemoryBackend(daemonScope),
    taskCompleted: async (taskId) => {
      const { journal, retentionIdentity } = daemonState;
      if (journal === undefined || retentionIdentity === undefined) throw new Error('the task journal is not open');
      return (await journal.readTask(taskId, retentionIdentity))?.localState === 'terminal:complete';
    },
  });
}
