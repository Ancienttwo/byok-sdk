/**
 * Mailbox conformance (§12.7.3).
 *
 * The assertion this group exists for is "read does not ack". Everything else
 * here is scaffolding around it: if a composition ever deletes or marks rows on
 * read, the frozen at-least-once contract the client's stall recovery depends
 * on is gone, and it goes silently — the happy path still looks fine.
 */
import { describe, expect, it } from 'vitest';
import { isCoreConflictError, type CoreConflictError, type MailboxCursorState } from '@byok-sdk/core';
import { hashOf, TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

const DEVICE = 'device-1';

function offer(seed: number) {
  return {
    deviceId: DEVICE,
    messageId: `msg-${seed}`,
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
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
        await expect(
          stores.mailbox.append(TENANT_A, {
            deviceId: DEVICE,
            messageId: 'broken',
            materialize: () => {
              throw new Error('injected materialization failure');
            },
          }),
        ).rejects.toThrow('injected materialization failure');

        await expect(stores.mailbox.append(TENANT_A, offer(1))).resolves.toMatchObject({ seq: 1 });
      });
    });

    it('is idempotent per messageId', async () => {
      await withComposition(factory, async ({ stores }) => {
        const first = await stores.mailbox.append(TENANT_A, offer(1));
        const replay = await stores.mailbox.append(TENANT_A, offer(1));
        expect(replay.seq).toBe(first.seq);

        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(1);
      });
    });

    it('materializes once under concurrent idempotent append', async () => {
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
        const cursor = await stores.mailbox.advanceCursor(TENANT_A, {
          deviceId: DEVICE,
          ackedSeq: 0,
        });
        expect(cursor).toMatchObject({ deliveredSeq: 0, ackedSeq: 0 });
      });
    });

    it('refuses an acknowledgement beyond the recorded delivery watermark without marking rows', async () => {
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
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
      await withComposition(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, {
          deviceId: DEVICE,
          deliveredSeq: 1,
        });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 1 });

        const result = await stores.mailbox.collectRetired(TENANT_A, {
          deviceId: DEVICE,
          ackedBefore: '2999-01-01T00:00:00.000Z',
          expireUnackedBefore: '2999-01-01T00:00:00.000Z',
        });

        expect(result.deletedCount).toBe(1);
        expect(result.expiredCount).toBe(1);
        expect(result.releasedBytes).toBeGreaterThan(0n);

        // Retention reports the dead-lettered row separately from the deleted
        // one, so an operator can tell "consumed" from "never consumed".
        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(0);
      });
    });

    it('moves the recoverable floor past rows lost to expiry', async () => {
      await withComposition(factory, async (handle) => {
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
        const swept = await stores.mailbox.collectRetired(TENANT_A, {
          deviceId: DEVICE,
          ackedBefore: cutoff,
          expireUnackedBefore: cutoff,
        });
        expect(swept).toMatchObject({ deletedCount: 0, expiredCount: 2 });

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
      await withComposition(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
        await stores.mailbox.recordDelivery(TENANT_A, { deviceId: DEVICE, deliveredSeq: 2 });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: DEVICE, ackedSeq: 2 });

        const swept = await stores.mailbox.collectRetired(TENANT_A, {
          deviceId: DEVICE,
          ackedBefore: '2999-01-01T00:00:00.000Z',
          expireUnackedBefore: '2999-01-01T00:00:00.000Z',
        });
        expect(swept).toMatchObject({ deletedCount: 2, expiredCount: 0 });

        // Consumed is not lost. The device acked these rows before they were
        // deleted, so nothing about that sweep may turn a re-poll from an old
        // cursor — which at-least-once explicitly permits — into a gap.
        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages).toHaveLength(0);
        expect(page.recoverableFrom).toBe(1);
      });
    });
  });
}
