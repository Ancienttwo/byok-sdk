import { expect, it, vi } from 'vitest';
import { hostFailureSnapshot } from './failure-diagnostics';
import { openHost, template } from './test-support';

it('distinguishes the second Agent held in preparation after both offers are delivered', async () => {
  const host = await openHost();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let secondEntered = false;
  const prepare = host.adapter.prepare.bind(host.adapter);
  const spy = vi.spyOn(host.adapter, 'prepare').mockImplementation(async input => {
    // Strict Agent offers retain this identity, although the public prepare type is the legacy offer shape.
    const agentRef = (input.offer as { agentRef?: { agentId: string } }).agentRef;
    if (agentRef?.agentId === 'other-agent') { secondEntered = true; await held; }
    return prepare(input);
  });
  try {
    await host.core.addRoutine(host.routine('far', { rule: { anchorMs: Date.now() + 400 * 86_400_000, everyMs: 86_400_000 } }));
    const first = await host.core.enqueue(host.intent('bot-after-far'));
    const second = await host.core.enqueue(host.intent('other-after-far', { execution: template(host.deviceId, 'other-agent') }));
    expect(await host.server.tasks.offer(first.taskId)).toMatchObject({ delivered: true });
    expect(await host.server.tasks.offer(second.taskId)).toMatchObject({ delivered: true });
    await vi.waitFor(() => {
      expect(secondEntered).toBe(true);
      expect(host.adapter.sessions.has(first.taskId)).toBe(true);
    });
    expect(host.adapter.starts).toHaveLength(1);
    expect(await hostFailureSnapshot(host, 'bot-after-far')).toMatchObject({
      intent: { taskId: first.taskId }, sessionPresent: true,
    });
    expect(await hostFailureSnapshot(host, 'other-after-far')).toMatchObject({
      intent: { taskId: second.taskId }, server: { offer: true, attemptStatus: 'offered', ownerPresent: false, deviceTerminal: false },
      localTask: { state: 'Offered' }, sessionPresent: false,
    });
    release();
    // Retain the original assertion and its default one-second observation window.
    await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(2));
    expect(host.adapter.sessions.has(second.taskId)).toBe(true);
  } finally { release(); try { await host.close(); } finally { spy.mockRestore(); } }
});
