import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { RuntimeDisposalFailure } from '../runtime-failure';

const DEFAULT_TERM_GRACE_MS = 750;
const DEFAULT_KILL_GRACE_MS = 2_000;
const POLL_MS = 20;
const terminationRequested = new WeakSet<ChildProcess>();

export interface OwnedProcessTreeOptions {
  child: ChildProcess;
  waitClosed: () => Promise<void>;
  isClosed: () => boolean;
  label: string;
  termGraceMs?: number;
  killGraceMs?: number;
}

/**
 * Every bundled runtime root is an owned process-group leader on POSIX. Pipes
 * remain referenced, so `detached` changes ownership topology without making
 * the runtime outlive the daemon. Windows uses taskkill's `/T` tree authority.
 */
export function withOwnedProcessTree<T extends SpawnOptions>(options: T): T {
  return {
    ...options,
    ...(process.platform === 'win32' ? { windowsHide: true } : { detached: true }),
  };
}

function positivePid(child: ChildProcess, label: string): number | undefined {
  const pid = child.pid;
  if (pid === undefined) return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new RuntimeDisposalFailure({
      stage: 'signal',
      reason: `${label} runtime process has an unsafe owned pid`,
    });
  }
  return pid;
}

function groupExists(pid: number, label: string): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${label} runtime process-group state could not be verified`,
    }, { cause });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, label: string): void {
  try {
    process.kill(-pid, signal);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // macOS can transiently report EPERM for an orphaned group containing
    // only processes already exiting. It is not success: the quiescence
    // poll below must still prove the group disappears before close settles.
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw new RuntimeDisposalFailure({
      stage: 'signal',
      reason: `${label} runtime process group ${pid} could not receive ${signal} (${code ?? 'unknown'})`,
    }, { cause });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return true;
}

async function waitWithDeadline(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    void promise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      },
    );
  });
}

/** Immediate termination request used by interrupt paths; close remains the receipt. */
export function requestOwnedProcessTreeTermination(options: OwnedProcessTreeOptions): void {
  if (options.isClosed()) return;
  const pid = positivePid(options.child, options.label);
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    if (result.error || (result.status !== 0 && !options.isClosed())) {
      throw new RuntimeDisposalFailure({
        stage: 'signal',
        reason: `${options.label} runtime process tree could not be terminated`,
      }, { cause: result.error });
    }
    terminationRequested.add(options.child);
    return;
  }
  signalGroup(pid, 'SIGTERM', options.label);
  terminationRequested.add(options.child);
}

/** Resolve only after the adapter-owned root and descendants are quiescent. */
export async function disposeOwnedProcessTree(options: OwnedProcessTreeOptions): Promise<void> {
  const pid = positivePid(options.child, options.label);
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  if (pid === undefined) {
    if (await waitWithDeadline(options.waitClosed(), killGraceMs)) return;
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime process did not settle after spawn failure`,
    });
  }

  if (process.platform === 'win32') {
    if (!options.isClosed() && !terminationRequested.has(options.child)) requestOwnedProcessTreeTermination(options);
    if (await waitWithDeadline(options.waitClosed(), killGraceMs)) return;
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime process tree did not close before the disposal deadline`,
    });
  }

  if (groupExists(pid, options.label) && !terminationRequested.has(options.child)) {
    signalGroup(pid, 'SIGTERM', options.label);
    terminationRequested.add(options.child);
  }
  if (!(await waitUntil(() => groupExists(pid, options.label), termGraceMs))) {
    signalGroup(pid, 'SIGKILL', options.label);
    if (!(await waitUntil(() => groupExists(pid, options.label), killGraceMs))) {
      throw new RuntimeDisposalFailure({
        stage: 'quiescence',
        reason: `${options.label} runtime process group remained live after SIGKILL`,
      });
    }
  }
  if (!(await waitWithDeadline(options.waitClosed(), killGraceMs))) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime root did not emit close after its process group exited`,
    });
  }
}
