// OAR shared/executable/process-tree.ts. scripts/api-surface/oar-bridge-types.ts checks these types against the vendor source.
/** One process in the table. `start` tells it from a later process given the same pid. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
  /** POSIX has recorded exit but the parent has not reaped the process yet. */
  readonly zombie?: true;
}
/** The process table at one moment, by pid. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;
/** A table read and the entries omitted from it. */
export interface ProcessTableRead {
  readonly table: ProcessTable;
  /** Entries omitted because access or a start identity was unavailable. */
  readonly skipped: number;
  /** Enumerated PIDs whose identities could not be read. */
  readonly unreadable?: ReadonlySet<number>;
}
export type ProcessTableSource = 'procfs' | 'ps' | 'windows';
export type ProcessTableFailureReason = 'timeout' | 'command_failed' | 'spawn_failed' | 'read_failed' | 'invalid_output' | 'missing_host' | 'missing_root' | 'descendant_unreadable' | 'descendant_still_running' | 'descendant_exit_unconfirmed';
export interface ProcessTableFailure {
  readonly ok: false;
  readonly source: ProcessTableSource;
  readonly elapsedMs: number;
  readonly reason: ProcessTableFailureReason;
  readonly code?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timeoutMs?: number;
}
export type ProcessTableObservation = ProcessTableFailure | (ProcessTableRead & {
  readonly ok: true;
  readonly source: ProcessTableSource;
  readonly elapsedMs: number;
});
export declare function observeProcessTable(source?: ProcessTableSource): ProcessTableObservation;
/** Parses `ps -A -o pid=,ppid=,pgid=,stat=,lstart=` output. Throws on a line it cannot read. */
export declare function parseProcessPs(output: string): ProcessTableRead;
/** The process table now (synchronous). Throws when the table cannot be read or omits the host. */
export declare function readProcessTable(source?: "procfs" | "ps" | "windows"): ProcessTable;
/** Every process below `pid` in `table`. On Windows an edge counts only when the child started no earlier than its parent (pid reuse). */
export declare function descendantsOf(table: ProcessTable, pid: number, source?: "procfs" | "ps" | "windows"): ProcessEntry[];
/** SIGKILL matching identities and their groups. Return PIDs for which the OS refused permission. */
export declare function killEntries(entries: Iterable<ProcessEntry>, table: ProcessTable): ReadonlySet<number>;

export declare const PIPE_CLOSE_MS: 2000;
export declare function closePipesAfterExit(
  child: import('node:child_process').ChildProcess,
  pipes: readonly { readonly name: 'stdout' | 'stderr'; readonly stream: import('node:stream').Readable | null }[],
  limitMs?: number,
  onLater?: undefined,
  unreadLimitMs?: number,
  retainHolders?: (child: import('node:child_process').ChildProcess, entries: readonly ProcessEntry[]) => void,
): Promise<unknown>;
export type OwnQueryProcess = <P extends { kill(): void; readonly exited: Promise<unknown> }>(process: P) => P;
export declare function withQueryDeadline<T>(
  name: string,
  timeoutMs: number,
  query: (signal: AbortSignal, own: OwnQueryProcess) => Promise<T>,
  timeoutResult?: T,
  signal?: AbortSignal,
): Promise<T>;
