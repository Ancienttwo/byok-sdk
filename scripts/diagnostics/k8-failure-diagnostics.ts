import { setTimeout, clearTimeout } from 'node:timers';
import type { TestHost } from '../../host-execution-core/src/test-support';
import type { BotCollaboration } from './host';
export type FinishReceipt = { state: 'not-called' | 'pending' | 'resolved' | 'rejected' };
/** Resolution is only a fixture receipt: finish can swallow an error and report it through events. */
export function trackFinishReceipt(receipt: Promise<void>, state: FinishReceipt): void {
  state.state = 'pending';
  void receipt.then(() => { state.state = 'resolved'; }, () => { state.state = 'rejected'; });
}
export async function withK8FailureSnapshot<T>(observation: Promise<T>, collect: () => unknown | Promise<unknown>): Promise<T> {
  try { return await observation; }
  catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        Promise.resolve().then(collect).catch(() => ({ unavailable: 'snapshot-failed' })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'snapshot-deadline' }), 250); }),
      ]);
      console.error('[k8-wait-failure]', JSON.stringify(snapshot));
    } catch { /* Preserve the assertion even if diagnostic output fails. */ }
    finally { clearTimeout(timer); }
    throw error;
  }
}
export async function k8FailureSnapshot(host: TestHost, bot: BotCollaboration, callerId: string,
  predicate: 'session-present' | 'semantic-succeeded', receipt: FinishReceipt) {
  // Bot owns a distinct core. Looking up fixture.core would diagnose the wrong intent.
  const intent = bot.core.intent(callerId);
  const taskId = intent?.taskId;
  const unavailable: string[] = [];
  const read = async <T>(label: string, fn: () => Promise<T>) => { try { return await fn(); } catch { unavailable.push(label); return undefined; } };
  const [offer, attempt, terminal] = taskId ? await Promise.all([
    read('offer', () => host.server.tasks.offer(taskId)), read('attempt', () => host.server.tasks.attempt(taskId)),
    read('terminal', () => host.server.tasks.deviceTerminal(taskId)),
  ]) : [undefined, undefined, undefined];
  const local = host.daemon.tasks().find(task => task.taskId === taskId);
  return { predicate, callerId, unavailable, taskId: taskId ?? null,
    offerType: offer?.type ?? null, attemptStatus: attempt?.status ?? null,
    ownerPresent: attempt?.ownerDeviceId !== undefined, terminalType: terminal?.envelope.type ?? null,
    localTask: local ? { state: local.state, declined: local.declined ?? false, delivery: local.delivery ?? null } : null,
    sessionPresent: taskId ? host.adapter.sessions.has(taskId) : false,
    finishReceipt: receipt.state, turnStatus: bot.snapshot().turns[callerId]?.status ?? null,
  };
}
