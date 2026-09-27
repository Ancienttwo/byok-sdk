import { PROVIDER_PROVISIONING_CAPABILITY, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import type { ProviderProvisioningNoticeInput } from '../index';
import { TENANT_A, TENANT_B, createHarness } from './support/harness';

const REQUEST_A = '40000000-0000-4000-8000-000000000001';
const REQUEST_B = '40000000-0000-4000-8000-000000000002';
const CIPHERTEXT_CANARY = 'CANARY-SEALED-CIPHERTEXT-cloud-5d1e';

async function admit(harness: ReturnType<typeof createHarness>, tenant: typeof TENANT_A, deviceId: string): Promise<void> {
  await harness.stores.devices.recordCapabilities(tenant, {
    deviceId,
    capabilities: [PROVIDER_PROVISIONING_CAPABILITY],
  });
}

async function rows(harness: ReturnType<typeof createHarness>, tenant: typeof TENANT_A, deviceId: string) {
  return (await harness.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages;
}

describe('enqueueProviderProvisioningNotice', () => {
  it('refuses a device that did not advertise provider-provisioning.v1 before any mailbox row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract', 'agent-home-projection'],
    });

    await expect(
      harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, { requestId: REQUEST_A }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });

  it('refuses an unknown device', async () => {
    const harness = createHarness();
    await expect(
      harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, 'device-unknown', { requestId: REQUEST_A }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
  });

  it('appends exactly one strict { requestId } notice with a required seq and no task id', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    const enqueued = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, {
      requestId: REQUEST_A,
    });
    expect(enqueued.seq).toBe(1);
    expect(enqueued.envelope).toMatchObject({ type: 'provider.provisioning.available', seq: 1, payload: { requestId: REQUEST_A } });
    expect(enqueued.envelope.task_id).toBeUndefined();

    const stored = await rows(harness, TENANT_A, device.deviceId);
    expect(stored).toHaveLength(1);
    const envelope = decodeEnvelope(stored[0]!.body);
    expect(envelope).toEqual(enqueued.envelope);
    if (envelope.type !== 'provider.provisioning.available') throw new Error('unreachable');
    expect(Object.keys(envelope.payload)).toEqual(['requestId']);
    expect(JSON.parse(stored[0]!.body).payload).toEqual({ requestId: REQUEST_A });
  });

  it('replays the same request to the same row and seq; a new request gets a new row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    const first = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, { requestId: REQUEST_A });
    const replay = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, { requestId: REQUEST_A });
    expect(replay).toEqual(first);
    expect(await rows(harness, TENANT_A, device.deviceId)).toHaveLength(1);

    const second = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, { requestId: REQUEST_B });
    expect(second.seq).toBe(2);
    expect(second.envelope.id).not.toBe(first.envelope.id);
    expect(await rows(harness, TENANT_A, device.deviceId)).toHaveLength(2);
  });

  it('derives the message identity from tenant and device as well as the request', async () => {
    const harness = createHarness();
    const deviceA = await harness.pairDevice(TENANT_A);
    const deviceB = await harness.pairDevice(TENANT_A);
    const deviceC = await harness.pairDevice(TENANT_B);
    await admit(harness, TENANT_A, deviceA.deviceId);
    await admit(harness, TENANT_A, deviceB.deviceId);
    await admit(harness, TENANT_B, deviceC.deviceId);

    const onA = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, deviceA.deviceId, { requestId: REQUEST_A });
    const onB = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, deviceB.deviceId, { requestId: REQUEST_A });
    const onC = await harness.cloud.enqueueProviderProvisioningNotice(TENANT_B, deviceC.deviceId, { requestId: REQUEST_A });
    expect(new Set([onA.envelope.id, onB.envelope.id, onC.envelope.id]).size).toBe(3);
  });

  it.each([
    ['sealed', { enc: CIPHERTEXT_CANARY, ct: CIPHERTEXT_CANARY }],
    ['ciphertext', CIPHERTEXT_CANARY],
    ['ct', CIPHERTEXT_CANARY],
    ['enc', CIPHERTEXT_CANARY],
    ['config', { operation: 'configure', providerKind: 'zai' }],
    ['aadFields', { keyId: 'k1' }],
    ['secret', CIPHERTEXT_CANARY],
    ['agentId', 'agent-1'],
  ])('refuses a %s field before admission or mailbox allocation', async (field, value) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    await expect(
      harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, {
        requestId: REQUEST_A,
        [field]: value,
      } as unknown as ProviderProvisioningNoticeInput),
    ).rejects.toThrow();
    const stored = await rows(harness, TENANT_A, device.deviceId);
    expect(stored).toEqual([]);
  });

  it('refuses a non-UUID request id even from an unadmitted device, validating before admission', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await expect(
      harness.cloud.enqueueProviderProvisioningNotice(TENANT_A, device.deviceId, { requestId: 'not-a-uuid' }),
    ).rejects.not.toMatchObject({ code: 'agent_capability_missing' });
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });
});
