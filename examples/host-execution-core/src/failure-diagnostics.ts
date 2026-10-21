import { setTimeout, clearTimeout } from 'node:timers';
import type { TestHost } from './test-support';

/** Diagnostics never change the observation's deadline or replace its error. */
export async function withFailureSnapshot<T>(observation: Promise<T>, snapshot: () => unknown | Promise<unknown>): Promise<T> {
  try { return await observation; }
  catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([
        Promise.resolve().then(snapshot).catch(() => ({ unavailable: 'snapshot-failed' })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'snapshot-deadline' }), 250); }),
      ]);
      console.error('[host-wait-failure]', JSON.stringify(state));
    } catch { /* Diagnostic collection/output cannot replace the original assertion. */ }
    finally { clearTimeout(timer); }
    throw error;
  }
}

/** Explicit scalar allowlist: no task payload, result text, credentials or error messages. */
export async function hostFailureSnapshot(host: TestHost, key: string): Promise<unknown> {
  const intent = host.core.intent(key);
  const status = host.daemon.status();
  const taskId = intent?.taskId;
  const exists = async (read: () => Promise<unknown>) => {
    try { return (await read()) !== undefined; } catch { return 'unavailable'; }
  };
  const [offer, attempt, deviceTerminal] = taskId ? await Promise.all([
    exists(() => host.server.tasks.offer(taskId)),
    exists(() => host.server.tasks.attempt(taskId)),
    exists(() => host.server.tasks.deviceTerminal(taskId)),
  ]) : ['unavailable', 'unavailable', 'unavailable'];
  return {
    intent: intent ? { key: intent.key, phase: intent.phase, generation: intent.generation,
      taskId, attempts: intent.attempts, conclusion: intent.conclusion ?? null } : { key, unavailable: true },
    server: { offer, attempt, deviceTerminal },
    daemon: { phase: status.lifecycle.phase, connection: 'connection' in status.lifecycle ? status.lifecycle.connection : 'unavailable', activeTaskCount: status.activeTaskCount },
    sessionPresent: taskId ? host.adapter.sessions.has(taskId) : 'unavailable',
  };
}
