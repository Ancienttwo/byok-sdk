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
    body: `{"type":"task.offer","n":${seed}}`,
    bodyHash: hashOf(seed),
    byteSize: BigInt(seed + 10),
    messageId: `msg-${seed}`,
  };
}

export function runMailboxConformance(factory: CoreCompositionFactory): void {
  describe('mailbox', () => {
    it('assigns a monotonic per-device seq starting at 1', async () => {
      await withComposition(factory, async ({ stores }) => {
        const first = await stores.mailbox.append(TENANT_A, offer(1));
        const second = await stores.mailbox.append(TENANT_A, offer(2));
        const otherDevice = await stores.mailbox.append(TENANT_A, {
          ...offer(3),
          deviceId: 'device-2',
        });

        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        // Sequences are per device, not per tenant: a second device starts over.
        expect(otherDevice.seq).toBe(1);
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

        const cursor = await stores.mailbox.advanceCursor(TENANT_A, {
          deviceId: DEVICE,
          ackedSeq: 1,
        });
        expect(cursor.ackedSeq).toBe(1);

        const page = await stores.mailbox.readAfter(TENANT_A, { deviceId: DEVICE, afterSeq: 0 });
        expect(page.messages.map((message) => message.seq)).toEqual([2]);
      });
    });

    it('refuses to move the cursor backwards and returns the current cursor', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, offer(1));
        await stores.mailbox.append(TENANT_A, offer(2));
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
  });
}
