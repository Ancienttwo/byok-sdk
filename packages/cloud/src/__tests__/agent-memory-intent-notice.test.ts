import { createHash } from 'node:crypto';

import { AGENT_MEMORY_INTENT_CAPABILITY, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { AgentMemoryIntentNoticeInput } from '../index';
import { uuidFromSha256 } from '../offer-identity';
import { TENANT_A, TENANT_B, createHarness } from './support/harness';

const INTENT_A = '50000000-0000-4000-8000-000000000001';
const INTENT_B = '50000000-0000-4000-8000-000000000002';
const AGENT_REF = { agentId: 'agent-memory', profileRevision: '7' } as const;
const OTHER_AGENT_REF = { agentId: 'agent-memory-other', profileRevision: '7' } as const;
const CONTENT_CANARY = 'CANARY-MEMORY-BODY-cloud-9c4e';
const DIGEST = `sha256:${'a'.repeat(64)}`;

type Harness = ReturnType<typeof createHarness>;

async function admit(harness: Harness, tenant: typeof TENANT_A, deviceId: string): Promise<void> {
  await harness.stores.devices.recordCapabilities(tenant, {
    deviceId,
    capabilities: [AGENT_MEMORY_INTENT_CAPABILITY],
  });
}

async function rows(harness: Harness, tenant: typeof TENANT_A, deviceId: string) {
  return (await harness.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages;
}

/** The single ZodError the strict notice schema throws, before any admission read. */
async function validationError(promise: Promise<unknown>): Promise<ZodError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ZodError);
  return error as ZodError;
}

describe('enqueueAgentMemoryIntentNotice', () => {
  it('refuses a device that did not advertise agent-memory-intent.v1 before any mailbox row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract', 'agent-home-projection', 'provider-provisioning.v1'],
    });

    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });

  it('refuses a paired device with no durable capability snapshot and an unknown device', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);

    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, 'device-unknown', { intentId: INTENT_A, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
  });

  it('refuses a revoked device that had advertised the capability, with zero mailbox rows', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);
    await harness.cloud.revokeDevice(TENANT_A, device.deviceId);

    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });

  it('refuses once a later durable snapshot drops the capability, leaving earlier rows untouched', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);
    const first = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract'],
    });

    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, { intentId: INTENT_B, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    // The retry of an already-appended intent is refused too: admission is a
    // durable read on every call, never a cached earlier decision.
    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    const stored = await rows(harness, TENANT_A, device.deviceId);
    expect(stored).toHaveLength(1);
    expect(decodeEnvelope(stored[0]!.body)).toEqual(first.envelope);
  });

  it('appends exactly one strict { intentId, agentRef } notice with a required seq and no task id', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    const enqueued = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });
    expect(enqueued.seq).toBe(1);
    expect(enqueued.envelope).toMatchObject({
      type: 'agent.memory.intent.available',
      seq: 1,
      payload: { intentId: INTENT_A, agentRef: AGENT_REF },
    });
    expect(enqueued.envelope.task_id).toBeUndefined();

    const stored = await rows(harness, TENANT_A, device.deviceId);
    expect(stored).toHaveLength(1);
    const envelope = decodeEnvelope(stored[0]!.body);
    expect(envelope).toEqual(enqueued.envelope);
    if (envelope.type !== 'agent.memory.intent.available') throw new Error('unreachable');
    expect(Object.keys(envelope.payload).sort()).toEqual(['agentRef', 'intentId']);
    expect(JSON.parse(stored[0]!.body).payload).toEqual({ intentId: INTENT_A, agentRef: AGENT_REF });
  });

  it('derives the message id from the domain, tenant, device and intent id', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    const enqueued = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });
    const expected = uuidFromSha256(
      `sha256:${createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'byok:agent-memory-intent-notice',
            tenant: TENANT_A,
            deviceId: device.deviceId,
            intentId: INTENT_A,
          }),
        )
        .digest('hex')}`,
    );
    expect(enqueued.envelope.id).toBe(expected);
  });

  it('replays the same intent to the same row and seq; a new intent gets a new row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    const first = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });
    const replay = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });
    expect(replay).toEqual(first);
    expect(replay.seq).toBe(1);
    expect(await rows(harness, TENANT_A, device.deviceId)).toHaveLength(1);

    const second = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_B,
      agentRef: AGENT_REF,
    });
    expect(second.seq).toBe(2);
    expect(second.envelope.id).not.toBe(first.envelope.id);
    expect(await rows(harness, TENANT_A, device.deviceId)).toHaveLength(2);
  });

  it.each([
    ['another Agent', OTHER_AGENT_REF],
    ['another profile revision', { agentId: AGENT_REF.agentId, profileRevision: '8' }],
  ])('refuses a retry of the same intent naming %s, keeping the single original row', async (_label, agentRef) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);
    const first = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });

    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, { intentId: INTENT_A, agentRef }),
    ).rejects.toMatchObject({ code: 'mailbox_receipt_mismatch' });
    const stored = await rows(harness, TENANT_A, device.deviceId);
    expect(stored).toHaveLength(1);
    expect(decodeEnvelope(stored[0]!.body)).toEqual(first.envelope);
  });

  it('after acked-row retention cleanup, a re-enqueue appends a new row and compares agentRef only against that new row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);
    const first = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: AGENT_REF,
    });
    await harness.core.mailbox.recordDelivery(TENANT_A, { deviceId: device.deviceId, deliveredSeq: first.seq });
    await harness.core.mailbox.advanceCursor(TENANT_A, { deviceId: device.deviceId, ackedSeq: first.seq });
    const swept = await harness.core.mailbox.collectRetired(TENANT_A, {
      deviceId: device.deviceId,
      ackedBefore: '2999-01-01T00:00:00.000Z',
      expireUnackedBefore: '2999-01-01T00:00:00.000Z',
    });
    expect(swept.deletedCount).toBe(1);
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);

    // The original row is gone, so the derived message id no longer pins an
    // agentRef: a different Agent is accepted and gets a new seq.
    const reEnqueued = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
      intentId: INTENT_A,
      agentRef: OTHER_AGENT_REF,
    });
    expect(reEnqueued.seq).toBeGreaterThan(first.seq);
    expect(reEnqueued.envelope).toMatchObject({ payload: { intentId: INTENT_A, agentRef: OTHER_AGENT_REF } });
    const stored = await rows(harness, TENANT_A, device.deviceId);
    expect(stored).toHaveLength(1);
    expect(decodeEnvelope(stored[0]!.body)).toEqual(reEnqueued.envelope);

    // The retained-row rule applies again, against the new row.
    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
        intentId: INTENT_A,
        agentRef: { agentId: AGENT_REF.agentId, profileRevision: '8' },
      }),
    ).rejects.toMatchObject({ code: 'mailbox_receipt_mismatch' });
    expect(await rows(harness, TENANT_A, device.deviceId)).toHaveLength(1);
  });

  it('isolates tenants and devices: the same intent id is a distinct row per device', async () => {
    const harness = createHarness();
    const deviceA = await harness.pairDevice(TENANT_A);
    const deviceB = await harness.pairDevice(TENANT_A);
    const deviceC = await harness.pairDevice(TENANT_B);
    await admit(harness, TENANT_A, deviceA.deviceId);
    await admit(harness, TENANT_A, deviceB.deviceId);
    await admit(harness, TENANT_B, deviceC.deviceId);

    const onA = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, deviceA.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF });
    const onB = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, deviceB.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF });
    const onC = await harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_B, deviceC.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF });
    expect(new Set([onA.envelope.id, onB.envelope.id, onC.envelope.id]).size).toBe(3);
    expect(await rows(harness, TENANT_A, deviceA.deviceId)).toHaveLength(1);
    expect(await rows(harness, TENANT_A, deviceB.deviceId)).toHaveLength(1);
    expect(await rows(harness, TENANT_B, deviceC.deviceId)).toHaveLength(1);
  });

  it('checks the capability of the addressed tenant, not another tenant with the same device row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);

    await expect(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_B, device.deviceId, { intentId: INTENT_A, agentRef: AGENT_REF }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await rows(harness, TENANT_B, device.deviceId)).toEqual([]);
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });

  it.each([
    ['path', 'notes/host-canary.md'],
    ['operation', 'replace'],
    ['content', CONTENT_CANARY],
    ['baseRevision', DIGEST],
    ['targetRevision', DIGEST],
    ['operationDigest', DIGEST],
    ['approvalRef', 'approval-1'],
    ['tenantId', 'tenant-a'],
    ['deviceId', 'device-a'],
    ['task_id', 'task-1'],
  ])('refuses an extra top-level %s field before admission or mailbox allocation', async (field, value) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    // Deliberately NOT admitted: a capability error here would prove that
    // admission ran before the strict schema.
    const error = await validationError(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
        intentId: INTENT_A,
        agentRef: AGENT_REF,
        [field]: value,
      } as unknown as AgentMemoryIntentNoticeInput),
    );
    expect(error.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: [field], path: [] })]);
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });

  it('refuses an extra field inside agentRef with the agentRef issue path', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admit(harness, TENANT_A, device.deviceId);
    const error = await validationError(
      harness.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, device.deviceId, {
        intentId: INTENT_A,
        agentRef: { ...AGENT_REF, path: 'notes/host-canary.md' },
      } as unknown as AgentMemoryIntentNoticeInput),
    );
    expect(error.issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['path'], path: ['agentRef'] }),
    ]);
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });

  it.each([
    ['missing intentId', { agentRef: AGENT_REF }, ['intentId']],
    ['missing agentRef', { intentId: INTENT_A }, ['agentRef']],
    ['missing agentRef.agentId', { intentId: INTENT_A, agentRef: { profileRevision: '7' } }, ['agentRef', 'agentId']],
    ['missing agentRef.profileRevision', { intentId: INTENT_A, agentRef: { agentId: 'agent-memory' } }, ['agentRef', 'profileRevision']],
    ['non-UUID intentId', { intentId: 'not-a-uuid', agentRef: AGENT_REF }, ['intentId']],
    ['non-canonical profileRevision', { intentId: INTENT_A, agentRef: { agentId: 'agent-memory', profileRevision: '07' } }, ['agentRef', 'profileRevision']],
    ['path-like agentId', { intentId: INTENT_A, agentRef: { agentId: '../agent', profileRevision: '7' } }, ['agentRef', 'agentId']],
  ])('refuses a %s at that exact issue path, before admission', async (_label, input, path) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const error = await validationError(
      harness.cloud.enqueueAgentMemoryIntentNotice(
        TENANT_A,
        device.deviceId,
        input as unknown as AgentMemoryIntentNoticeInput,
      ),
    );
    expect(error.issues.length).toBeGreaterThan(0);
    for (const issue of error.issues) expect(issue.path).toEqual(path);
    expect(await rows(harness, TENANT_A, device.deviceId)).toEqual([]);
  });
});
