import {
  byokAgentHomeProjectionCompletionPath,
  decodeEnvelope,
  type AgentHomeProjectionValue,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { agentHomeProjectionRequestKey } from '../agent-home-projections';
import { TENANT_A, createHarness } from './support/harness';

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUEST_A = '10000000-0000-4000-8000-000000000201';
const REQUEST_B = '10000000-0000-4000-8000-000000000202';

function desired(
  requestId = REQUEST_A,
  projectionHash = HASH_A,
  projection: AgentHomeProjectionValue = { enabled: true },
) {
  return {
    requestId,
    agentRef: { agentId: 'agent-home-projection', profileRevision: '7' },
    projectionHash,
    projection,
  } as const;
}

function completion(requestId = REQUEST_A, projectionHash = HASH_A) {
  return {
    requestId,
    agentRef: { agentId: 'agent-home-projection', profileRevision: '7' },
    projectionHash,
    outcome: 'applied' as const,
  };
}

async function admitProjection(
  harness: ReturnType<typeof createHarness>,
  deviceId: string,
): Promise<void> {
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId,
    capabilities: ['agent-home-contract', 'agent-home-projection'],
  });
}

describe('task-free Agent-home projection', () => {
  it('rejects an old daemon before immutable request or mailbox allocation', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract'],
    });

    await expect(harness.cloud.enqueueAgentHomeProjection(TENANT_A, device.deviceId, desired())).rejects.toMatchObject({
      code: 'agent_capability_missing',
    });
    await expect(harness.stores.receipts.get(TENANT_A, agentHomeProjectionRequestKey(device.deviceId, REQUEST_A))).resolves.toBeUndefined();
    await expect(
      harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [] });
  });

  it('parses malformed and oversize requests before capability or durable allocation', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitProjection(harness, device.deviceId);

    await expect(
      harness.cloud.enqueueAgentHomeProjection(TENANT_A, device.deviceId, {
        ...desired(),
        agentRef: { agentId: 'agent-home-projection', profileRevision: '07' },
      }),
    ).rejects.toThrow();
    await expect(
      harness.cloud.enqueueAgentHomeProjection(TENANT_A, device.deviceId, desired(REQUEST_B, HASH_A, 'x'.repeat(64 * 1024 + 1))),
    ).rejects.toThrow();
    await expect(harness.stores.receipts.get(TENANT_A, agentHomeProjectionRequestKey(device.deviceId, REQUEST_A))).resolves.toBeUndefined();
    await expect(harness.stores.receipts.get(TENANT_A, agentHomeProjectionRequestKey(device.deviceId, REQUEST_B))).resolves.toBeUndefined();
    await expect(
      harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [] });
  });

  it('keeps the desired receipt immutable, replays exactly, and stays outside TaskAttempt', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitProjection(harness, device.deviceId);

    const first = await harness.cloud.enqueueAgentHomeProjection(TENANT_A, device.deviceId, desired());
    const replay = await harness.cloud.enqueueAgentHomeProjection(TENANT_A, device.deviceId, desired());
    expect(replay).toEqual(first);
    expect(first.status).toMatchObject({
      tenantId: TENANT_A,
      deviceId: device.deviceId,
      requestId: REQUEST_A,
      agentRef: desired().agentRef,
      projectionHash: HASH_A,
      status: 'pending',
    });
    await expect(
      harness.cloud.enqueueAgentHomeProjection(TENANT_A, device.deviceId, desired(REQUEST_A, HASH_A, { enabled: false })),
    ).rejects.toMatchObject({ code: 'agent_home_projection_request_conflict' });

    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    expect(page.messages).toHaveLength(1);
    const control = decodeEnvelope(page.messages[0]!.body);
    expect(control).toMatchObject({ type: 'agent.home.projection', id: REQUEST_A, seq: 1, payload: desired() });
    expect(control.task_id).toBeUndefined();
    await expect(harness.cloud.readTaskAttempt(TENANT_A, REQUEST_A)).resolves.toBeUndefined();
  });

  it('requires exact authenticated device, AgentRef, hash, and first terminal outcome', async () => {
    const harness = createHarness();
    const target = await harness.pairDevice(TENANT_A);
    const wrongDevice = await harness.pairDevice(TENANT_A);
    await admitProjection(harness, target.deviceId);
    await admitProjection(harness, wrongDevice.deviceId);
    await harness.cloud.enqueueAgentHomeProjection(TENANT_A, target.deviceId, desired());

    const request = (authorization: { readonly authorization: string }, body: unknown) =>
      harness.request(byokAgentHomeProjectionCompletionPath(REQUEST_A), {
        method: 'PUT',
        headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    await expect(request(wrongDevice.authorization, completion())).resolves.toMatchObject({ status: 404 });
    await expect(
      request(target.authorization, { ...completion(), agentRef: { agentId: 'different', profileRevision: '7' } }),
    ).resolves.toMatchObject({ status: 422 });
    await expect(request(target.authorization, completion(REQUEST_A, HASH_B))).resolves.toMatchObject({ status: 422 });
    await expect(
      harness.cloud.getAgentHomeProjectionStatus(TENANT_A, target.deviceId, {
        requestId: REQUEST_A,
        agentRef: desired().agentRef,
        projectionHash: HASH_A,
      }),
    ).resolves.toMatchObject({ status: 'pending' });

    const accepted = await request(target.authorization, completion());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      tenantId: TENANT_A,
      deviceId: target.deviceId,
      requestId: REQUEST_A,
      agentRef: desired().agentRef,
      projectionHash: HASH_A,
      status: 'applied',
    });
    await expect(request(target.authorization, { ...completion(), outcome: 'stale' })).resolves.toMatchObject({ status: 409 });
  });
});
