import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AGENT_HOME_DIRECTORY, AGENT_HOME_INTERNAL_DIRECTORY } from '../../agent-home';
import { AGENT_MEMORY_INTENT_LEDGER_FILENAME } from '../../daemon/agent-memory-intent';

/** The helper names every temp file with this prefix (`native/agent-memory-fs/main.go`). */
const HELPER_TEMP_PREFIX = '.byok-agent-memory-';
const LEASE_MARKER = 'agent-home.lease';

export interface FileObservation {
  readonly exists: boolean;
  readonly size: number;
  /** `sha256:<hex>` of the bytes; a missing file has the empty-bytes revision, as in the processor. */
  readonly revision: string;
}

export interface HomeSnapshot {
  readonly agentId: string;
  readonly notesDirectory: boolean;
  readonly internalDirectory: boolean;
  /** Raw ledger bytes, base64. The checker parses them with the real strict parser. */
  readonly ledgerBase64: string | null;
  /** `MEMORY.md` and every `notes/<name>.md`, keyed by memory path. */
  readonly files: Readonly<Record<string, FileObservation>>;
  /** Helper temp files left in the home, `notes` or `.byok`. */
  readonly leftovers: readonly string[];
  readonly leaseMarker: 'absent' | 'present';
}

export interface DeviceSnapshot {
  readonly platform: string;
  readonly arch: string;
  readonly runtime: string;
  readonly homes: readonly HomeSnapshot[];
}

export const EMPTY_REVISION = revisionOf(new Uint8Array(0));

export function revisionOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function namesIn(directory: string): Promise<string[] | null> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function observe(bytes: Buffer | null): FileObservation {
  return bytes === null
    ? { exists: false, size: 0, revision: EMPTY_REVISION }
    : { exists: true, size: bytes.byteLength, revision: revisionOf(bytes) };
}

/**
 * Read the store as the restarted device finds it, before any recovery write.
 * Plain reads only: no helper session and no home lease, because the lease
 * writes a marker file. On Windows this must run in the booted guest, after
 * NTFS has replayed its log at mount; an offline reader would see another
 * state.
 */
export async function takeDeviceSnapshot(storeRoot: string): Promise<DeviceSnapshot> {
  const agentsRoot = path.join(storeRoot, AGENT_HOME_DIRECTORY);
  const homes: HomeSnapshot[] = [];
  for (const agentId of (await namesIn(agentsRoot)) ?? []) {
    const home = path.join(agentsRoot, agentId);
    const notes = await namesIn(path.join(home, 'notes'));
    const internal = await namesIn(path.join(home, AGENT_HOME_INTERNAL_DIRECTORY));
    const files: Record<string, FileObservation> = {
      'MEMORY.md': observe(await readOptional(path.join(home, 'MEMORY.md'))),
    };
    for (const name of notes ?? []) {
      if (name.endsWith('.md') && !name.startsWith(HELPER_TEMP_PREFIX)) {
        files[`notes/${name}`] = observe(await readOptional(path.join(home, 'notes', name)));
      }
    }
    const leftovers = [
      ...((await namesIn(home)) ?? []),
      ...(notes ?? []).map((name) => `notes/${name}`),
      ...(internal ?? []).map((name) => `${AGENT_HOME_INTERNAL_DIRECTORY}/${name}`),
    ].filter((name) => path.posix.basename(name).startsWith(HELPER_TEMP_PREFIX));
    const ledger = await readOptional(path.join(home, AGENT_HOME_INTERNAL_DIRECTORY, AGENT_MEMORY_INTENT_LEDGER_FILENAME));
    homes.push({
      agentId,
      notesDirectory: notes !== null,
      internalDirectory: internal !== null,
      ledgerBase64: ledger === null ? null : ledger.toString('base64'),
      files,
      leftovers,
      leaseMarker: internal?.includes(LEASE_MARKER) ? 'present' : 'absent',
    });
  }
  return {
    platform: process.platform,
    arch: process.arch,
    runtime: process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`,
    homes,
  };
}
