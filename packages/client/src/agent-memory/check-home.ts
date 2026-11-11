import { promises as fs } from 'node:fs';
import type { AgentMemoryStartRefusal } from '@byok-sdk/protocol/constants';
import { AgentMemoryError } from '@byok-sdk/protocol/agent-memory';
import { readResidentMemory } from '../resident-memory.js';
import { agentMemoryHomeBinding, isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory.js';
import type { AgentMemoryFilesystem } from '../daemon/agent-memory-filesystem.js';
import {
  agentMemoryCopyRefusal, copyStartFailure, readStartRecord, residentMemoryStartFailure,
} from '../daemon/agent-memory-start-record.js';

/** A task id of a typical length: the start record carries one, so its size bound depends on it. */
const PLACEHOLDER_TASK_ID = '00000000-0000-0000-0000-000000000000';

/** The verdict of {@link checkAgentMemoryHome}. `reason` is the `task.fail` reason the device sends for the same home. */
export type AgentMemoryHomeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AgentMemoryStartRefusal; readonly reason: string };

/**
 * Whether the device would refuse a task on this Agent home because of its
 * memory (#1843), with the code and reason it fails that task with. It runs the
 * device's own readers, read-only, so the two cannot drift.
 *
 * It throws and decides nothing when it cannot read: a `MEMORY.md` that is
 * missing (every lease creates one), a changed home identity, an I/O error, or
 * no secure memory backend on this platform. On macOS and Windows pass the
 * helper's filesystem for this home as `commit.filesystem`; the caller closes it.
 *
 * The verdict is about the home, and the device applies each half to one kind
 * of task: resident refusals to a task that carries `MEMORY.md` into its
 * prompt, start-record refusals to a task with `agentMemoryCommit`. The repair
 * task (`agentMemory:"none"`, no commit) is never refused, so this verdict does
 * not gate it.
 *
 * The check holds no home lease and has no task id, so it is advisory: a home
 * within a task id's length of the start-record bound can pass and still be refused.
 */
export async function checkAgentMemoryHome(
  home: string,
  options: { readonly commit?: { readonly filesystem?: AgentMemoryFilesystem } } = {},
): Promise<AgentMemoryHomeCheck> {
  const filesystem = options.commit?.filesystem;
  if (!isAgentMemorySecureFilesystemAvailable(filesystem !== undefined)) throw new AgentMemoryError('Agent memory home check needs a secure memory filesystem on this platform');
  const canonicalHome = await fs.realpath(home);
  const { dev, ino } = await fs.stat(canonicalHome, { bigint: true });
  const resident = await readResidentMemory(canonicalHome, { dev, ino });
  if (resident.kind !== 'read') {
    const { reason, refusal } = residentMemoryStartFailure(resident);
    if (refusal === undefined) throw new AgentMemoryError(`MEMORY.md cannot be judged: ${reason}`);
    return { ok: false, code: refusal, reason };
  }
  try {
    await readStartRecord(agentMemoryHomeBinding({ canonicalHome, homeIdentity: { dev, ino }, ...(filesystem === undefined ? {} : { filesystem }) }), PLACEHOLDER_TASK_ID);
    return { ok: true };
  } catch (error) {
    const code = agentMemoryCopyRefusal(error);
    if (code === undefined) throw error;
    return { ok: false, code, reason: copyStartFailure(error).reason };
  }
}
