/**
 * #980 phase instants beyond the store conformance suite: an in-memory attempt
 * stored before the fields existed, and the inbound gate's own output rule.
 */
import { createMutableClock, tenantKey, type TenantId } from '@byok-sdk/core';
import { createEnvelope, type Envelope, type MessageType } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { InMemoryTaskAttemptState, InMemoryTaskAttemptStore } from '../stores/in-memory/task-attempts';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, createHarness, offerPayload } from './support/harness';

describe('task attempt phase instants (#980)', () => {
  it('reads an attempt stored before the fields with none, and stamps only later transitions', async () => {
    const clock = createMutableClock(new Date('2026-10-27T00:00:00.000Z'));
    const state = new InMemoryTaskAttemptState(clock);
    state.attempts.set(tenantKey(TENANT_A, 'old'), {
      tenantId: TENANT_A, taskId: 'old', deviceId: 'device-1', status: 'offered', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const store = new InMemoryTaskAttemptStore(clock, state);
    const old = await store.get(TENANT_A, 'old');
    for (const field of ['offeredAt', 'claimedAt', 'firstOutputAt', 'terminalAt']) expect(old).not.toHaveProperty(field);
    const claimed = await store.claim(TENANT_A, { taskId: 'old', deviceId: 'device-1' });
    expect(claimed).toMatchObject({ claimedAt: '2026-10-27T00:00:00.000Z' });
    expect(claimed).not.toHaveProperty('offeredAt');
  });

  it('does not count task.progress as output', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const taskId = 'progress-is-not-output';
    await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { taskId, payload: offerPayload() });
    const stores = tenantStoresFor(
      { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId: device.deviceId },
      { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
    );
    const send = (type: MessageType, payload: object) =>
      handleInboundEnvelope(stores, device.deviceId, createEnvelope(type as Envelope['type'], payload as never, { taskId }) as Envelope);
    expect(await send('task.claim', { deviceId: device.deviceId })).toEqual({ outcome: 'accepted' });
    expect(await send('task.started', {})).toEqual({ outcome: 'accepted' });
    expect(await send('task.progress', { seq: 1, events: [{ type: 'progress', text: 'working' }] })).toEqual({ outcome: 'accepted' });
    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, taskId);
    expect(attempt).toMatchObject({ status: 'running', offeredAt: expect.any(String), claimedAt: expect.any(String) });
    expect(attempt).not.toHaveProperty('firstOutputAt');
  });
});
