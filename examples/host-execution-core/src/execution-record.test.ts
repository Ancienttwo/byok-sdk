import { afterEach, expect, it, vi } from 'vitest';
import { freezeRuntimeAdapterDescriptor, type DaemonEvent } from '@byok-sdk/client';
import { BotStubAdapter } from '../../basic/goal-btw.test-support';
import { taskId } from '@byok-sdk/server/execution-core';
import { openHost, type TestHost } from './test-support';

let host: TestHost;
afterEach(async () => { await host?.close(); });

/** The stub declares no evidence source; this one declares Pi's, so a run can be recorded as partial. */
function declaringAdapter(): BotStubAdapter {
  const adapter = new BotStubAdapter();
  return Object.assign(adapter, { descriptor: freezeRuntimeAdapterDescriptor({ ...adapter.descriptor, trajectoryEvidence: 'event-stream' }) });
}

async function running(key: string) {
  await vi.waitFor(() => expect(host.adapter.sessions.has(host.core.intent(key)!.taskId)).toBe(true), { timeout: 5000 });
  return host.adapter.sessions.get(host.core.intent(key)!.taskId)!;
}

async function settled(key: string) {
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(key)?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
}

it('concludes a partial-trajectory run like a complete one, applies its outcome once and never retries it', async () => {
  host = await openHost({
    adapter: declaringAdapter(),
    applyOutcome: (document, tx) => { tx.application[(document as { text: string }).text] = document as { text: string }; },
  });
  const records: Array<Extract<DaemonEvent, { kind: 'execution-record' }>> = [];
  host.daemon.subscribe(event => { if (event.kind === 'execution-record') records.push(event); });
  // A source policy that retries failures: a partial record must still not cause one.
  const retry = { maxAttempts: 3, delaysMs: [20, 20], retryFailures: true };

  await host.core.enqueue(host.intent('paired', { retry }));
  const paired = await running('paired');
  paired.emit({ type: 'tool_use', tool: 'bash', toolCallId: 'call-a' });
  paired.emit({ type: 'tool_result', tool: 'bash', toolCallId: 'call-a', isError: false });
  paired.finish({ text: 'paired' });
  await settled('paired');

  await host.core.enqueue(host.intent('unpaired', { retry }));
  const unpaired = await running('unpaired');
  unpaired.emit({ type: 'tool_use', tool: 'bash', toolCallId: 'call-b' });
  unpaired.finish({ text: 'unpaired' });
  await settled('unpaired');

  await vi.waitFor(() => expect(records.map(record => [record.taskId, record.terminal, record.status])).toEqual([
    [taskId('paired', 0), 'complete', 'complete'],
    [taskId('unpaired', 0), 'complete', 'partial'],
  ]));
  expect(records[1]!.gaps).toEqual([{ reason: 'unpaired_tool_call', count: 1 }]);
  for (const key of ['paired', 'unpaired']) {
    expect(host.core.intent(key)).toMatchObject({ conclusion: 'succeeded', attempts: 1, generation: 0 });
    expect(await host.server.tasks.deviceTerminal(taskId(key, 0))).toMatchObject({ envelope: { type: 'task.complete' } });
  }
  expect(host.ledger.snapshot().application).toEqual({ paired: { text: 'paired' }, unpaired: { text: 'unpaired' } });
  expect(Object.keys(host.ledger.snapshot().applied).sort()).toEqual([taskId('paired', 0), taskId('unpaired', 0)].sort());
  expect(host.adapter.starts.map(start => start.manifest.taskId)).toEqual([taskId('paired', 0), taskId('unpaired', 0)]);
});
