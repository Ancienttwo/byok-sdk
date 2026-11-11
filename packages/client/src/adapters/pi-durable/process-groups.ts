import { processSignalState, readProcessGroupRows as rows } from '../../util/process-signal-state.js';
import { RuntimeDisposalFailure } from '../../runtime-failure.js';
export function assertDurableShellOwner(pid: number, worker: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('invalid durable shell pid');
  const row = rows().find(([id]) => Number(id) === pid);
  if (!row || Number(row[1]) !== worker || Number(row[2]) !== pid || row[3]!.startsWith('Z')) throw new Error('durable shell is not a live worker-owned group');
}
export async function disposeDurableShellGroups(groups: Set<number>): Promise<void> {
  const refused = new Map<number, unknown>();
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) {
      const state = processSignalState(error);
      if (state === 'unknown') throw new RuntimeDisposalFailure({stage:'signal',reason:'durable shell group signal failed'});
      if (state === 'live') refused.set(pid, error);
    }
  }
  const deadline = Date.now() + 2_000;
  while (groups.size) {
    let snapshot: string[][];
    try { snapshot = rows(); } catch { throw new RuntimeDisposalFailure({stage:'quiescence',reason:'durable shell group snapshot unavailable'}); }
    for (const pid of groups) {
      const error = refused.get(pid);
      const gone = error === undefined
        ? !snapshot.some(row => Number(row[2]) === pid && !row[3]!.startsWith('Z'))
        : processSignalState(error, pid, () => snapshot) === 'gone';
      if (gone) groups.delete(pid);
    }
    if (!groups.size) return;
    if (Date.now() >= deadline) {
      if ([...groups].some(pid => refused.has(pid))) throw new RuntimeDisposalFailure({stage:'signal',reason:'durable shell group signal refused (EPERM) and live members remain'});
      throw new RuntimeDisposalFailure({stage:'quiescence',reason:'durable shell groups did not quiesce'});
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
