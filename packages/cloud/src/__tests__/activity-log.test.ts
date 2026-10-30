import { createMutableClock } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { activityEntryBytes, createActivityEntry, MAX_ACTIVITY_BYTES, type ActivityAppendInput } from '../activity';
import { InMemoryActivityStore, deleteActivityTail } from '../stores/in-memory/activity';
import { createHarness, grantAgentHome, offerPayload, TENANT_A, TEST_AGENT_REF } from './support/harness';

const input = (n: number): ActivityAppendInput => ({ taskId: 'task', sourceEnvelopeId: `e-${n}`, batchSeq: n, events: [{ type: 'progress', text: 'x' }], dropped: 0, ttlMs: 600_000 });

describe('activity log bounds and authority', () => {
  it('enforces the 1000-entry maximum and exposes the exact evicted floor', async () => {
    const store = new InMemoryActivityStore(createMutableClock());
    for (let i = 0; i <= 1000; i++) await store.append(TENANT_A, input(i));
    const tail = (await store.read(TENANT_A, 'task'))!;
    expect(tail.entries).toHaveLength(1000);
    expect(tail).toMatchObject({ floor: 1, dropped: 1, capacity: 1000, byteCapacity: MAX_ACTIVITY_BYTES });
    expect(tail.retainedBytes).toBe(tail.entries.reduce((sum, entry) => sum + activityEntryBytes(entry), 0));
  });
  it('accepts the exact serialized cap and atomically rejects one byte over it', async () => {
    const clock = createMutableClock();
    const store = new InMemoryActivityStore(clock);
    const template = input(1);
    const overhead = activityEntryBytes(createActivityEntry(template, 1, clock.now().toISOString()));
    const exact = { ...template, events: [{ type: 'progress', text: 'x'.repeat(MAX_ACTIVITY_BYTES - overhead + 1) }] };
    const tooLarge = { ...exact, events: [{ type: 'progress', text: 'x'.repeat(MAX_ACTIVITY_BYTES - overhead + 2) }] };
    await expect(store.append(TENANT_A, tooLarge)).rejects.toMatchObject({ code: 'activity_batch_too_large' });
    expect(await store.read(TENANT_A, 'task')).toBeUndefined();
    const tail = await store.append(TENANT_A, exact);
    expect(tail).toMatchObject({ retainedBytes: MAX_ACTIVITY_BYTES, cursor: { revision: 1 } });
    await expect(store.append(TENANT_A, { ...tooLarge, sourceEnvelopeId: 'e-2' })).rejects.toMatchObject({ code: 'activity_batch_too_large' });
    expect(await store.read(TENANT_A, 'task')).toEqual(tail);
  });
  it('evicts by serialized bytes even below the entry limit', async () => {
    const clock = createMutableClock();
    const store = new InMemoryActivityStore(clock);
    const bytes = activityEntryBytes(createActivityEntry(input(1), 1, clock.now().toISOString()));
    await store.append(TENANT_A, { ...input(1), byteCapacity: bytes });
    const tail = await store.append(TENANT_A, { ...input(2), byteCapacity: bytes });
    expect(tail).toMatchObject({ floor: 1, dropped: 1, retainedBytes: bytes });
    expect(tail.entries.map(entry => entry.sourceEnvelopeId)).toEqual(['e-2']);
  });
  it('retains a removal fence and does not expose mutable stored data', async () => {
    const store = new InMemoryActivityStore(createMutableClock());
    const first = await store.append(TENANT_A, input(1));
    (first.entries as unknown[]).pop();
    expect((await store.read(TENANT_A, 'task'))?.entries).toHaveLength(1);
    expect(deleteActivityTail(store, TENANT_A, 'task')).toBe(1);
    expect(await store.read(TENANT_A, 'task')).toBeUndefined();
    await expect(store.append(TENANT_A, input(1))).rejects.toMatchObject({ code: 'activity_history_gap' });
  });
  it('settlement racing a hashing append leaves no event beyond the final watermark', async () => {
    const clock = createMutableClock();
    const store = new InMemoryActivityStore(clock);
    const append = store.append(TENANT_A, input(1));
    const final = await store.settle(TENANT_A, 'task', clock.now().toISOString());
    await expect(append).rejects.toMatchObject({ code: 'activity_task_settled' });
    expect(final.cursor.revision).toBe(0);
    expect((await store.read(TENANT_A, 'task'))?.entries).toEqual([]);
  });
  it('records admitted plaintext artifacts and exposes the same revision through cloud reads', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { taskId: 'artifact-task', payload: offerPayload('work') });
    const artifact = { name: 'report', contentType: 'text/plain', inline: 'result' };
    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId: 'artifact-task' });
    const output = createEnvelope('task.artifact', artifact, { taskId: 'artifact-task' });
    const result = await harness.json('/byok/messages', { method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [claim, output] }) });
    expect(result).toMatchObject({ status: 200, body: { accepted: 2 } });
    const tail = (await harness.cloud.readActivity(TENANT_A, 'artifact-task'))!;
    expect(tail.entries).toEqual([{ taskId: 'artifact-task', sourceEnvelopeId: output.id, kind: 'artifact', artifact, revision: 1, receivedAt: expect.any(String) }]);
    expect((await harness.cloud.readActivity(TENANT_A, 'artifact-task', { after: tail.cursor }))?.entries).toEqual([]);
  });
});
