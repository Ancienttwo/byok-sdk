// OAR 0.80.1 shared/executable/process-tree.ts. scripts/api-surface/oar-bridge-types.ts checks these types against the vendor source.
/** One process in the table. `start` tells it from a later process given the same pid. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
}
/** The process table at one moment, by pid. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;
/** The process table now (synchronous). Throws when the table cannot be read or omits the host. */
export declare function readProcessTable(source?: "procfs" | "ps" | "windows"): ProcessTable;
/** Every process below `pid` in `table`. */
export declare function descendantsOf(table: ProcessTable, pid: number): ProcessEntry[];
/** SIGKILL each entry that `table` shows still running with the same start time, and its process group; never the host or its group. */
export declare function killEntries(entries: Iterable<ProcessEntry>, table: ProcessTable): void;
