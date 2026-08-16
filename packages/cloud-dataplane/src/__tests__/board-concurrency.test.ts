import { fileURLToPath } from 'node:url';
import {
  createMutableClock,
  isCoreConflictError,
  tenantId,
  type BoardItem,
  type CoreConflictError,
} from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresBoardStore } from '../stores/core/board';
import { PostgresActivityStore } from '../stores/activity';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_A = tenantId('board-race-a');
const TENANT_B = tenantId('board-race-b');

describe.skipIf(SKIP_DATAPLANE)('Postgres board concurrency and I6', () => {
  it('admits exactly one winner across 100 claims and returns its snapshot to all losers', async () => {
    const scope = await createDataplaneScope(32);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const board = new PostgresBoardStore(scope.pool, createMutableClock());
      await board.create(TENANT_A, { itemId: 'race', channel: 'ops', title: 'Race' });

      const attempts = await Promise.allSettled(
        Array.from({ length: 100 }, (_, index) =>
          board.claim(TENANT_A, { itemId: 'race', holderId: `device-${index}` }),
        ),
      );
      const winners = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<BoardItem> => attempt.status === 'fulfilled',
      );
      const losers = attempts.filter(
        (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(99);
      const holderId = winners[0]!.value.assignee!.holderId;
      for (const loser of losers) {
        expect(isCoreConflictError(loser.reason, 'board_claim_conflict')).toBe(true);
        const conflict = loser.reason as CoreConflictError<BoardItem>;
        expect(conflict.current.assignee?.holderId).toBe(holderId);
        expect(conflict.observedAt).toBeTypeOf('string');
      }
    } finally {
      await scope.dispose();
    }
  });

  it('allocates and reads board sequence independently per tenant', async () => {
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const board = new PostgresBoardStore(scope.pool, createMutableClock());
      const [a1, b1] = await Promise.all([
        board.create(TENANT_A, { itemId: 'a-1', channel: 'ops', title: 'A1' }),
        board.create(TENANT_B, { itemId: 'b-1', channel: 'ops', title: 'B1' }),
      ]);
      await board.create(TENANT_B, { itemId: 'b-2', channel: 'ops', title: 'B2' });

      expect(a1.boardSeq).toBe(1);
      expect(b1.boardSeq).toBe(1);
      expect(await board.list(TENANT_A, { afterSeq: 1 })).toEqual({
        items: [],
        nextSeq: 1,
        hasMore: false,
      });
      expect((await board.list(TENANT_B, { afterSeq: 0 })).items.map((item) => item.itemId)).toEqual([
        'b-1',
        'b-2',
      ]);
    } finally {
      await scope.dispose();
    }
  });

  it('serializes a 100-batch activity burst without loss and returns stable order', async () => {
    const scope = await createDataplaneScope(32);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const activity = new PostgresActivityStore(scope.pool, createMutableClock());
      await Promise.all(
        Array.from({ length: 100 }, (_, index) => activity.append(TENANT_A, {
          taskId: 'activity-race',
          sourceEnvelopeId: `envelope-${index + 1}`,
          batchSeq: index + 1,
          events: [{ type: 'progress', text: `event-${index + 1}` }],
          dropped: 0,
          ttlMs: 60_000,
          capacity: 100,
        })),
      );
      const tail = await activity.read(TENANT_A, 'activity-race');
      expect(tail?.entries).toHaveLength(100);
      expect(tail?.entries.map((entry) => entry.batchSeq)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1),
      );
      expect(tail?.cursor).toEqual({ batchSeq: 100, eventIndex: 0 });
      expect(tail?.dropped).toBe(0);
    } finally {
      await scope.dispose();
    }
  });
});
