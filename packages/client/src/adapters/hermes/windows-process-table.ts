import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Windows process ancestry for the Hermes gateway ownership check
 * (`gateway-ownership.ts`). Root entries reach it only through the lazy
 * `#byok-hermes-session` entry.
 */

/**
 * Parent links to walk. Windows custody: launcher, `hermes.exe` console
 * script, venv `python.exe` redirector, then the interpreter that runs the
 * gateway.
 */
const MAX_DEPTH = 4;
const QUERY_TIMEOUT_MS = 15_000;
/** One line per process: pid, parent pid, creation time as FILETIME ticks (0 when Windows does not report it). */
const PROCESS_TABLE_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";

export interface WindowsProcessEntry {
  readonly parent: number;
  /** FILETIME ticks. A bigint: the values exceed `Number.MAX_SAFE_INTEGER`. */
  readonly created: bigint;
}

/**
 * Whether `pid` is a descendant of `root`, at most {@link MAX_DEPTH} links up.
 * A link counts only when the parent started no later than the child, so a
 * parent pid that Windows reused for a newer process does not count.
 */
export function descendsFrom(table: ReadonlyMap<number, WindowsProcessEntry>, root: number, pid: number): boolean {
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const entry = table.get(current);
    const parent = entry === undefined ? undefined : table.get(entry.parent);
    if (entry === undefined || parent === undefined || entry.created === 0n || parent.created === 0n || parent.created > entry.created) return false;
    if (entry.parent === root) return true;
    current = entry.parent;
  }
  return false;
}

export function parseWindowsProcessTable(text: string): Map<number, WindowsProcessEntry> {
  const table = new Map<number, WindowsProcessEntry>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (match !== null) table.set(Number(match[1]), { parent: Number(match[2]), created: BigInt(match[3]!) });
  }
  return table;
}

function readWindowsProcessTable(signal?: AbortSignal): Promise<Map<number, WindowsProcessEntry>> {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) return Promise.reject(new Error('Windows SystemRoot must be an absolute path'));
  const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROCESS_TABLE_SCRIPT, 'utf16le').toString('base64')];
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal }, (error, stdout) => {
      if (error !== null) reject(new Error('Windows process table read failed', { cause: error }));
      else resolve(parseWindowsProcessTable(stdout));
    });
  });
}

/**
 * Whether `pid` runs at most four parent links below `root`, after one
 * process-table read. Rejects when the table cannot be read, or when `signal`
 * aborts; the abort also ends the PowerShell child.
 */
export async function descendsOnWindows(root: number, pid: number, signal?: AbortSignal): Promise<boolean> {
  return descendsFrom(await readWindowsProcessTable(signal), root, pid);
}
