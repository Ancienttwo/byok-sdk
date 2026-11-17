/**
 * Who wrote an Agent-home lease marker or lease temp file, and whether that
 * writer can still be running (#2348). One owner can run in several processes
 * at once (a daemon and a memory export beside it, or two products sharing a
 * root), so a file's owner alone never proves its writer gone.
 *
 * A writer is its pid and that process's start time, on one host and boot:
 * - `host`: a domain-separated digest of the OS machine identifier
 *   ({@link resolveMachineId}); the raw identifier is never stored;
 * - `pidNamespace`: Linux only, the inode of `/proc/self/ns/pid`. A pid names
 *   a process only within its namespace, so two containers on one machine are
 *   two hosts here;
 * - `boot`: Linux `boot_id`, darwin `kern.bootsessionuuid` (not
 *   `kern.boottime`, which moves when the clock is stepped), win32
 *   `LastBootUpTime` rounded to the second.
 *
 * Every read that fails, on either side, decides toward "may be running".
 */
import { promises as fs } from 'node:fs';
import { runDeviceCommand } from './util/system-command.js';
import { resolveMachineId } from './daemon/machine-id.js';

export interface AgentHomeLeaseWriter {
  readonly pid: number;
  /** The OS start time of `pid`, in that platform's own form; only compared for equality. */
  readonly start: string;
  readonly host: string;
  readonly boot: string;
  readonly pidNamespace?: string;
}

/**
 * Why a lease file's writer is not proved gone:
 * - `legacy-marker`: written by an SDK release that records no writer;
 * - `unverifiable`: its writer, or this process's own identity, could not be read;
 * - `other-host`: written on another machine, or this machine's identity is unreadable;
 * - `other-pid-namespace`: written in another PID namespace (container) of this machine;
 * - `writer-running`: its process still runs, or could not be signalled.
 */
export type AgentHomeLeaseWriterBlock = 'legacy-marker' | 'unverifiable' | 'other-host' | 'other-pid-namespace' | 'writer-running';

export type AgentHomeLeaseWriterVerdict =
  | { readonly gone: true }
  | { readonly gone: false; readonly blockedBy: AgentHomeLeaseWriterBlock };

/** The platform reads behind a verdict. Each resolves `undefined` when it cannot read; none rejects. */
export interface AgentHomeLeaseWriterProbe {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  host(): Promise<string | undefined>;
  boot(): Promise<string | undefined>;
  pidNamespace(): Promise<string | undefined>;
  /** `null` when no process has `pid`. */
  processStart(pid: number): Promise<string | null | undefined>;
  /** `kill(pid, 0)`: only ESRCH is `gone`. */
  signal(pid: number): 'exists' | 'gone' | 'denied';
}

const COMMAND_TIMEOUT_MS = 2_000;
const IDENTITY_MAX_LENGTH = 128;

function identity(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/gu, ' ');
  return trimmed === undefined || trimmed.length === 0 || trimmed.length > IDENTITY_MAX_LENGTH ? undefined : trimmed;
}

async function command(executable: string, args: readonly string[]): Promise<{ exitCode: number | null; stdout: string } | undefined> {
  try {
    return await runDeviceCommand(executable, args, undefined, AbortSignal.timeout(COMMAND_TIMEOUT_MS));
  } catch {
    return undefined;
  }
}

async function powershell(script: string): Promise<string | undefined> {
  const result = await command('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return result?.exitCode === 0 ? result.stdout : undefined;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

const systemProbe: AgentHomeLeaseWriterProbe = {
  platform: process.platform,
  pid: process.pid,
  async host() {
    return resolveMachineId({ productId: 'byok-agent-home-lease-writer' });
  },
  async boot() {
    if (this.platform === 'linux') return identity(await readText('/proc/sys/kernel/random/boot_id'));
    if (this.platform === 'win32') {
      const seconds = identity(await powershell('[math]::Round([DateTimeOffset]::new((Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds() / 1000)'));
      return seconds !== undefined && /^\d+$/u.test(seconds) ? seconds : undefined;
    }
    const result = await command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
    return result?.exitCode === 0 ? identity(result.stdout) : undefined;
  },
  async pidNamespace() {
    try {
      return identity(await fs.readlink('/proc/self/ns/pid'));
    } catch {
      return undefined;
    }
  },
  async processStart(pid) {
    if (this.platform === 'linux') {
      let stat: string;
      try {
        stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
      }
      // Field 22, counted after the parenthesized command name, which may hold spaces.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return start !== undefined && /^\d+$/u.test(start) ? start : undefined;
    }
    if (this.platform === 'win32') {
      const out = identity(await powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks } else { 'none' }`));
      if (out === 'none') return null;
      return out !== undefined && /^\d+$/u.test(out) ? out : undefined;
    }
    const result = await command('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    if (result === undefined) return undefined;
    const start = identity(result.stdout);
    if (result.exitCode === 0) return start;
    return result.exitCode === 1 && start === undefined ? null : undefined;
  },
  signal(pid) {
    try {
      process.kill(pid, 0);
      return 'exists';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'denied';
    }
  },
};

interface LocalIdentity {
  readonly host?: string;
  readonly boot?: string;
  readonly pidNamespace?: string;
  /** `null` when any part of this process's identity is unreadable: its files then hold no provable writer. */
  readonly writer: AgentHomeLeaseWriter | null;
}

interface WriterState {
  probe?: AgentHomeLeaseWriterProbe;
  local?: Promise<LocalIdentity>;
}

/**
 * Process-wide, so every loaded copy of the SDK reads this process's identity
 * once and judges with the same probe. Created on first use.
 */
function writerState(): WriterState {
  const processWide = globalThis as Record<symbol, WriterState | undefined>;
  return processWide[Symbol.for('@byok-sdk/client:agent-home-lease-writer')] ??= {};
}

function probe(): AgentHomeLeaseWriterProbe {
  return writerState().probe ?? systemProbe;
}

async function readLocalIdentity(reads: AgentHomeLeaseWriterProbe): Promise<LocalIdentity> {
  const [host, boot, pidNamespace, start] = await Promise.all([
    reads.host(),
    reads.boot(),
    reads.platform === 'linux' ? reads.pidNamespace() : Promise.resolve(undefined),
    reads.processStart(reads.pid),
  ]);
  const complete = host !== undefined && boot !== undefined && typeof start === 'string' &&
    (reads.platform !== 'linux' || pidNamespace !== undefined);
  return {
    host, boot, pidNamespace,
    writer: complete ? { pid: reads.pid, start, host, boot, ...(pidNamespace === undefined ? {} : { pidNamespace }) } : null,
  };
}

function localIdentity(): Promise<LocalIdentity> {
  const state = writerState();
  return state.local ??= readLocalIdentity(probe());
}

/** This process as the writer of a lease file, or `null` when its identity cannot be read. */
export async function currentAgentHomeLeaseWriter(): Promise<AgentHomeLeaseWriter | null> {
  return (await localIdentity()).writer;
}

function blocked(blockedBy: AgentHomeLeaseWriterBlock): AgentHomeLeaseWriterVerdict {
  return { gone: false, blockedBy };
}

/**
 * Whether the writer of a lease file is proved gone. `undefined` is a file
 * that records no writer, `null` one whose writer could not identify itself.
 * Gone means: the same host and PID namespace, and either a later boot, or no
 * process with that pid, or a process with that pid and another start time.
 */
export async function judgeAgentHomeLeaseWriter(writer: AgentHomeLeaseWriter | null | undefined): Promise<AgentHomeLeaseWriterVerdict> {
  if (writer === undefined) return blocked('legacy-marker');
  if (writer === null) return blocked('unverifiable');
  const reads = probe();
  const local = await localIdentity();
  if (local.host === undefined || writer.host !== local.host) return blocked('other-host');
  if ((reads.platform === 'linux' && local.pidNamespace === undefined) || writer.pidNamespace !== local.pidNamespace) {
    return blocked('other-pid-namespace');
  }
  if (local.boot === undefined) return blocked('unverifiable');
  if (writer.boot !== local.boot) return { gone: true };
  const signal = reads.signal(writer.pid);
  if (signal === 'gone') return { gone: true };
  if (signal === 'denied') return blocked('writer-running');
  const start = await reads.processStart(writer.pid);
  if (start === null) return { gone: true };
  if (start === undefined) return blocked('unverifiable');
  return start === writer.start ? blocked('writer-running') : { gone: true };
}

/** Parse the recorded writer of a lease file; `undefined` when `value` is not one. */
export function parseAgentHomeLeaseWriter(value: unknown): AgentHomeLeaseWriter | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { pid, start, host, boot, pidNamespace } = value as Record<string, unknown>;
  const text = (field: unknown): field is string => typeof field === 'string' && identity(field) === field;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (!text(start) || !text(host) || !text(boot) || (pidNamespace !== undefined && !text(pidNamespace))) return undefined;
  return { pid, start, host, boot, ...(pidNamespace === undefined ? {} : { pidNamespace }) };
}

/** Internal test seam: judge with `reads` instead of the system; `undefined` restores it. Not exported from the package entry. */
export function setAgentHomeLeaseWriterProbeForTests(reads: AgentHomeLeaseWriterProbe | undefined): void {
  const state = writerState();
  state.probe = reads;
  state.local = undefined;
}
