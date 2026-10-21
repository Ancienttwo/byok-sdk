import { expect, it, vi } from 'vitest';
import { openHost } from './test-support';

const hints = vi.hoisted(() => ({ dropped: 0 }));
vi.mock('@byok-sdk/cloud', async importOriginal => {
  const actual = await importOriginal<typeof import('@byok-sdk/cloud')>();
  return { ...actual, createInProcessMailboxWake: (...args: Parameters<typeof actual.createInProcessMailboxWake>) => {
    const wake = actual.createInProcessMailboxWake(...args);
    return { ...wake, appended() { hints.dropped++; } };
  } };
});

it('runs a real Host execution after mailbox wake hints are lost', async () => {
  const fixture = await openHost();
  try {
    const intent = await fixture.core.enqueue(fixture.intent('lost-wake-hints'));
    await vi.waitFor(() => expect(fixture.adapter.sessions.has(intent.taskId)).toBe(true), { timeout: 5000 });
    fixture.adapter.sessions.get(intent.taskId)!.finish({ text: 'Durable mailbox delivery succeeded.' });
    await vi.waitFor(async () => {
      await fixture.core.drain();
      expect(fixture.core.intent(intent.key)?.conclusion).toBe('succeeded');
    }, { timeout: 5000 });
    expect(hints.dropped).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});
