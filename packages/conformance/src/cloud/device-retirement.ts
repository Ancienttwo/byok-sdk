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
import type { TaskArchiveStoreInput, TaskAttempt, TaskRedactionCodec } from '@byok-sdk/cloud';
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
    it('a retirement whose mailbox expiry fails changes nothing, and a retry completes it', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox, failMailboxExpiry } = handle;
        // A composition without the seam rolls retirement back as one transaction.
        if (failMailboxExpiry === undefined) return;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('faulted'));
        const before = await seedDevice(handle, 'faulted');
        const rowsBefore = await mailbox.inspect(TENANT, 'faulted');
        const registered = await stores.devices.get(TENANT, 'faulted');

        const restore = await failMailboxExpiry();
        try {
          await expect(stores.devices.revoke(TENANT, 'faulted')).rejects.toThrow();
        } finally {
          await restore();
        }

        await expect(stores.devices.get(TENANT, 'faulted')).resolves.toEqual(registered);
        for (const position of [...UNFINISHED, 'complete'] as const) {
          await expect(stores.tasks.get(TENANT, `faulted-${position}`), position).resolves.toEqual(before[position]);
        }
        await expect(mailbox.inspect(TENANT, 'faulted')).resolves.toEqual(rowsBefore);

        await stores.devices.revoke(TENANT, 'faulted');
        await expectRetired(handle, 'faulted', before, rowsBefore.pending, 'device_revoked');
        await expect(stores.devices.get(TENANT, 'faulted')).resolves.toBeUndefined();
      });
    });

    it('a cancellation landing while a revoke waits on another task of the device leaves no pending row', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('busy'));
        for (const taskId of ['busy-a', 'busy-b']) {
          await stores.tasks.open(TENANT, { taskId, deviceId: 'busy' });
          await stores.tasks.claim(TENANT, { taskId, deviceId: 'busy' });
        }
        // Hold task a inside its own cancellation, the way any in-flight task mutation would.
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => { entered = resolve; });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const holdingA = stores.cancellations.request(TENANT, {
          taskId: 'busy-a',
          proposedMessageId: 'busy-a-cancel',
          materialize: async () => {
            entered();
            await gate;
            return materialized('busy-a', 'cancel');
          },
        });
        await Promise.race([inside, new Promise((resolve) => setTimeout(resolve, 50))]);

        const revoking = stores.devices.revoke(TENANT, 'busy');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const cancellingB = stores.cancellations.request(TENANT, {
          taskId: 'busy-b',
          proposedMessageId: 'busy-b-cancel',
          materialize: async () => materialized('busy-b', 'cancel'),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await Promise.allSettled([holdingA, cancellingB]);
        await revoking;

        await expect(stores.devices.get(TENANT, 'busy')).resolves.toBeUndefined();
        for (const taskId of ['busy-a', 'busy-b']) {
          await expect(stores.tasks.get(TENANT, taskId), taskId).resolves.toMatchObject({ status: 'cancelled' });
        }
        const after = await mailbox.inspect(TENANT, 'busy');
        expect(after.pending).toEqual([]);
        expect(after.usageBytes).toBe(0n);
      });
    });

    it('a cancellation that waits on a revoke of its device appends nothing once the revoke commits', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('late'));
        await stores.tasks.open(TENANT, { taskId: 'late-task', deviceId: 'late' });
        await stores.tasks.claim(TENANT, { taskId: 'late-task', deviceId: 'late' });
        await mailbox.append(TENANT, { deviceId: 'late', messageId: 'late-offer', body: envelope('late-task') });

        const release = await handle.holdMailboxExpiry();
        const revoking = stores.devices.revoke(TENANT, 'late');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const cancelling = stores.cancellations.request(TENANT, {
          taskId: 'late-task',
          proposedMessageId: 'late-cancel',
          materialize: async () => materialized('late-task', 'cancel'),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await release();
        await revoking;
        await cancelling;

        await expect(stores.tasks.get(TENANT, 'late-task')).resolves.toMatchObject({ status: 'cancelled', terminalCause: 'device_revoked' });
        const after = await mailbox.inspect(TENANT, 'late');
        expect(after.pending).toEqual([]);
        expect(after.usageBytes).toBe(0n);
      });
    });

    it('a re-registration racing a revoke of the same device id keeps its own later rows and floor', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('racing'));
        await stores.tasks.open(TENANT, { taskId: 'racing-old', deviceId: 'racing' });
        await mailbox.append(TENANT, { deviceId: 'racing', messageId: 'racing-old', body: envelope('racing-old') });

        const release = await handle.holdMailboxExpiry();
        const revoking = stores.devices.revoke(TENANT, 'racing');
        const registering = stores.devices.register(TENANT, registration('racing'));
        const settledEarly = await Promise.race([
          registering.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
        if (!settledEarly) {
          await release();
          await registering;
        }
        // Everything from here on is addressed to the registration that just resolved.
        await stores.tasks.open(TENANT, { taskId: 'racing-fresh', deviceId: 'racing' });
        const fresh = await mailbox.append(TENANT, { deviceId: 'racing', messageId: 'racing-fresh', body: envelope('racing-fresh') });
        const floor = (await mailbox.inspect(TENANT, 'racing')).recoverableFrom;
        if (settledEarly) await release();
        await revoking;

        // Revoke and register serialize, in either order. When the device ends
        // registered, the retirement belonged to the registration before it.
        if (await stores.devices.get(TENANT, 'racing') !== undefined) {
          await expect(stores.tasks.get(TENANT, 'racing-fresh')).resolves.toMatchObject({ status: 'offered' });
          const after = await mailbox.inspect(TENANT, 'racing');
          expect(after.pending.map((message) => message.seq)).toContain(fresh.seq);
          expect(after.recoverableFrom).toBe(floor);
        }
      });
    });

    // #1160: every writer checks the device in a read of its own, so the one
    // gate that holds whatever it checked is the closed stream at the append.
    for (const firstAppend of [false, true]) {
      it(`an append that lost a race to a revoke is refused and leaves no pending row${firstAppend ? ' (first append for the device)' : ''}`, async () => {
        await withCloudComposition(factory, async (handle) => {
          const { stores, mailbox, holdMailboxAppend } = handle;
          await mailbox.limit(TENANT, 1_000_000n);
          await stores.devices.register(TENANT, registration('lagging'));
          if (!firstAppend) await mailbox.append(TENANT, { deviceId: 'lagging', messageId: 'earlier', body: envelope('earlier') });

          const release = await holdMailboxAppend?.();
          const appending = refusal(mailbox.append(TENANT, { deviceId: 'lagging', messageId: 'late', body: envelope('late') }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          await stores.devices.revoke(TENANT, 'lagging');
          await release?.();
          const outcome = await appending;

          // Where no append can be held mid-way, it committed before the revoke, which expired it.
          if (release !== undefined) {
            expect(isCoreError(outcome, 'mailbox_stream_closed')).toBe(true);
            expect(outcome).toMatchObject({ deviceId: 'lagging', closeCause: 'device_revoked' });
          }
          const after = await mailbox.inspect(TENANT, 'lagging');
          expect(after.pending).toEqual([]);
          expect(after.usageBytes).toBe(0n);

          // Every later append is refused, a known id included, until the id is registered again.
          for (const messageId of firstAppend ? ['later'] : ['later', 'earlier']) {
            const refused = await refusal(mailbox.append(TENANT, { deviceId: 'lagging', messageId, body: envelope(messageId) }));
            expect(isCoreError(refused, 'mailbox_stream_closed'), messageId).toBe(true);
          }
          await stores.devices.register(TENANT, registration('lagging'));
          const reopened = await mailbox.append(TENANT, { deviceId: 'lagging', messageId: 'again', body: envelope('again') });
          expect(reopened.state).toBe('pending');
          expect(reopened.seq).toBeGreaterThanOrEqual(after.recoverableFrom);
          expect((await mailbox.inspect(TENANT, 'lagging')).recoverableFrom).toBeGreaterThanOrEqual(after.recoverableFrom);
        });
      });
    }

    it('machine supersession closes the predecessor\'s stream under device_superseded', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, { ...registration('first-pairing'), machineId: MACHINE });
        await stores.devices.register(TENANT, { ...registration('second-pairing'), machineId: MACHINE });
        const refused = await refusal(mailbox.append(TENANT, { deviceId: 'first-pairing', messageId: 'stale', body: envelope('stale') }));
        expect(refused).toMatchObject({ code: 'mailbox_stream_closed', closeCause: 'device_superseded' });
        await expect(mailbox.append(TENANT, { deviceId: 'second-pairing', messageId: 'fresh', body: envelope('fresh') }))
          .resolves.toMatchObject({ state: 'pending' });
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

  // #1119 x #1120: settling a task is a terminal transition, so the task
  // becomes archive work at its terminal instant like one a device finished.
  describe('settled tasks and the archive', () => {
    const codec: TaskRedactionCodec = {
      async tombstone(body) {
        const tombstone = `{"byokRedacted":1,"length":${body.length}}`;
        return { body: tombstone, bodyHash: contentHash(`sha256:${'0'.repeat(64)}`), byteSize: BigInt(tombstone.length) };
      },
      absent: '{"byokRedacted":1,"absent":true}',
      isTombstone: (body) => body.startsWith('{"byokRedacted":1,'),
      blobHashes: () => [],
    };
    const archiveInput = (taskId: string, archivedAt: string): TaskArchiveStoreInput => ({
      taskId,
      receiptKeys: [`task:${taskId}:terminal`],
      terminalReceiptKey: `task:${taskId}:terminal`,
      releaseObjectReferences: [],
      archivedAt,
      codec,
    });
    const after = (instant: string) => new Date(Date.parse(instant) + 1).toISOString();

    /** The settled attempt is archive work from just after its terminal instant, and not at it. */
    async function expectArchiveWorkAt(handle: CloudCompositionHandle, taskId: string): Promise<string> {
      const attempt = await handle.stores.tasks.get(TENANT, taskId);
      expect(attempt, taskId).toMatchObject({ status: 'cancelled' });
      const terminalAt = attempt!.terminalAt!;
      const listed = async (archiveBefore: string) =>
        (await handle.stores.taskArchive.listWork(TENANT, { archiveBefore, limit: 100 })).map((unit) => unit.taskId);
      expect(await listed(terminalAt), taskId).not.toContain(taskId);
      expect(await listed(after(terminalAt)), taskId).toContain(taskId);
      return terminalAt;
    }

    it('a revoked device\'s settled tasks are archive work and archive', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, registration('archived-revoke'));
        await stores.tasks.open(TENANT, { taskId: 'revoke-offered', deviceId: 'archived-revoke' });
        await mailbox.append(TENANT, { deviceId: 'archived-revoke', messageId: 'revoke-offer', body: envelope('revoke-offered') });
        await stores.tasks.open(TENANT, { taskId: 'revoke-claimed', deviceId: 'archived-revoke' });
        await stores.tasks.claim(TENANT, { taskId: 'revoke-claimed', deviceId: 'archived-revoke' });

        await stores.devices.revoke(TENANT, 'archived-revoke');

        for (const taskId of ['revoke-offered', 'revoke-claimed']) {
          await expect(stores.tasks.get(TENANT, taskId)).resolves.toMatchObject({ status: 'cancelled', terminalCause: 'device_revoked' });
          const terminalAt = await expectArchiveWorkAt(handle, taskId);
          await expect(stores.taskArchive.archive(TENANT, archiveInput(taskId, after(terminalAt))), taskId)
            .resolves.toMatchObject({ outcome: 'archived' });
        }
      });
    });

    it('a superseded device\'s settled tasks are archive work and archive', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.devices.register(TENANT, { ...registration('archived-first'), machineId: MACHINE });
        await stores.tasks.open(TENANT, { taskId: 'supersede-offered', deviceId: 'archived-first' });
        await mailbox.append(TENANT, { deviceId: 'archived-first', messageId: 'supersede-offer', body: envelope('supersede-offered') });

        await stores.devices.register(TENANT, { ...registration('archived-second'), machineId: MACHINE });

        await expect(stores.tasks.get(TENANT, 'supersede-offered')).resolves.toMatchObject({ terminalCause: 'device_superseded' });
        const terminalAt = await expectArchiveWorkAt(handle, 'supersede-offered');
        await expect(stores.taskArchive.archive(TENANT, archiveInput('supersede-offered', after(terminalAt))))
          .resolves.toMatchObject({ outcome: 'archived' });
      });
    });

    it('an abandoned task archives at once when its device is gone, and after the ack while it is registered', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores, mailbox } = handle;
        await mailbox.limit(TENANT, 1_000_000n);
        await stores.tasks.open(TENANT, { taskId: 'abandon-gone', deviceId: 'never-registered' });
        await mailbox.append(TENANT, { deviceId: 'never-registered', messageId: 'abandon-gone-offer', body: envelope('abandon-gone') });
        await stores.devices.register(TENANT, registration('archived-live'));
        await stores.tasks.open(TENANT, { taskId: 'abandon-live', deviceId: 'archived-live' });
        await mailbox.append(TENANT, { deviceId: 'archived-live', messageId: 'abandon-live-offer', body: envelope('abandon-live') });

        await stores.cancellations.abandon(TENANT, { taskId: 'abandon-gone', cause: 'operator' });
        await stores.cancellations.abandon(TENANT, { taskId: 'abandon-live', cause: 'operator' });

        const goneAt = await expectArchiveWorkAt(handle, 'abandon-gone');
        await expect(stores.taskArchive.archive(TENANT, archiveInput('abandon-gone', after(goneAt))))
          .resolves.toMatchObject({ outcome: 'archived' });

        // The registered device still has to read its offer: archiving waits for its ack.
        const liveAt = await expectArchiveWorkAt(handle, 'abandon-live');
        await expect(stores.taskArchive.archive(TENANT, archiveInput('abandon-live', after(liveAt))))
          .resolves.toEqual({ outcome: 'refused', reason: 'pending_delivery' });
        await mailbox.ack(TENANT, 'archived-live');
        await expect(stores.taskArchive.archive(TENANT, archiveInput('abandon-live', after(liveAt))))
          .resolves.toMatchObject({ outcome: 'archived' });
      });
    });
  });
}
