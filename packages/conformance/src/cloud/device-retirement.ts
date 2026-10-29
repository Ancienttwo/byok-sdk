/**
 * Device retirement and task abandonment conformance (#1119).
 *
 * A device that is revoked, or superseded when its machine re-pairs, will
 * never finish its tasks or ack its mailbox rows. Every composition must
 * settle both in the transaction that retires the device: the unfinished
 * attempts become `cancelled` under the retirement cause, and the pending rows
 * become `expired`, so they stop holding the tenant's mailbox quota.
 * `cancellations.abandon` applies the same transition to one task.
 *
 * Observed through the composition's own mailbox (`handle.mailbox`), because
 * the quota a dead device held is exactly what a Host feels: before this, a
 * full mailbox stayed full and every new offer was refused.
 */
import { contentHash, isCoreError, tenantId, type MailboxMessage } from '@byok-sdk/core';
import type { TaskAttempt } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { registration } from './fixtures';
import {
  withCloudComposition,
  type CloudCompositionFactory,
  type CloudCompositionHandle,
} from './harness';

const TENANT = tenantId('tenant-retirement-conformance');
const MACHINE = 'b'.repeat(64);
const CODE_TTL_MS = 10 * 60 * 1000;

/** A compact envelope-shaped body that names its task the way every store identifies a task's rows. */
function envelope(taskId: string, label = 'offer'): string {
  return JSON.stringify({ type: `task.${label}`, task_id: taskId });
}

function materialized(taskId: string, label: string) {
  const body = envelope(taskId, label);
  return {
    body,
    bodyHash: contentHash(`sha256:${'d'.repeat(64)}`),
    byteSize: BigInt(new TextEncoder().encode(body).length),
  };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (caught: unknown) => caught);
}

const UNFINISHED = ['offered', 'claimed', 'running', 'cancel-requested'] as const;

/**
 * One device's tasks in every lifecycle position, and its pending rows: an
 * offer row and the cancellation delivery row. Returns the attempts as stored.
 */
async function seedDevice(
  handle: CloudCompositionHandle,
  deviceId: string,
): Promise<Readonly<Record<(typeof UNFINISHED)[number] | 'complete', TaskAttempt>>> {
  const { stores, mailbox } = handle;
  const id = (suffix: string) => `${deviceId}-${suffix}`;
  await stores.tasks.open(TENANT, { taskId: id('offered'), deviceId });
  await mailbox.append(TENANT, { deviceId, messageId: id('offer'), body: envelope(id('offered')) });
  for (const suffix of ['claimed', 'running', 'cancel-requested', 'complete']) {
    await stores.tasks.open(TENANT, { taskId: id(suffix), deviceId });
    await stores.tasks.claim(TENANT, { taskId: id(suffix), deviceId });
  }
  await stores.tasks.recordStatus(TENANT, { taskId: id('running'), status: 'running' });
  await stores.tasks.recordStatus(TENANT, { taskId: id('complete'), status: 'complete' });
  await stores.cancellations.request(TENANT, {
    taskId: id('cancel-requested'),
    proposedMessageId: id('cancel'),
    reason: 'stop',
    materialize: async () => materialized(id('cancel-requested'), 'cancel'),
  });
  const read = async (suffix: string) => (await stores.tasks.get(TENANT, id(suffix)))!;
  return {
    offered: await read('offered'),
    claimed: await read('claimed'),
    running: await read('running'),
    'cancel-requested': await read('cancel-requested'),
    complete: await read('complete'),
  };
}

/** Asserts the seeded device was retired under `cause`; `before` is what `seedDevice` stored. */
async function expectRetired(
  handle: CloudCompositionHandle,
  deviceId: string,
  before: Awaited<ReturnType<typeof seedDevice>>,
  pendingBefore: readonly MailboxMessage[],
  cause: 'device_revoked' | 'device_superseded',
): Promise<void> {
  const { stores, mailbox } = handle;
  for (const position of UNFINISHED) {
    const attempt = await stores.tasks.get(TENANT, `${deviceId}-${position}`);
    expect(attempt, position).toMatchObject({ status: 'cancelled', terminalCause: cause });
    expect(attempt?.terminalAt, position).toBeDefined();
    expect(attempt?.ownerDeviceId, position).toBe(before[position].ownerDeviceId);
  }
  // The host cancellation tombstone outlives the retirement unchanged.
  expect((await stores.tasks.get(TENANT, `${deviceId}-cancel-requested`))?.cancellation)
    .toEqual(before['cancel-requested'].cancellation);
  // A terminal attempt is never rewritten.
  await expect(stores.tasks.get(TENANT, `${deviceId}-complete`)).resolves.toEqual(before.complete);

  const after = await mailbox.inspect(TENANT, deviceId);
  expect(after.pending).toEqual([]);
  expect(after.recoverableFrom).toBe(Math.max(...pendingBefore.map((message) => message.seq)) + 1);
}

export function runDeviceRetirementConformance(factory: CloudCompositionFactory): void {
  describe('device retirement', () => {
    it('revocation settles the device tasks and frees the mailbox quota its rows held', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('retired'));
        await stores.devices.register(TENANT, registration('kept'));
        const before = await seedDevice(handle, 'retired');
        const kept = await stores.tasks.open(TENANT, { taskId: 'kept-offered', deviceId: 'kept' });
        const keptRow = await mailbox.append(TENANT, { deviceId: 'kept', messageId: 'kept-offer', body: envelope('kept-offered') });
        const pendingBefore = (await mailbox.inspect(TENANT, 'retired')).pending;
        expect(pendingBefore).toHaveLength(2);

        // The mailbox is now exactly full: the next offer anywhere in the tenant is refused.
        await mailbox.limit(TENANT, (await mailbox.inspect(TENANT, 'kept')).usageBytes);
        const blocked = { deviceId: 'kept', messageId: 'kept-next', body: envelope('kept-next') };
        expect(isCoreError(await refusal(mailbox.append(TENANT, blocked)), 'storage_quota_exceeded')).toBe(true);

        await stores.devices.revoke(TENANT, 'retired');

        await expectRetired(handle, 'retired', before, pendingBefore, 'device_revoked');
        await expect(stores.tasks.get(TENANT, 'kept-offered')).resolves.toEqual(kept);
        const keptAfter = await mailbox.inspect(TENANT, 'kept');
        expect(keptAfter.pending.map((message) => message.messageId)).toEqual([keptRow.messageId]);
        expect(keptAfter.usageBytes).toBe(keptRow.byteSize);
        await expect(mailbox.append(TENANT, blocked)).resolves.toMatchObject({ state: 'pending' });
      });
    });

    it('a revoke this tenant cannot address settles nothing', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('stranger'));
        const before = await seedDevice(handle, 'stranger');
        const pending = (await mailbox.inspect(TENANT, 'stranger')).pending;

        await stores.devices.revoke(tenantId('tenant-retirement-other'), 'stranger');
        await stores.devices.revoke(TENANT, 'never-registered');

        for (const [position, attempt] of Object.entries(before)) {
          await expect(stores.tasks.get(TENANT, `stranger-${position}`)).resolves.toEqual(attempt);
        }
        expect((await mailbox.inspect(TENANT, 'stranger')).pending).toEqual(pending);
      });
    });

    it('machine supersession retires the predecessor under device_superseded', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('first', { machineId: MACHINE }));
        const before = await seedDevice(handle, 'first');
        const pendingBefore = (await mailbox.inspect(TENANT, 'first')).pending;

        await stores.devices.register(TENANT, registration('second', { machineId: MACHINE }));

        await expect(stores.devices.get(TENANT, 'first')).resolves.toBeUndefined();
        await expectRetired(handle, 'first', before, pendingBefore, 'device_superseded');
      });
    });

    it('pairing enrollment that supersedes a machine retires the predecessor in its transaction', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('paired-first', { machineId: MACHINE }));
        const before = await seedDevice(handle, 'paired-first');
        const pendingBefore = (await mailbox.inspect(TENANT, 'paired-first')).pending;
        const expiresAt = new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString();
        await stores.pairingCodes.issue(TENANT, { code: 'retire-code', productId: 'product-1', expiresAt });

        const device = await stores.pairing.redeemAndRegister({
          pairingCode: 'retire-code',
          deviceId: 'paired-second',
          deviceName: 'name-paired-second',
          devicePublicKey: 'pk-paired-second',
          proofKeyId: 'identity',
          proofKeyEpoch: 0,
          machineId: MACHINE,
        });

        expect(device?.deviceId).toBe('paired-second');
        await expectRetired(handle, 'paired-first', before, pendingBefore, 'device_superseded');
      });
    });

    it('re-registering a revoked device id keeps the dead-letter floor and never revives an expired row', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('returning'));
        const rows: MailboxMessage[] = [];
        for (const label of ['one', 'two', 'three']) {
          rows.push(await mailbox.append(TENANT, { deviceId: 'returning', messageId: label, body: envelope(label) }));
        }
        const floorBefore = (await mailbox.inspect(TENANT, 'returning')).recoverableFrom;

        await stores.devices.revoke(TENANT, 'returning');
        await stores.devices.register(TENANT, registration('returning'));

        const after = await mailbox.inspect(TENANT, 'returning');
        expect(after.pending).toEqual([]);
        expect(after.recoverableFrom).toBeGreaterThanOrEqual(floorBefore);
        for (const row of rows) expect(after.recoverableFrom).toBeGreaterThan(row.seq);

        const next = await mailbox.append(TENANT, { deviceId: 'returning', messageId: 'four', body: envelope('four') });
        expect(next.state).toBe('pending');
        expect(next.seq).toBeGreaterThanOrEqual(after.recoverableFrom);
        // A replayed id of an expired row answers that row; it is not appended again as pending.
        await expect(
          mailbox.append(TENANT, { deviceId: 'returning', messageId: 'one', body: envelope('one') }),
        ).resolves.toMatchObject({ seq: rows[0]!.seq, state: 'expired' });
        const final = await mailbox.inspect(TENANT, 'returning');
        expect(final.pending.map((message) => message.seq)).toEqual([next.seq]);
      });
    });
  });

  describe('task abandonment', () => {
    it('settles an unfinished task and expires only its own pending rows', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.tasks.open(TENANT, { taskId: 'abandoned', deviceId: 'device-a' });
        await stores.tasks.open(TENANT, { taskId: 'neighbour', deviceId: 'device-a' });
        const own = await mailbox.append(TENANT, { deviceId: 'device-a', messageId: 'own', body: envelope('abandoned') });
        const neighbour = await mailbox.append(TENANT, { deviceId: 'device-a', messageId: 'neighbour', body: envelope('neighbour') });
        // Names the task only inside a nested value: not the task's row.
        const nested = await mailbox.append(TENANT, {
          deviceId: 'device-a',
          messageId: 'nested',
          body: JSON.stringify({ type: 'task.offer', task_id: 'neighbour', payload: { task_id: 'abandoned' } }),
        });

        const settled = await stores.cancellations.abandon(TENANT, { taskId: 'abandoned', cause: 'operator' });

        expect(settled).toMatchObject({ taskId: 'abandoned', status: 'cancelled', terminalCause: 'operator' });
        expect(settled?.terminalAt).toBeDefined();
        await expect(stores.tasks.get(TENANT, 'abandoned')).resolves.toEqual(settled);
        await expect(stores.tasks.get(TENANT, 'neighbour')).resolves.toMatchObject({ status: 'offered' });
        const after = await mailbox.inspect(TENANT, 'device-a');
        expect(after.pending.map((message) => message.messageId)).toEqual([neighbour.messageId, nested.messageId]);
        expect(after.recoverableFrom).toBe(own.seq + 1);
        expect(after.usageBytes).toBe(neighbour.byteSize + nested.byteSize);

        // Idempotent: a second abandonment of the now-terminal task writes nothing.
        await expect(stores.cancellations.abandon(TENANT, { taskId: 'abandoned', cause: 'device_revoked' }))
          .resolves.toEqual(settled);
      });
    });

    it('keeps a still-registered device\'s rows pending and its floor in place until that device acks them', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('live'));
        await stores.tasks.open(TENANT, { taskId: 'live-abandoned', deviceId: 'live' });
        await stores.tasks.open(TENANT, { taskId: 'live-neighbour', deviceId: 'live' });
        await mailbox.append(TENANT, { deviceId: 'live', messageId: 'live-own', body: envelope('live-abandoned') });
        await mailbox.append(TENANT, { deviceId: 'live', messageId: 'live-next', body: envelope('live-neighbour') });
        const before = await mailbox.inspect(TENANT, 'live');

        const settled = await stores.cancellations.abandon(TENANT, { taskId: 'live-abandoned', cause: 'operator' });

        expect(settled).toMatchObject({ status: 'cancelled', terminalCause: 'operator' });
        // Expiring a row the device has not read would move its floor past it.
        await expect(mailbox.inspect(TENANT, 'live')).resolves.toEqual(before);
        await mailbox.ack(TENANT, 'live');
        const acked = await mailbox.inspect(TENANT, 'live');
        expect(acked.usageBytes).toBe(0n);
        expect(acked.recoverableFrom).toBe(before.recoverableFrom);
      });
    });

    it('leaves a terminal task and its rows alone and answers undefined for an unknown task', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.tasks.open(TENANT, { taskId: 'done', deviceId: 'device-b' });
        await stores.tasks.claim(TENANT, { taskId: 'done', deviceId: 'device-b' });
        const done = await stores.tasks.recordStatus(TENANT, { taskId: 'done', status: 'complete' });
        const row = await mailbox.append(TENANT, { deviceId: 'device-b', messageId: 'late', body: envelope('done', 'steer') });

        await expect(stores.cancellations.abandon(TENANT, { taskId: 'done', cause: 'operator' })).resolves.toEqual(done);
        expect((await mailbox.inspect(TENANT, 'device-b')).pending.map((message) => message.seq)).toEqual([row.seq]);
        await expect(stores.cancellations.abandon(TENANT, { taskId: 'missing', cause: 'operator' })).resolves.toBeUndefined();
      });
    });

    it('keeps a cancellation tombstone and expires its undelivered cancellation row', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await stores.tasks.open(TENANT, { taskId: 'stopping', deviceId: 'device-c' });
        await stores.tasks.claim(TENANT, { taskId: 'stopping', deviceId: 'device-c' });
        const requested = await stores.cancellations.request(TENANT, {
          taskId: 'stopping',
          proposedMessageId: 'stopping-cancel',
          reason: 'stuck runtime',
          materialize: async () => materialized('stopping', 'cancel'),
        });
        expect(requested?.attempt.status).toBe('cancel_requested');

        const settled = await stores.cancellations.abandon(TENANT, { taskId: 'stopping', cause: 'device_revoked' });

        expect(settled).toMatchObject({ status: 'cancelled', terminalCause: 'device_revoked' });
        expect(settled?.cancellation).toEqual(requested?.attempt.cancellation);
        const after = await mailbox.inspect(TENANT, 'device-c');
        expect(after.pending).toEqual([]);
        expect(after.recoverableFrom).toBe(requested!.message!.seq + 1);
      });
    });
  });
}
