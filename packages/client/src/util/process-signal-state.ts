import { execFileSync } from 'node:child_process';
import { RuntimeDisposalFailure } from '../runtime-failure.js';

/** A validated POSIX snapshot shared by owned-group signal and quiescence checks. */
export function readProcessGroupRows(): string[][] {
  const result = execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/u));
  if (!result.some(([pid]) => Number(pid) === process.pid) || result.some(row => row.length !== 4 || row.slice(0, 3).some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 0) || !row[3])) throw new Error('invalid process group snapshot');
  return result;
}

/** Supply a group only when spawn/adoption established ownership; a single pid gets no EPERM exception. */
export function processSignalState(error: unknown, ownedGroup?: number, snapshot = readProcessGroupRows): 'gone' | 'live' | 'unknown' {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return 'gone';
  if (code !== 'EPERM') return 'unknown';
  if (ownedGroup === undefined) return 'live';
  try {
    return snapshot().some(row => Number(row[2]) === ownedGroup && !row[3]!.startsWith('Z')) ? 'live' : 'gone';
  } catch (cause) {
    throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: `owned process group ${ownedGroup} snapshot unavailable after EPERM` }, { cause });
  }
}
