import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES, AGENT_MEMORY_MAX_SNAPSHOT_FILES } from '@byok-sdk/protocol/constants';
import { AgentMemoryError, validateAgentMemoryPath } from '@byok-sdk/protocol/agent-memory';
import { AGENT_HOME_INTERNAL_DIRECTORY, AgentHomeResolutionError, ensureDirectoryNoSymlink, type AgentHomeLease } from '../agent-home.js';
import {
  agentMemoryHomeBinding,
  appendAgentMemoryHomeAudit,
  cleanupAgentMemoryHomeForRestore,
  compareAndSwapAgentMemoryHomeFile,
  deleteAgentMemoryHomeInternalFileStrict,
  observeAgentMemoryHomeFile,
  readAgentMemoryHomeInternalFile,
  replaceAgentMemoryHomeInternalFileStrict,
  type AgentMemoryHomeBinding,
} from './agent-memory.js';
import type { AgentMemoryIntentBackend } from './agent-memory-intent.js';
import { agentMemoryCommitFailureRetryable, readStartRecord, type StartRecordManifest } from './agent-memory-start-record.js';

const MANIFEST_FILENAME = 'agent-memory-commit-manifest.json';
const contentFilename = (index: number): string => `agent-memory-commit-content-${index}`;

/** Written last, so a copy exists exactly when this file does. */
const ManifestSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  files: z.array(z.object({
    path: z.string().transform((value) => validateAgentMemoryPath(value)),
    revision: z.string(),
    byteCount: z.number().int().nonnegative(),
  }).strict()).min(1).max(AGENT_MEMORY_MAX_SNAPSHOT_FILES),
  /** The start record the restore cleanup compares with. Native trusts each `kind`, so it is checked here. */
  entries: z.array(z.object({
    path: z.string().min(1),
    kind: z.enum(['file', 'directory', 'opaque-directory', 'other']),
  }).strict()).max(AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES),
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;
/** Compile-time proof that what `readStartRecord` writes is what the schema reads back. */
export type StartRecordIsManifest = StartRecordManifest extends z.input<typeof ManifestSchema> ? true : never;

export type AgentMemoryCommitHome = Pick<AgentHomeLease, 'canonicalHome' | 'homeIdentity'>;

/** The start copy of a writer Attempt that commits on success (#1440). The caller holds the home lease. */
export interface AgentMemoryCommitStore {
  /** Writes the copy, or throws before a runtime may start. */
  copy(home: AgentMemoryCommitHome, taskId: string): Promise<void>;
  /**
   * What the next `copy` would refuse in this home as it stands, if anything
   * (#1474). Throws when the check itself fails, which decides nothing.
   */
  refusal(home: AgentMemoryCommitHome, taskId: string): Promise<Error | undefined>;
  /**
   * Ends a copy, if there is one: the journal terminal of its task decides, here
   * as after a crash. `task.complete` keeps the live files; any other terminal,
   * or no terminal, restores them. The copy goes only after that succeeded, so a
   * failure leaves it for the next lease.
   */
  settle(home: AgentMemoryCommitHome): Promise<void>;
}

async function writeInternal(home: AgentMemoryHomeBinding, fileName: string, content: string): Promise<void> {
  const current = await readAgentMemoryHomeInternalFile(home, fileName);
  await replaceAgentMemoryHomeInternalFileStrict(home, fileName, current.revision, content);
}

/** Every content slot, so one a crash left without a manifest goes too. */
async function deleteContent(home: AgentMemoryHomeBinding): Promise<void> {
  for (let index = 0; index < AGENT_MEMORY_MAX_SNAPSHOT_FILES; index += 1) {
    const current = await readAgentMemoryHomeInternalFile(home, contentFilename(index));
    if (current.exists) await deleteAgentMemoryHomeInternalFileStrict(home, contentFilename(index), current.revision);
  }
}

async function readVerifiedContent(home: AgentMemoryHomeBinding, manifest: Manifest): Promise<readonly string[]> {
  const contents: string[] = [];
  for (const [index, file] of manifest.files.entries()) {
    const stored = await readAgentMemoryHomeInternalFile(home, contentFilename(index));
    if (!stored.exists || stored.revision !== file.revision || stored.byteCount !== file.byteCount) {
      throw new AgentMemoryError(`Agent memory commit copy of ${file.path} does not match its manifest`);
    }
    contents.push(stored.content);
  }
  return contents;
}

async function restore(home: AgentMemoryHomeBinding, manifest: Manifest): Promise<void> {
  const contents = await readVerifiedContent(home, manifest);
  const { deleted } = await cleanupAgentMemoryHomeForRestore(home, { files: manifest.files.map((file) => file.path), entries: manifest.entries });
  // Neither backend creates a parent. `notes` was a directory at the start, and
  // the next walk needs it even when the copy holds no note to bring it back.
  await ensureDirectoryNoSymlink(home.canonicalHome, path.join(home.canonicalHome, 'notes'));
  let restored = 0;
  for (const [index, file] of manifest.files.entries()) {
    await ensureDirectoryNoSymlink(home.canonicalHome, path.dirname(path.join(home.canonicalHome, file.path)));
    const current = await observeAgentMemoryHomeFile(home, file.path);
    if (current.exists && current.revision === file.revision) continue;
    await compareAndSwapAgentMemoryHomeFile(home, { operation: 'replace', path: file.path, expectedRevision: current.revision, content: contents[index]! });
    restored += 1;
  }
  await appendAgentMemoryHomeAudit(home, { kind: 'agent_memory_commit_restore', taskId: manifest.taskId, restored, deleted }).catch((error: unknown) => {
    console.error(`[byok/client] Agent memory commit restore audit failed for ${manifest.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function createAgentMemoryCommitStore(input: {
  readonly backend: () => Promise<AgentMemoryIntentBackend | undefined>;
  /** Whether the journal holds `task.complete` for this task. Throws when the journal cannot answer. */
  readonly taskCompleted: (taskId: string) => Promise<boolean>;
}): AgentMemoryCommitStore {
  async function withBinding<T>(home: AgentMemoryCommitHome, work: (binding: AgentMemoryHomeBinding) => Promise<T>): Promise<T> {
    const backend = await input.backend();
    if (backend === undefined) throw new AgentMemoryError('Agent memory commit needs a proven strict memory backend');
    const filesystem = await backend.openFilesystem?.(home);
    try {
      return await work(agentMemoryHomeBinding({
        canonicalHome: home.canonicalHome,
        homeIdentity: home.homeIdentity,
        ...(filesystem === undefined ? {} : { filesystem }),
      }));
    } finally {
      await filesystem?.close().catch(() => {});
    }
  }

  return Object.freeze<AgentMemoryCommitStore>({
    copy: (home, taskId) => withBinding(home, async (binding) => {
      const { snapshot, manifest } = await readStartRecord(binding, taskId);
      for (const [index, file] of snapshot.files.entries()) await writeInternal(binding, contentFilename(index), file.content);
      await writeInternal(binding, MANIFEST_FILENAME, manifest);
    }),
    refusal: (home, taskId) => withBinding(home, async (binding) => {
      try {
        // The next lease builds `notes` and `MEMORY.md` back, so losing them refuses nothing.
        await ensureDirectoryNoSymlink(home.canonicalHome, path.join(home.canonicalHome, 'notes'));
        const resident = await observeAgentMemoryHomeFile(binding, 'MEMORY.md');
        if (!resident.exists) await compareAndSwapAgentMemoryHomeFile(binding, { operation: 'replace', path: 'MEMORY.md', expectedRevision: resident.revision, content: '' });
        await readStartRecord(binding, taskId);
        return undefined;
      } catch (error) {
        if (error instanceof AgentHomeResolutionError || !agentMemoryCommitFailureRetryable(error)) return error as Error;
        throw error;
      }
    }),
    settle: async (home) => {
      // Every lease passes here, and most homes have no copy: this avoids a helper process.
      const present = await fs.lstat(path.join(home.canonicalHome, AGENT_HOME_INTERNAL_DIRECTORY, MANIFEST_FILENAME))
        .then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
      if (!present) return;
      await withBinding(home, async (binding) => {
        const stored = await readAgentMemoryHomeInternalFile(binding, MANIFEST_FILENAME);
        if (!stored.exists) return;
        let manifest: Manifest;
        try {
          manifest = ManifestSchema.parse(JSON.parse(stored.content));
        } catch {
          throw new AgentMemoryError('Agent memory commit manifest is invalid');
        }
        if (!await input.taskCompleted(manifest.taskId)) await restore(binding, manifest);
        await deleteAgentMemoryHomeInternalFileStrict(binding, MANIFEST_FILENAME, stored.revision);
        await deleteContent(binding);
      });
    },
  });
}
