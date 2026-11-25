import { observeOwnedProcessTable } from '../../adapters/process-tree';
import type { ProcessEntry } from '../../runtime/oar-process-tree';

export type ProcessIdentity = Readonly<Pick<ProcessEntry, 'pid'> & Partial<Pick<ProcessEntry, 'start'>>>;

function readProcess(pid: number): ProcessEntry | undefined {
  const { table, unreadable } = observeOwnedProcessTable();
  if (unreadable?.has(pid)) throw new Error(`Cannot confirm liveness of pid=${pid}: process identity is unreadable`);
  return table.get(pid);
}

/** Capture while the fixture still owns the PID. Windows uses signal 0 for liveness. */
export function captureProcessIdentity(pid: number): ProcessIdentity {
  const identity = tryCaptureProcessIdentity(pid);
  if (identity === undefined) throw new Error(`Cannot capture process identity: pid=${pid} is missing`);
  return identity;
}

/** Allow a PID from an earlier process snapshot to have exited before capture. */
export function tryCaptureProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process pid=${pid}`);
  if (process.platform === 'win32') return { pid };
  const entry = readProcess(pid);
  return entry === undefined ? undefined : { pid, start: entry.start };
}

function liveProcess(processOrPid: ProcessIdentity | number): ProcessIdentity | ProcessEntry | undefined {
  const { pid, start } = typeof processOrPid === 'number' ? { pid: processOrPid } : processOrPid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process pid=${pid}`);
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    }
    return { pid };
  }

  const entry = readProcess(pid);
  if (entry === undefined || (start !== undefined && entry.start !== start) || entry.zombie === true) return undefined;
  return entry;
}

export function isProcessLive(processOrPid: ProcessIdentity | number): boolean {
  return liveProcess(processOrPid) !== undefined;
}

export function expectProcessNotLive(processOrPid: ProcessIdentity | number): void {
  const entry = liveProcess(processOrPid);
  if (entry === undefined) return;
  const details = 'ppid' in entry ? ` ppid=${entry.ppid} pgid=${entry.pgid} start=${entry.start}` : '';
  throw new Error(`Process still live: pid=${entry.pid}${details}`);
}
