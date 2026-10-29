/**
 * Mailbox conformance (§12.7.3).
 *
 * The assertion this group exists for is "read does not ack". Everything else
 * here is scaffolding around it: if a composition ever deletes or marks rows on
 * read, the frozen at-least-once contract the client's stall recovery depends
 * on is gone, and it goes silently — the happy path still looks fine.
 *
 * The admission group pins the one mailbox-byte authority (#411, #1115): usage
 * is the sum over the retained `pending` rows, and a `limited` append is
 * checked against `mailboxLimitBytes` in the same serialized unit that inserts
 * it. Acked and dead-lettered rows are retained but never hold quota.
 */
import { describe, expect, it } from 'vitest';
import {
  isCoreConflictError,
  isCoreError,
  type CoreConflictError,
  type CoreStores,
  type MailboxCursorState,
} from '@byok-sdk/core';
import { ENTITLEMENT, hashOf, TENANT_A, TENANT_B } from './fixtures';
import {
  withComposition,
  type CoreCompositionFactory,
  type CoreCompositionHandle,
} from './harness';

const DEVICE = 'device-1';

/** Roomy enough that no non-admission case is ever refused for capacity. */
const MAILBOX_ENTITLEMENT = { ...ENTITLEMENT, mailboxLimitBytes: 1_000_000n } as const;

/** A `limited` append is admitted against an entitlement; issue one first. */
async function withMailbox(
  factory: CoreCompositionFactory,
  body: (handle: CoreCompositionHandle) => Promise<void>,
): Promise<void> {
  await withComposition(factory, async (handle) => {
    await handle.stores.quota.writeEntitlement(TENANT_A, MAILBOX_ENTITLEMENT);
    await body(handle);
  });
}

async function limitMailbox(stores: CoreStores, version: bigint, mailboxLimitBytes: bigint) {
  await stores.quota.writeEntitlement(TENANT_A, { ...ENTITLEMENT, version, mailboxLimitBytes });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

function fixedBody(deviceId: string, messageId: string, byteSize: number) {
  return {
    deviceId,
    messageId,
    admission: 'limited' as const,
    materialize: () => ({ body: 'x'.repeat(byteSize), bodyHash: hashOf(byteSize), byteSize: BigInt(byteSize) }),
  };
}

function offer(seed: number) {
  return {
    deviceId: DEVICE,
    messageId: `msg-${seed}`,
    admission: 'limited' as const,
    materialize: (seq: number) => {
      const body = `{"type":"task.offer","n":${seed},"seq":${seq}}`;
      return {
        body,
        bodyHash: hashOf(seed),
        byteSize: BigInt(new TextEncoder().encode(body).length),
      };
    },
  };
}

export function runMailboxConformance(factory: CoreCompositionFactory): void {
  describe('mailbox', () => {
    it('assigns a monotonic per-device seq and binds the body to it', async () => {
      await withMailbox(factory, async ({ stores }) => {
        const first = await stores.mailbox.append(TENANT_A, offer(1));
        const second = await stores.mailbox.append(TENANT_A, offer(2));
        const otherDevice = await stores.mailbox.append(TENANT_A, {
          ...offer(3),
          deviceId: 'device-2',
        });

        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(JSON.parse(first.body)).toMatchObject({ seq: first.seq });
        expect(JSON.parse(second.body)).toMatchObject({ seq: second.seq });
        // Sequences are per device, not per tenant: a second device starts over.
        expect(otherDevice.seq).toBe(1);
      });
    });

    it('serializes concurrent materialization in commit order', async () => {
      await withMailbox(factory, async ({ stores }) => {
        const appended = await Promise.all(
          Array.from({ length: 16 }, (_unused, index) =>
            stores.mailbox.append(TENANT_A, offer(index + 1)),
          ),
        );
        // Concurrent callers do not own lock-acquisition order. What the
        // contract promises is one unique monotonic sequence set and rows
        // visible in sequence order, not that Promise input order wins.
        expect(appended.map((message) => message.seq).sort((left, right) => left - right)).toEqual(
          Array.from({ length: 16 }, (_unused, index) => index + 1),
        );

        const page = await stores.mailbox.readAfter(TENANT_A, {
          deviceId: DEVICE,
          afterSeq: 0,
          limit: 20,
        });
        expect(page.messages.map((message) => message.seq)).toEqual(
          Array.from({ length: 16 }, (_unused, index) => index + 1),
        );
        for (const message of page.messages) {
          expect(JSON.parse(message.body)).toMatchObject({ seq: message.seq });
        }
      });
    });

    it('does not consume a sequence when materialization fails', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await expect(
          stores.mailbox.append(TENANT_A, {
            deviceId: DEVICE,
            messageId: 'broken',
            admission: 'limited',
            materialize: () => {
              throw new Error('injected materialization failure');
            },
          }),
        ).rejects.toThrow('injected materialization failure');

        await expect(stores.mailbox.append(TENANT_A, offer(1))).resolves.toMatchObject({ seq: 1 });
      });
    });

    it('is idempotent per messageId', async () => {
      await withMailbox(factory, async ({ stores }) => {
        const first = await stores.mailbox.append(TENANT_A, offer(1));
        const replay = await stores.mailbox.append(TENANT_A, offer(1));
        expect(replay.seq).toBe(first.seq);

        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(1);
      });
    });

    it('materializes once under concurrent idempotent append', async () => {
      await withMailbox(factory, async ({ stores }) => {
        const base = offer(1);
        let materializations = 0;
        const input = {
          ...base,
          materialize: async (seq: number) => {
            materializations += 1;
            await Promise.resolve();
            return base.materialize(seq);
          },
        };
        const replayed = await Promise.all(
          Array.from({ length: 8 }, () => stores.mailbox.append(TENANT_A, input)),
        );

        expect(new Set(replayed.map((message) => message.seq))).toEqual(new Set([1]));
        expect(materializations).toBe(1);
        expect(
          (await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 })).messages,
        ).toHaveLength(1);
      });
    });

    it('does not ack on read', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));

        const first = await stores.mailbox.readAfter(TENANT_A, {
          deviceId: DEVICE,
          afterSeq: 0,
        });
        const second = await stores.mailbox.readAfter(TENANT_A, {
          deviceId: DEVICE,
          afterSeq: 0,
        });

        expect(first.messages.map((message) => message.seq)).toEqual([1, 2]);
        // Byte-for-byte replayable: reading cannot consume.
        expect(second.messages.map((message) => message.seq)).toEqual([1, 2]);

        const cursor = await stores.mailbox.readCursor(TENANT_A, DEVICE);
        expect(cursor.ackedSeq).toBe(0);
      });
    });

    it('acks only through advanceCursor', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, {
          deviceId: DEVICE,
          deliveredSeq: 2,
        });

        const cursor = await stores.mailbox.advanceCursor(TENANT_A, {
          deviceId: DEVICE,
          ackedSeq: 1,
        });
        expect(cursor.ackedSeq).toBe(1);

        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages.map((message) => message.seq)).toEqual([2]);
      });
    });

    it('preserves the zero cursor for a mailbox with no recorded delivery', async () => {
      await withMailbox(factory, async ({ stores }) => {
        const cursor = await stores.mailbox.advanceCursor(TENANT_A, {
          deviceId: DEVICE,
          ackedSeq: 0,
        });
        expect(cursor).toMatchObject({ deliveredSeq: 0, ackedSeq: 0 });
      });
    });

    it('refuses an acknowledgement beyond the recorded delivery watermark without marking rows', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, {
          deviceId: DEVICE,
          deliveredSeq: 1,
        });

        const error = await stores.mailbox
          .advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 2 })
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );

        expect(isCoreConflictError(error, 'mailbox_cursor_ahead_of_delivery')).toBe(true);
        const conflict = error as CoreConflictError<MailboxCursorState>;
        expect(conflict.current).toMatchObject({ deliveredSeq: 1, ackedSeq: 0 });
        expect((await stores.mailbox.readCursor(TENANT_A, DEVICE)).ackedSeq).toBe(0);
        expect(
          (await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 })).messages
            .map((message) => message.seq),
        ).toEqual([1, 2]);
      });
    });

    it('serializes cursor advancement behind an in-flight materializer', async () => {
      await withMailbox(factory, async ({ stores }) => {
        let releaseMaterializer!: () => void;
        let materializerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          materializerStarted = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          releaseMaterializer = resolve;
        });
        const base = offer(1);
        const append = stores.mailbox.append(TENANT_A, {
          ...base,
          materialize: async (seq) => {
            materializerStarted();
            await barrier;
            return base.materialize(seq);
          },
        });
        await started;
        const advance = stores.mailbox
          .recordDelivery(TENANT_A, { deviceId: DEVICE, deliveredSeq: 1 })
          .then(() => stores.mailbox.advanceCursor(TENANT_A, {
            deviceId: DEVICE,
            ackedSeq: 1,
          }));

        releaseMaterializer();
        const [message, cursor] = await Promise.all([append, advance]);
        expect(message.seq).toBe(1);
        expect(cursor.ackedSeq).toBe(1);
        await expect(
          stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 }),
        ).resolves.toMatchObject({ messages: [] });
      });
    });

    it('refuses to move the cursor backwards and returns the current cursor', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, {
          deviceId: DEVICE,
          deliveredSeq: 2,
        });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 2 });

        const error = await stores.mailbox
          .advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 1 })
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );

        expect(isCoreConflictError(error, 'mailbox_cursor_regression')).toBe(true);
        const conflict = error as CoreConflictError<MailboxCursorState>;
        expect(conflict.current.ackedSeq).toBe(2);
        expect(conflict.observedAt).toBeTypeOf('string');
      });
    });

    it('deletes acked rows on retention and dead-letters unacked ones', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, {
          deviceId: DEVICE,
          deliveredSeq: 1,
        });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 1 });

        const result = await stores.mailbox.collectExpired(TENANT_A, { now: '2999-01-01T00:00:00.000Z', limit: 500,
          ackedBefore: '2999-01-01T00:00:00.000Z',
          expireUnackedBefore: '2999-01-01T00:00:00.000Z',
          reapDeadLettersBefore: '1970-01-01T00:00:00.000Z',
        });

        expect(result.removed).toBe(1);
        expect(result.expired).toBe(1);
        expect(result.releasedBytes).toBe(0n);

        // Retention reports the dead-lettered row separately from the deleted
        // one, so an operator can tell "consumed" from "never consumed".
        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(0);
      });
    });

    it('moves the recoverable floor past rows lost to expiry', async () => {
      await withMailbox(factory, async (handle) => {
        const { stores } = handle;
        // A mailbox nobody has written to has lost nothing, so a fresh device's
        // cursor 0 is inside the window rather than behind a floor it could
        // never have met.
        expect(
          (await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 })).recoverableFrom,
        ).toBe(1);

        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await handle.advanceTime(1_000);
        const cutoff = handle.now();
        await stores.mailbox.append(TENANT_A, offer(3));
        await stores.mailbox.append(TENANT_A, offer(4));

        expect(
          (await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 })).recoverableFrom,
        ).toBe(1);

        // Dead-letters 1 and 2 (appended before the cutoff), leaves 3 and 4.
        const swept = await stores.mailbox.collectExpired(TENANT_A, { now: '2999-01-01T00:00:00.000Z', limit: 500,
          ackedBefore: cutoff,
          expireUnackedBefore: cutoff,
          reapDeadLettersBefore: '1970-01-01T00:00:00.000Z',
        });
        expect(swept).toMatchObject({ removed: 0, expired: 2 });

        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages.map((message) => message.seq)).toEqual([3, 4]);
        expect(page.recoverableFrom).toBe(3);

        // The floor is a property of the mailbox, not of the query: reading
        // from further along reports the same floor, and a reader at exactly
        // `recoverableFrom - 1` is still handed the first retained row.
        const atFloor = await stores.mailbox.readAfter(TENANT_A, {
          deviceId: DEVICE,
          afterSeq: page.recoverableFrom - 1,
        });
        expect(atFloor.recoverableFrom).toBe(3);
        expect(atFloor.messages.map((message) => message.seq)).toEqual([3, 4]);
      });
    });

    it('leaves the recoverable floor where it is when acked rows are retired', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, { deviceId: DEVICE, deliveredSeq: 2 });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 2 });

        const swept = await stores.mailbox.collectExpired(TENANT_A, { now: '2999-01-01T00:00:00.000Z', limit: 500,
          ackedBefore: '2999-01-01T00:00:00.000Z',
          expireUnackedBefore: '2999-01-01T00:00:00.000Z',
          reapDeadLettersBefore: '1970-01-01T00:00:00.000Z',
        });
        expect(swept).toMatchObject({ removed: 2, expired: 0 });

        // Consumed is not lost. The device acked these rows before they were
        // deleted, so nothing about that sweep may turn a re-poll from an old
        // cursor — which at-least-once explicitly permits — into a gap.
        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(0);
        expect(page.recoverableFrom).toBe(1);
      });
    });

    it('expirePending dead-letters only the named pending rows of one device', async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        const third = await stores.mailbox.append(TENANT_A, offer(3));
        const other = await stores.mailbox.append(TENANT_A, { ...offer(4), deviceId: 'device-2' });
        await stores.mailbox.recordDelivery(TENANT_A, { deviceId: DEVICE, deliveredSeq: 1 });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 1 });

        // An acked seq and an unknown seq are skipped; only pending row 2 moves.
        await expect(
          stores.mailbox.expirePending(TENANT_A, { deviceId: DEVICE, seqs: [1, 2, 99] }),
        ).resolves.toEqual({ expired: 1 });
        let page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages.map((message) => message.seq)).toEqual([3]);
        expect(page.recoverableFrom).toBe(3);
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(third.byteSize + other.byteSize);

        await expect(
          stores.mailbox.expirePending(TENANT_A, { deviceId: DEVICE, seqs: 'all' }),
        ).resolves.toEqual({ expired: 1 });
        await expect(
          stores.mailbox.expirePending(TENANT_A, { deviceId: DEVICE, seqs: 'all' }),
        ).resolves.toEqual({ expired: 0 });
        page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(0);
        expect(page.recoverableFrom).toBe(4);
        // The cursor is untouched, the other device keeps its row, and the
        // allocator keeps counting: nothing expired comes back as pending.
        await expect(stores.mailbox.readCursor(TENANT_A, DEVICE)).resolves.toMatchObject({ ackedSeq: 1, deliveredSeq: 1 });
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(other.byteSize);
        const next = await stores.mailbox.append(TENANT_A, offer(5));
        expect(next).toMatchObject({ seq: 4, state: 'pending' });
        page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages.map((message) => message.seq)).toEqual([4]);
        await expect(
          stores.mailbox.expirePending(TENANT_B, { deviceId: DEVICE, seqs: 'all' }),
        ).resolves.toEqual({ expired: 0 });
      });
    });
  });

  describe('mailbox admission', () => {
    it('counts only pending rows in readUsage', async () => {
      await withMailbox(factory, async ({ stores }) => {
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);
        const first = await stores.mailbox.append(TENANT_A, offer(1));
        const second = await stores.mailbox.append(TENANT_A, offer(2));
        const other = await stores.mailbox.append(TENANT_A, { ...offer(3), deviceId: 'device-2' });
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(
          first.byteSize + second.byteSize + other.byteSize,
        );

        await stores.mailbox.recordDelivery(TENANT_A, { deviceId: DEVICE, deliveredSeq: 1 });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 1 });
        // The ack releases the row's bytes even though retention still keeps it.
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(
          second.byteSize + other.byteSize,
        );

        const swept = await stores.mailbox.collectExpired(TENANT_A, { now: '2999-01-01T00:00:00.000Z', limit: 500,
          ackedBefore: '2999-01-01T00:00:00.000Z',
          expireUnackedBefore: '2999-01-01T00:00:00.000Z',
          reapDeadLettersBefore: '1970-01-01T00:00:00.000Z',
        });
        expect(swept).toMatchObject({ removed: 1, expired: 2, releasedBytes: 0n });
        // Dead letters stay visible but hold no quota.
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);
      });
    });

    it('admits new work into a mailbox filled only by dead letters (#1115)', async () => {
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        await limitMailbox(stores, 1n, 20n);
        await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'lost', 20));
        expect(
          isCoreError(
            await captureError(stores.mailbox.append(TENANT_A, fixedBody('device-2', 'blocked', 20))),
            'storage_quota_exceeded',
          ),
        ).toBe(true);

        await handle.advanceTime(1_000);
        const cutoff = handle.now();
        const swept = await stores.mailbox.collectExpired(TENANT_A, { now: cutoff, limit: 500,
          ackedBefore: cutoff,
          expireUnackedBefore: cutoff,
          reapDeadLettersBefore: '1970-01-01T00:00:00.000Z',
        });
        expect(swept).toMatchObject({ removed: 0, expired: 1 });

        // The dead letter is retained and still moves the recoverable floor,
        // but the tenant can dispatch again on any device.
        const fresh = await stores.mailbox.append(TENANT_A, fixedBody('device-2', 'fresh', 20));
        expect(fresh).toMatchObject({ seq: 1, state: 'pending' });
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(20n);
        expect(
          (await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 })).recoverableFrom,
        ).toBe(2);
      });
    });

    it('admits new work once the device acks the rows that filled the mailbox', async () => {
      await withComposition(factory, async ({ stores }) => {
        await limitMailbox(stores, 1n, 20n);
        const first = await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'delivered', 20));
        await stores.mailbox.recordDelivery(TENANT_A, { deviceId: DEVICE, deliveredSeq: first.seq });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: first.seq });

        const next = await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'next', 20));
        expect(next).toMatchObject({ seq: 2, state: 'pending' });
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(20n);
      });
    });

    it('refuses a limited append over mailboxLimitBytes without consuming a seq', async () => {
      await withComposition(factory, async ({ stores }) => {
        await limitMailbox(stores, 1n, 25n);
        const first = await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'fits', 20));
        expect(first.seq).toBe(1);

        const over = await captureError(
          stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'over', 6)),
        );
        expect(isCoreError(over, 'storage_quota_exceeded')).toBe(true);
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(20n);

        await limitMailbox(stores, 2n, 26n);
        const next = await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'after-raise', 6));
        expect(next.seq).toBe(2);
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(26n);
      });
    });

    it('returns the existing row for a replayed messageId when the mailbox is full', async () => {
      await withComposition(factory, async ({ stores }) => {
        await limitMailbox(stores, 1n, 20n);
        const first = await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'full', 20));

        const replay = await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'full', 20));
        expect(replay).toMatchObject({ seq: first.seq, messageId: 'full' });
        const fresh = await captureError(
          stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'fresh', 1)),
        );
        expect(isCoreError(fresh, 'storage_quota_exceeded')).toBe(true);
      });
    });

    it('admits a cancellation over the limit and counts it', async () => {
      await withComposition(factory, async ({ stores }) => {
        await limitMailbox(stores, 1n, 20n);
        await stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'full', 20));

        const cancellation = await stores.mailbox.append(TENANT_A, {
          ...fixedBody(DEVICE, 'cancel', 7),
          admission: 'cancellation',
        });
        expect(cancellation.seq).toBe(2);
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(27n);

        const after = await captureError(
          stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'after-cancel', 1)),
        );
        expect(isCoreError(after, 'storage_quota_exceeded')).toBe(true);
      });
    });

    it('refuses a limited append when the tenant has no entitlement', async () => {
      await withComposition(factory, async ({ stores }) => {
        const missing = await captureError(
          stores.mailbox.append(TENANT_A, fixedBody(DEVICE, 'unentitled', 2)),
        );
        expect(isCoreError(missing, 'storage_entitlement_missing')).toBe(true);
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);

        // The cancellation exemption does not depend on an entitlement either.
        const cancellation = await stores.mailbox.append(TENANT_A, {
          ...fixedBody(DEVICE, 'unentitled-cancel', 2),
          admission: 'cancellation',
        });
        expect(cancellation.seq).toBe(1);
      });
    });

    it('does not oversell under concurrent appends across devices', async () => {
      await withComposition(factory, async ({ stores }) => {
        // Exactly ten 10-byte rows fit; forty race for them across 8 devices.
        await limitMailbox(stores, 1n, 100n);
        const outcomes = await Promise.allSettled(
          Array.from({ length: 40 }, (_unused, index) =>
            stores.mailbox.append(
              TENANT_A,
              fixedBody(`device-${index % 8}`, `race-${index}`, 10),
            ),
          ),
        );

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(10);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect(isCoreError(outcome.reason, 'storage_quota_exceeded')).toBe(true);
          }
        }
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(100n);
      });
    });

    it("keeps another tenant's usage at zero", async () => {
      await withMailbox(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBeGreaterThan(0n);
        expect((await stores.mailbox.readUsage(TENANT_B)).bytes).toBe(0n);
      });
    });
  });
}
