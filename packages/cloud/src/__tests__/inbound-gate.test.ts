/**
 * The inbound gate, one negative per step.
 *
 * The gate's ORDER is as load-bearing as its steps: a rate-limited device must
 * not get a free type check, an unowned task must not be rejected, and a
 * duplicate must not be counted a rejection. Each test below fixes one of
 * those, and `handleInboundEnvelope` is exercised directly (rather than only
 * through `POST /byok/messages`) so the outcome — not just the HTTP status it
 * maps to — is what is asserted.
 */
import { tenantId, type TenantId } from '@byok-sdk/core';
import { DAEMON_TO_SERVER_TYPES, createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleInboundEnvelope, terminalReceiptKey } from '../inbound';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import type { InboundRateLimiter } from '../stores/ports';
import { TENANT_A, TENANT_B, createHarness, offerPayload, type CloudHarness } from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

function claim(taskId: string, deviceId: string): Envelope {
  return createEnvelope('task.claim', { deviceId }, { taskId });
}

function progress(taskId: string): Envelope {
  return createEnvelope('task.progress', { seq: 1, events: [] }, { taskId });
}

function complete(taskId: string, summary: string): Envelope {
  return createEnvelope('task.complete', { summary, sessionRef: 'session-1' }, { taskId });
}

describe('the inbound gate', () => {
  let harness: CloudHarness;
  let stores: TenantStores;
  let deviceId: string;

  beforeEach(async () => {
    harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    deviceId = device.deviceId;
    stores = tenantStoresFor(devicePrincipal(TENANT_A, deviceId), { core: harness.core, cloud: harness.stores });
  });

  it('step 0: a rate-limited envelope never reaches the type check', async () => {
    const seen: string[] = [];
    const limiter: InboundRateLimiter = {
      async consume(_tenant, device) {
        seen.push(device);
        return false;
      },
    };
    const limited = createHarness();
    const device = await limited.pairDevice(TENANT_A);
    const limitedStores = tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
      core: limited.core,
      cloud: { ...limited.stores, rateLimiter: limiter },
    });

    // A type the allow-list would reject anyway: it must still cost a token,
    // and the answer must be `rate_limited`, not `rejected`.
    const wrongDirection = createEnvelope('task.approve', {}, { taskId: 'task-1', seq: 1 });
    expect(await handleInboundEnvelope(limitedStores, device.deviceId, wrongDirection)).toBe('rate_limited');
    expect(seen).toEqual([device.deviceId]);
  });

  it('step 1: rejects every server -> daemon type arriving inbound', async () => {
    const inbound = [
      createEnvelope('task.approve', {}, { taskId: 'task-1', seq: 1 }),
      createEnvelope('task.cancel', {}, { taskId: 'task-1', seq: 2 }),
      createEnvelope('conn.ack', { protocolVersion: 1, capabilities: [], serverTime: new Date().toISOString() }, { seq: 3 }),
    ];
    for (const envelope of inbound) {
      expect(await handleInboundEnvelope(stores, deviceId, envelope)).toBe('rejected');
    }
  });

  it('step 1: accepts every daemon -> server type', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    const accepted: string[] = [];
    for (const type of DAEMON_TO_SERVER_TYPES) {
      const envelope = envelopeOfType(type, taskId, deviceId);
      const outcome = await handleInboundEnvelope(stores, deviceId, envelope);
      if (outcome === 'accepted') accepted.push(type);
    }
    expect(accepted).toEqual([...DAEMON_TO_SERVER_TYPES]);
  });

  it('step 2: rejects an envelope for a task another device already owns, and does not disturb it', async () => {
    const other = await harness.pairDevice(TENANT_A);
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });

    expect(await handleInboundEnvelope(stores, deviceId, claim(taskId, deviceId))).toBe('accepted');

    const intruderStores = tenantStoresFor(devicePrincipal(TENANT_A, other.deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    expect(await handleInboundEnvelope(intruderStores, other.deviceId, complete(taskId, 'stolen'))).toBe('rejected');

    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, taskId);
    expect(attempt?.ownerDeviceId).toBe(deviceId);
    expect(attempt?.status).toBe('claimed');
    expect(await harness.cloud.readTerminalReceipt(TENANT_A, taskId)).toBeUndefined();
  });

  it('step 2: lets an unowned task through — a guessed id must not be force-failable', async () => {
    // The reference server drops on an ownership MISMATCH only; a task with no
    // owner (or none at all) is handled by the store's no-op-on-missing.
    expect(await handleInboundEnvelope(stores, deviceId, progress('task-nobody-offered'))).toBe('accepted');
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'task-nobody-offered')).toBeUndefined();
  });

  it('rejects malformed activity order before recording the envelope in dedup', async () => {
    const malformed = createEnvelope(
      'task.progress',
      { seq: -1, events: [{ type: 'turn_end' }] },
      { taskId: 'task-invalid-progress' },
    );
    expect(await handleInboundEnvelope(stores, deviceId, malformed)).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, malformed)).toBe('rejected');
  });

  it('step 3: a repeated envelope id is a duplicate, not a rejection, and re-runs nothing', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    const envelope = claim(taskId, deviceId);

    expect(await handleInboundEnvelope(stores, deviceId, envelope)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, envelope)).toBe('duplicate');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.ownerDeviceId).toBe(deviceId);
  });

  it('persists approval lifecycle after the real ownership and dedup gate', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, {
      payload: offerPayload(),
    });
    const requested = createEnvelope(
      'task.await_approval',
      { summary: 'Allow write', approvalId: 'approval-1' },
      { taskId },
    );
    const resolved = createEnvelope(
      'task.approval_resolved',
      {
        approvalId: 'approval-1',
        decision: 'approve',
        resolvedBy: 'local',
        at: '2026-08-16T12:00:00.000Z',
      },
      { taskId },
    );

    expect(await handleInboundEnvelope(stores, deviceId, requested)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, requested)).toBe('duplicate');
    expect(await handleInboundEnvelope(stores, deviceId, resolved)).toBe('accepted');

    const tail = await harness.cloud.readApprovalTimeline(TENANT_A, taskId);
    expect(tail?.entries.map((entry) => entry.event)).toEqual([
      { type: 'approval_requested', summary: 'Allow write', approvalId: 'approval-1' },
      {
        type: 'approval_resolved',
        approvalId: 'approval-1',
        decision: 'approve',
        resolvedBy: 'local',
        at: '2026-08-16T12:00:00.000Z',
      },
    ]);
    expect(tail?.entries.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(await harness.cloud.readApprovalTimeline(TENANT_B, taskId)).toBeUndefined();
  });

  it('preserves a legacy request without approvalId as explicitly unpaired source data', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, {
      payload: offerPayload(),
    });
    const requested = createEnvelope(
      'task.await_approval',
      { summary: 'Legacy request' },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, deviceId, requested)).toBe('accepted');
    expect((await harness.cloud.readApprovalTimeline(TENANT_A, taskId))?.entries[0]?.event).toEqual({
      type: 'approval_requested',
      summary: 'Legacy request',
    });
  });

  it('rejects blank approval identity before recording the envelope in dedup', async () => {
    const malformed = createEnvelope(
      'task.approval_resolved',
      {
        approvalId: '   ',
        decision: 'approve',
        resolvedBy: 'local',
        at: '2026-08-16T12:00:00.000Z',
      },
      { taskId: 'task-invalid-approval' },
    );
    expect(await handleInboundEnvelope(stores, deviceId, malformed)).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, malformed)).toBe('rejected');
    expect(
      await harness.cloud.readApprovalTimeline(TENANT_A, 'task-invalid-approval'),
    ).toBeUndefined();
  });

  it('step 3: dedup is per device — the same id from another device is not a duplicate', async () => {
    const other = await harness.pairDevice(TENANT_A);
    const otherStores = tenantStoresFor(devicePrincipal(TENANT_A, other.deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    const envelope = progress('task-shared');

    expect(await handleInboundEnvelope(stores, deviceId, envelope)).toBe('accepted');
    expect(await handleInboundEnvelope(otherStores, other.deviceId, envelope)).toBe('accepted');
  });

  it('step 3: dedup is per tenant — the same device id in another tenant has its own ring', async () => {
    const foreign = tenantStoresFor(devicePrincipal(TENANT_B, deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    const envelope = progress('task-shared');

    expect(await handleInboundEnvelope(stores, deviceId, envelope)).toBe('accepted');
    expect(await handleInboundEnvelope(foreign, deviceId, envelope)).toBe('accepted');
  });

  it('step 4: the first terminal is the fact; a retried terminal records nothing new', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    await handleInboundEnvelope(stores, deviceId, claim(taskId, deviceId));

    expect(await handleInboundEnvelope(stores, deviceId, complete(taskId, 'first'))).toBe('accepted');
    // A retry with a NEW envelope id: dedup does not catch it, the receipt does.
    expect(await handleInboundEnvelope(stores, deviceId, complete(taskId, 'second'))).toBe('accepted');

    const receipt = await harness.cloud.readTerminalReceipt(TENANT_A, taskId);
    expect(receipt?.key).toBe(terminalReceiptKey(taskId));
    expect(receipt?.body).toContain('"first"');
    expect(receipt?.body).not.toContain('"second"');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('complete');
  });

  it('records the lifecycle a daemon actually reports', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('offered');

    await handleInboundEnvelope(stores, deviceId, claim(taskId, deviceId));
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('claimed');

    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.started', {}, { taskId }));
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('running');

    await handleInboundEnvelope(stores, deviceId, complete(taskId, 'done'));
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('complete');
  });

  it('never writes into a tenant it was not bound to', async () => {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    const foreign = tenantStoresFor(devicePrincipal(TENANT_B, deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });

    expect(await handleInboundEnvelope(foreign, deviceId, claim(taskId, deviceId))).toBe('accepted');

    // Tenant A's attempt is untouched, and tenant B gained no row for the id
    // it guessed.
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.ownerDeviceId).toBeUndefined();
    expect(await harness.cloud.readTaskAttempt(TENANT_B, taskId)).toBeUndefined();
    expect(await harness.cloud.readTerminalReceipt(tenantId('tenant-b'), taskId)).toBeUndefined();
  });
});

function envelopeOfType(type: (typeof DAEMON_TO_SERVER_TYPES)[number], taskId: string, deviceId: string): Envelope {
  switch (type) {
    case 'task.claim':
      return createEnvelope('task.claim', { deviceId }, { taskId });
    case 'task.started':
      return createEnvelope('task.started', {}, { taskId });
    case 'task.decline':
      return createEnvelope('task.decline', { reason: 'no runtime' }, { taskId });
    case 'task.progress':
      return createEnvelope('task.progress', { seq: 1, events: [] }, { taskId });
    case 'task.artifact':
      return createEnvelope('task.artifact', { name: 'a', contentType: 'text/plain', inline: 'x' }, { taskId });
    case 'task.await_approval':
      return createEnvelope('task.await_approval', { summary: 'may I' }, { taskId });
    case 'task.complete':
      return createEnvelope('task.complete', { summary: 'ok', sessionRef: 's' }, { taskId });
    case 'task.fail':
      return createEnvelope('task.fail', { reason: 'nope' }, { taskId });
    case 'task.cancelled':
      return createEnvelope('task.cancelled', {}, { taskId });
    case 'task.approval_resolved':
      return createEnvelope(
        'task.approval_resolved',
        { approvalId: 'ap-1', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId },
      );
  }
}
