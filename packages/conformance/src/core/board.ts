/**
 * Board conformance (§12.3).
 *
 * The load-bearing assertion is the concurrent claim: N callers race, exactly
 * one wins, and every loser receives the winner's holder snapshot plus the
 * instant it was observed. A composition that returns a bare failure forces the
 * loser into a second round trip and invites a retry loop that eventually
 * overwrites the winner.
 */
import { describe, expect, it } from 'vitest';
import { isCoreConflictError, type BoardItem, type CoreConflictError } from '@byok-sdk/core';
import { TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

function newItem(id: string) {
  return { itemId: id, channel: 'support', title: `Work item ${id}` };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

export function runBoardConformance(factory: CoreCompositionFactory): void {
  describe('board', () => {
    it('creates items in todo with a monotonic per-tenant boardSeq', async () => {
      await withComposition(factory, async ({ stores }) => {
        const first = await stores.board.create(TENANT_A, newItem('item-1'));
        const second = await stores.board.create(TENANT_A, newItem('item-2'));

        expect(first.status).toBe('todo');
        expect(first.assignee).toBeUndefined();
        expect(second.boardSeq).toBeGreaterThan(first.boardSeq);
      });
    });

    it('admits exactly one winner per claim and hands losers the holder snapshot', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));

        const attempts = await Promise.allSettled(
          ['device-1', 'device-2', 'device-3'].map((holderId) =>
            stores.board.claim(TENANT_A, { itemId: 'item-1', holderId }),
          ),
        );

        const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
        const losers = attempts.filter((attempt) => attempt.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(2);

        const winner = (winners[0] as PromiseFulfilledResult<BoardItem>).value;
        expect(winner.status).toBe('in_progress');
        expect(winner.assignee?.holderId).toBeTypeOf('string');

        for (const loser of losers) {
          const reason = (loser as PromiseRejectedResult).reason as unknown;
          expect(isCoreConflictError(reason, 'board_claim_conflict')).toBe(true);
          const conflict = reason as CoreConflictError<BoardItem>;
          expect(conflict.current.assignee?.holderId).toBe(winner.assignee?.holderId);
          expect(conflict.observedAt).toBeTypeOf('string');
        }
      });
    });

    it('treats a re-claim by the current holder as idempotent', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));
        const claimed = await stores.board.claim(TENANT_A, {
          itemId: 'item-1',
          holderId: 'device-1',
        });
        const again = await stores.board.claim(TENANT_A, {
          itemId: 'item-1',
          holderId: 'device-1',
        });
        expect(again.assignee?.heldSince).toBe(claimed.assignee?.heldSince);
      });
    });

    it('still enforces an explicit expectedStatus on the holder re-claim path', async () => {
      // Without this, "supplying expectedStatus makes the claim a full CAS" is
      // true only for the first claim: the holder's retry would short-circuit
      // past the comparison and confirm a status it no longer believes in.
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));
        const claimed = await stores.board.claim(TENANT_A, {
          itemId: 'item-1',
          holderId: 'device-1',
        });
        expect(claimed.status).toBe('in_progress');

        const stale = await captureError(
          stores.board.claim(TENANT_A, {
            itemId: 'item-1',
            holderId: 'device-1',
            expectedStatus: 'todo',
          }),
        );
        expect(isCoreConflictError(stale, 'board_status_conflict')).toBe(true);
        expect((stale as CoreConflictError<BoardItem>).current.status).toBe('in_progress');
        expect((stale as CoreConflictError<BoardItem>).current.assignee?.holderId).toBe(
          'device-1',
        );

        // A matching expectation is still the idempotent retry.
        const again = await stores.board.claim(TENANT_A, {
          itemId: 'item-1',
          holderId: 'device-1',
          expectedStatus: 'in_progress',
        });
        expect(again.assignee?.heldSince).toBe(claimed.assignee?.heldSince);
      });
    });

    it('releases only to the holder and returns the item to todo', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));
        await stores.board.claim(TENANT_A, { itemId: 'item-1', holderId: 'device-1' });

        const wrongHolder = await captureError(
          stores.board.unclaim(TENANT_A, { itemId: 'item-1', holderId: 'device-2' }),
        );
        expect(isCoreConflictError(wrongHolder, 'board_claim_conflict')).toBe(true);

        const released = await stores.board.unclaim(TENANT_A, {
          itemId: 'item-1',
          holderId: 'device-1',
        });
        expect(released.status).toBe('todo');
        expect(released.assignee).toBeUndefined();
      });
    });

    it('requires expectedStatus and returns the current item on a miss', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));
        await stores.board.claim(TENANT_A, { itemId: 'item-1', holderId: 'device-1' });

        const stale = await captureError(
          stores.board.updateStatus(TENANT_A, {
            itemId: 'item-1',
            expectedStatus: 'todo',
            status: 'in_progress',
          }),
        );
        expect(isCoreConflictError(stale, 'board_status_conflict')).toBe(true);
        expect((stale as CoreConflictError<BoardItem>).current.status).toBe('in_progress');

        const reviewed = await stores.board.updateStatus(TENANT_A, {
          itemId: 'item-1',
          expectedStatus: 'in_progress',
          status: 'in_review',
        });
        expect(reviewed.status).toBe('in_review');
      });
    });

    it('rejects a transition outside the legal table with the current snapshot', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));

        // A terminal record can push work to review; only a human accepts it.
        const illegal = await captureError(
          stores.board.updateStatus(TENANT_A, {
            itemId: 'item-1',
            expectedStatus: 'todo',
            status: 'done',
          }),
        );
        expect(isCoreConflictError(illegal, 'board_transition_invalid')).toBe(true);
        expect((illegal as CoreConflictError<BoardItem>).current.status).toBe('todo');
      });
    });

    it('lists incrementally by boardSeq', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, newItem('item-1'));
        const second = await stores.board.create(TENANT_A, newItem('item-2'));

        const page = await stores.board.list(TENANT_A, { afterSeq: 0 });
        expect(page.items.map((item) => item.itemId)).toEqual(['item-1', 'item-2']);
        expect(page.nextSeq).toBe(second.boardSeq);

        const empty = await stores.board.list(TENANT_A, { afterSeq: second.boardSeq });
        expect(empty.items).toHaveLength(0);
        expect(empty.nextSeq).toBe(second.boardSeq);
      });
    });
  });
}
