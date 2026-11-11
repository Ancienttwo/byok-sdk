import { RESIDENT_MEMORY_MAX_BYTES, type AgentMemoryStartRefusal } from '@byok-sdk/protocol/constants';
import { AgentMemoryError, type AgentMemorySnapshot } from '@byok-sdk/protocol/agent-memory';
import type { ResidentMemoryRead } from '../resident-memory.js';
import {
  AGENT_MEMORY_MAX_LOCAL_LOG_BYTES,
  AgentMemoryIoError,
  AgentMemorySnapshotLimitError,
  captureAgentMemoryHomeSnapshot,
  recordAgentMemoryHomeEntries,
  type AgentMemoryHomeBinding,
} from './agent-memory.js';
import type { AgentMemoryWalkEntryKind } from './agent-memory-filesystem.js';
import { outboundErrorMessage } from './outbound-error.js';

/** The start record as written to the commit manifest; `ManifestSchema` in `agent-memory-commit.ts` parses it back. */
export interface StartRecordManifest {
  readonly version: 1;
  readonly taskId: string;
  readonly files: { readonly path: string; readonly revision: string; readonly byteCount: number }[];
  readonly entries: { readonly path: string; readonly kind: AgentMemoryWalkEntryKind }[];
}

/** A refused snapshot stays refused until someone changes the home; an I/O failure may clear. */
export function agentMemoryCommitFailureRetryable(error: unknown): boolean {
  return !(error instanceof AgentMemoryError) || error instanceof AgentMemoryIoError;
}

/** The `task.fail.failure.class` of a refused start copy (#1843); `undefined` for a failure that may clear. */
export function agentMemoryCopyRefusal(error: unknown): AgentMemoryStartRefusal | undefined {
  if (agentMemoryCommitFailureRetryable(error)) return undefined;
  if (error instanceof AgentMemorySnapshotLimitError && error.limit === 'files') return 'agent_memory_snapshot_over_file_limit';
  if (error instanceof AgentMemorySnapshotLimitError && error.limit === 'bytes') return 'agent_memory_snapshot_over_byte_limit';
  return 'agent_memory_snapshot_refused';
}

/** Appended to the reason of a start refusal over a memory limit: the home stays refused until a write task changes it. */
export const AGENT_MEMORY_RECOVERY = '; to recover, send a write task with agentMemory:"none" and no agentMemoryCommit that brings memory back within its limits';

/** The whole of what a home must pass to be copied. Throws what `copy` refuses, before anything is written. */
export async function readStartRecord(home: AgentMemoryHomeBinding, taskId: string): Promise<{ readonly snapshot: AgentMemorySnapshot; readonly manifest: string }> {
  const snapshot = await captureAgentMemoryHomeSnapshot(home);
  const entries = await recordAgentMemoryHomeEntries(home);
  const manifest = JSON.stringify({
    version: 1,
    taskId,
    files: snapshot.files.map(({ path: memoryPath, revision, byteCount }) => ({ path: memoryPath, revision, byteCount })),
    entries: [...entries],
  } satisfies StartRecordManifest);
  if (Buffer.byteLength(manifest, 'utf8') > AGENT_MEMORY_MAX_LOCAL_LOG_BYTES) throw new AgentMemorySnapshotLimitError('manifest', 'memory start record exceeds its bounded manifest');
  return { snapshot, manifest };
}

/** The class and reason the device fails a task with when it refuses a start. `refusal` is `undefined` for a failure that is not a verdict on the home. */
export interface AgentMemoryStartFailure {
  readonly reason: string;
  readonly refusal: AgentMemoryStartRefusal | undefined;
}

/** The device's refusal of a resident `MEMORY.md` read that did not succeed. */
export function residentMemoryStartFailure(read: Exclude<ResidentMemoryRead, { readonly kind: 'read' }>): AgentMemoryStartFailure {
  return read.kind === 'over-limit'
    ? { reason: `agent_memory_resident_over_limit: ${read.byteCount}/${RESIDENT_MEMORY_MAX_BYTES}${AGENT_MEMORY_RECOVERY}`, refusal: 'agent_memory_resident_over_limit' }
    : { reason: `agent_memory_resident_unreadable: ${read.reason}`, refusal: read.refusal };
}

/** The reason of a commit start copy that failed: `recovery` only when the home itself is refused. */
export function agentMemoryCommitUnavailableReason(error: unknown, recovery: boolean): string {
  return `agent_memory_commit_unavailable: ${outboundErrorMessage(error)}${recovery ? AGENT_MEMORY_RECOVERY : ''}`;
}

/** The device's refusal of a start copy that threw. */
export function copyStartFailure(error: unknown): AgentMemoryStartFailure {
  return { reason: agentMemoryCommitUnavailableReason(error, !agentMemoryCommitFailureRetryable(error)), refusal: agentMemoryCopyRefusal(error) };
}
