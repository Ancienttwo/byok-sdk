/**
 * Root-bound filesystem authority used by Agent memory. Implementations must
 * pin the exact leased Agent-home object, reject symlink/reparse traversal,
 * and keep every operation relative to that pinned root.
 */
export interface AgentMemoryFilesystem {
  read(path: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState>;
  replace(path: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState>;
  delete(path: string, expectedRevision: string): Promise<void>;
  append(path: string, content: string, maxBytes: number): Promise<void>;
  walk(path: string, maxEntries: number): Promise<readonly string[]>;
  close(): Promise<void>;
}

export interface AgentMemoryFilesystemFileState {
  readonly exists: boolean;
  readonly content: string;
  readonly revision: string;
  readonly byteCount: number;
}

/** Product-owned deployment pointer. The SDK never searches PATH. */
export interface AgentMemoryFilesystemHelperConfig {
  readonly helperBin: string;
}
