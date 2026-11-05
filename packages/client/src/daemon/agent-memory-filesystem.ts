/**
 * Root-bound filesystem authority used by Agent memory. Implementations must
 * pin the exact leased Agent-home object, reject symlink/reparse traversal,
 * and keep every operation relative to that pinned root.
 */
export interface AgentMemoryFilesystem {
  read(path: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState>;
  replace(path: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState>;
  delete(path: string, expectedRevision: string): Promise<void>;
  /** The revision of the file's raw bytes, with no size limit and no UTF-8 requirement. */
  observe(path: string): Promise<AgentMemoryFileObservation>;
  /** Restore-only (#1440): see `cleanupAgentMemoryHomeForRestore`. */
  cleanupForRestore(record: AgentMemoryRestoreRecord): Promise<AgentMemoryRestoreCleanup>;
  append(path: string, content: string, maxBytes: number): Promise<void>;
  walk(path: string, maxEntries: number): Promise<AgentMemoryWalk>;
  close(): Promise<void>;
}

export interface AgentMemoryFilesystemFileState {
  readonly exists: boolean;
  readonly content: string;
  readonly revision: string;
  readonly byteCount: number;
}

/** One observation of a memory file: existence and the sha256 of its exact bytes. */
export interface AgentMemoryFileObservation {
  readonly exists: boolean;
  readonly revision: string;
}

/**
 * `directory` was entered, so its contents are in the record too.
 * `opaque-directory` was seen and not entered, so only the directory itself is.
 */
export type AgentMemoryWalkEntryKind = 'file' | 'directory' | 'opaque-directory' | 'other';

/** One entry a walk saw, listed or not. The path is only ever compared with another walk's. */
export interface AgentMemoryWalkEntry {
  readonly path: string;
  readonly kind: AgentMemoryWalkEntryKind;
}

export interface AgentMemoryWalk {
  /** Regular files with one link that the walk lists; a caller filters them to memory paths. */
  readonly paths: readonly string[];
  /** Everything the walk saw, including what it left out of `paths`. */
  readonly entries: readonly AgentMemoryWalkEntry[];
}

/** What an Attempt started with, as a restore needs it. */
export interface AgentMemoryRestoreRecord {
  /** The paths of the start copy, including `MEMORY.md`. */
  readonly files: readonly string[];
  /** The `entries` of the walk at the start. */
  readonly entries: readonly AgentMemoryWalkEntry[];
}

/** Entries a restore cleanup removed. A directory removed with its contents counts once. */
export interface AgentMemoryRestoreCleanup {
  readonly deleted: number;
}
