import { execFileSync } from 'node:child_process';
import { RuntimeDisposalFailure } from '../../runtime-failure';

function rows(): string[][] {
  const result=execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/u));
  if(!result.some(([pid])=>Number(pid)===process.pid)||result.some(row=>row.length!==4||row.slice(0,3).some(value=>!Number.isSafeInteger(Number(value))||Number(value)<0)||!row[3]))throw new Error('invalid durable process snapshot');
  return result;
}
export function assertDurableShellOwner(pid: number, worker: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('invalid durable shell pid');
  const row = rows().find(([id]) => Number(id) === pid);
  if (!row || Number(row[1]) !== worker || Number(row[2]) !== pid || row[3]!.startsWith('Z')) throw new Error('durable shell is not a live worker-owned group');
}
export async function disposeDurableShellGroups(groups: Set<number>): Promise<void> {
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new RuntimeDisposalFailure({stage:'signal',reason:'durable shell group signal failed'}); }
  }
  const deadline = Date.now() + 2_000;
  while (groups.size) {
    let live:Set<number>;
    try{live=new Set(rows().filter(row => !row[3]!.startsWith('Z')).map(row => Number(row[2])));}catch{throw new RuntimeDisposalFailure({stage:'quiescence',reason:'durable shell group snapshot unavailable'});}
    for (const pid of groups) if (!live.has(pid)) groups.delete(pid);
    if (!groups.size) return;
    if (Date.now() >= deadline) throw new RuntimeDisposalFailure({stage:'quiescence',reason:'durable shell groups did not quiesce'});
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
