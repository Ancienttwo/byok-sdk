import { execFile, type ExecFileException } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPrivateSystemTempDir } from '../../util/secure-dir';

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
const QUERY_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 } as const;
/**
 * The primary read, run by cscript.exe: one line per process, pid, parent pid,
 * creation time as FILETIME ticks (0 when Windows does not report it). WMI
 * gives CreationDate as local time, a UTC offset in minutes and microseconds.
 * JScript has no 64-bit integers, so the ticks are the whole seconds since
 * 1601 followed by seven digits. Its own failures exit 2, so exit 1 with no
 * table means the script host did not run it. Windows CI compared it with the
 * PowerShell read: the same ticks for every pid (#1410 B1, issue comment
 * 6622950935).
 */
const PROCESS_TABLE_JSCRIPT = [
  'try {',
  '  var wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\\\\\.\\\\root\\\\cimv2");',
  '  var rows = wmi.ExecQuery("SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process", "WQL", 48);',
  '  var out = [];',
  '  for (var e = new Enumerator(rows); !e.atEnd(); e.moveNext()) {',
  '    var p = e.item(), d = p.CreationDate, ticks = "0";',
  '    if (d !== null && d !== undefined && d !== "") {',
  '      var m = /^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})\\.(\\d{6})([+-])(\\d{3})$/.exec(d);',
  '      if (m === null) throw new Error("unexpected CreationDate " + d);',
  '      var offset = (m[8] === "-" ? -1 : 1) * Number(m[9]);',
  '      var secs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000 + 11644473600 - offset * 60;',
  '      var frac = String(Number(m[7]) * 10);',
  '      while (frac.length < 7) frac = "0" + frac;',
  '      ticks = String(secs) + frac;',
  '    }',
  '    out.push(p.ProcessId + " " + p.ParentProcessId + " " + ticks);',
  '  }',
  '  WScript.StdOut.Write(out.join("\\r\\n"));',
  '} catch (err) {',
  '  WScript.StdErr.Write("process table read failed: " + (err.number >>> 0).toString(16) + " " + err.message);',
  '  WScript.Quit(2);',
  '}',
].join('\r\n');
/** The fallback read, for a host where Windows Script Host cannot run: the same lines from Windows PowerShell. */
const PROCESS_TABLE_POWERSHELL = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";

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

/** What a cscript run produced: the table, a script host that could not run the script, or another failure. */
export type ScriptHostRead =
  | { readonly kind: 'table'; readonly table: Map<number, WindowsProcessEntry> }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: ExecFileException };

/**
 * Only a script host that could not run the script counts as unavailable:
 * cscript.exe could not be started because it is missing (ENOENT) or access
 * to it is denied (EACCES), or it exited 1 with no table line (Windows Script
 * Host disabled; the script itself exits 2). A spawn that ran out of
 * resources (EMFILE, ENFILE, EAGAIN), a timeout, an abort, exit 2 and any
 * other exit fail. Other spawn errors, such as EPERM or UNKNOWN, are thrown
 * synchronously by `execFile` and never reach this function, so they fail too.
 */
export function classifyScriptHostRead(error: ExecFileException | null, stdout: string): ScriptHostRead {
  if (error === null) return { kind: 'table', table: parseWindowsProcessTable(stdout) };
  if (error.syscall?.startsWith('spawn') && (error.code === 'ENOENT' || error.code === 'EACCES')) {
    return { kind: 'unavailable', reason: `cscript.exe did not start (${error.code})` };
  }
  if (error.code === 1 && parseWindowsProcessTable(stdout).size === 0) return { kind: 'unavailable', reason: 'cscript.exe exited 1 without a process table' };
  return { kind: 'failed', error };
}

function windowsSystem32(): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot must be an absolute path');
  return path.win32.join(systemRoot, 'System32');
}

/** The script is written per read into an owner-only directory, removed once cscript has exited, also after a timeout or an abort. */
async function readThroughScriptHost(signal?: AbortSignal): Promise<ScriptHostRead> {
  const cscript = path.win32.join(windowsSystem32(), 'cscript.exe');
  const directory = await createPrivateSystemTempDir('byok-process-table-');
  try {
    const script = path.join(directory, 'process-table.js');
    await fs.writeFile(script, PROCESS_TABLE_JSCRIPT, { flag: 'wx' });
    return await new Promise((resolve) => {
      execFile(cscript, ['//NoLogo', '//E:JScript', script], { ...QUERY_OPTIONS, signal }, (error, stdout) => {
        resolve(classifyScriptHostRead(error, stdout));
      });
    });
  } finally {
    // After an abort cscript can still hold the script open for a moment; retry instead of masking the read's own error with EBUSY.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** @internal The fallback read, exported for the Windows CI test that keeps it working. */
export async function readThroughPowerShell(signal?: AbortSignal): Promise<Map<number, WindowsProcessEntry>> {
  const command = path.win32.join(windowsSystem32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROCESS_TABLE_POWERSHELL, 'utf16le').toString('base64')];
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...QUERY_OPTIONS, signal }, (error, stdout) => {
      if (error !== null) reject(new Error('Windows process table read failed', { cause: error }));
      else resolve(parseWindowsProcessTable(stdout));
    });
  });
}

let fallbackWarned = false;

async function readWindowsProcessTable(signal?: AbortSignal): Promise<Map<number, WindowsProcessEntry>> {
  const read = await readThroughScriptHost(signal);
  if (read.kind === 'table') return read.table;
  if (read.kind === 'failed') throw new Error('Windows process table read failed', { cause: read.error });
  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn(`[byok/hermes-adapter] Windows Script Host cannot run the process-table read (${read.reason}); reading it through Windows PowerShell instead (further fallbacks won't be logged)`);
  }
  return readThroughPowerShell(signal);
}

/**
 * Whether `pid` runs at most four parent links below `root`, after one
 * process-table read. Rejects when the table cannot be read, or when `signal`
 * aborts; the abort also ends the cscript or PowerShell child.
 */
export async function descendsOnWindows(root: number, pid: number, signal?: AbortSignal): Promise<boolean> {
  return descendsFrom(await readWindowsProcessTable(signal), root, pid);
}
