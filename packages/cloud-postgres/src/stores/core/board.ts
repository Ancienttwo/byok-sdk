/**
 * Postgres {@link BoardStore} (§12.3).
 *
 * Every mutation is one guarded `UPDATE ... WHERE`, and the guard carries the
 * caller's whole expectation: who holds the item, what status it is in, and —
 * for `claim` — that it is claimable at all. Zero rows is the rejection, and
 * the store then re-reads the item to say WHICH rejection and to hand the
 * caller the snapshot it lost to. A conflict that reports only "conflict"
 * forces a second round trip and invites a retry loop that eventually
 * overwrites the winner (§12.3: no silent last-write-wins).
 *
 * The concurrent-claim property comes out of Postgres' own re-check: three
 * sessions issue the same `UPDATE ... WHERE holder_id IS NULL`, one wins, and
 * the other two re-evaluate the qual against the winner's committed row and
 * match nothing. The suite asserts the outcome, not the mechanism — the
 * in-memory reference gets the same outcome from its `await` boundaries.
 *
 * **`board_seq` is allocated in its own statement, before the guarded write.**
 * Folding the allocator into a data-modifying CTE would let one session lock
 * `tenant_stream` then `board_item` while another locks them in the order the
 * planner picked for it, which is a deadlock rather than a conflict. Allocating
 * first, in an autocommitted statement that releases immediately, gives every
 * writer one lock order. A rejected write therefore burns a sequence number:
 * `boardSeq` is contractually monotonic, never contractually gapless, and the
 * incremental feed reads `> afterSeq` either way.
 */
import {
  ByokCoreError,
  CoreConflictError,
  isLegalBoardTransition,
  type BoardClaimInput,
  type BoardItem,
  type BoardItemInput,
  type BoardListQuery,
  type BoardPage,
  type BoardStatus,
  type BoardStatusUpdateInput,
  type BoardStore,
  type BoardUnclaimInput,
  type Clock,
  type TenantId,
} from '@byok-sdk/core';
import type { Pool } from 'pg';

const DEFAULT_LIST_LIMIT = 50;

const BOARD_COLUMNS =
  'tenant_id, item_id, channel, title, status, holder_id, held_since, board_seq, created_at, updated_at';

interface BoardRow {
  readonly tenant_id: string;
  readonly item_id: string;
  readonly channel: string;
  readonly title: string;
  readonly status: string;
  readonly holder_id: string | null;
  readonly held_since: string | null;
  readonly board_seq: bigint;
  readonly created_at: string;
  readonly updated_at: string;
}

function toItem(row: BoardRow): BoardItem {
  return {
    tenantId: row.tenant_id as TenantId,
    itemId: row.item_id,
    channel: row.channel,
    title: row.title,
    status: row.status as BoardStatus,
    // An unheld item has NO assignee rather than an assignee with an empty
    // holder, which is what lets `expect(item.assignee).toBeUndefined()` mean
    // "nobody holds this" in both compositions.
    ...(row.holder_id === null || row.held_since === null
      ? {}
      : { assignee: { holderId: row.holder_id, heldSince: row.held_since } }),
    boardSeq: Number(row.board_seq),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresBoardStore implements BoardStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async create(tenant: TenantId, input: BoardItemInput): Promise<BoardItem> {
    const now = this.#now();
    const boardSeq = await this.#allocateSeq(tenant);
    const inserted = await this.#pool.query<BoardRow>(
      `INSERT INTO board_item (${BOARD_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6::bigint, $7, $7)
       ON CONFLICT (tenant_id, item_id) DO NOTHING
       RETURNING ${BOARD_COLUMNS}`,
      [tenant, input.itemId, input.channel, input.title, input.status ?? 'todo', boardSeq, now],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new ByokCoreError(
        'board_item_exists',
        `Board item ${input.itemId} already exists in this tenant.`,
      );
    }
    return toItem(row);
  }

  async get(tenant: TenantId, itemId: string): Promise<BoardItem | undefined> {
    const result = await this.#pool.query<BoardRow>(
      `SELECT ${BOARD_COLUMNS} FROM board_item WHERE tenant_id = $1 AND item_id = $2`,
      [tenant, itemId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toItem(row);
  }

  async list(tenant: TenantId, query: BoardListQuery): Promise<BoardPage> {
    const afterSeq = query.afterSeq ?? 0;
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const result = await this.#pool.query<BoardRow>(
      `SELECT ${BOARD_COLUMNS} FROM board_item
        WHERE tenant_id = $1
          AND board_seq > $2::bigint
          AND ($3::text IS NULL OR channel = $3::text)
          AND ($4::text IS NULL OR status = $4::text)
        ORDER BY board_seq
        LIMIT $5`,
      [tenant, afterSeq, query.channel ?? null, query.status ?? null, limit + 1],
    );

    const page = result.rows.slice(0, limit).map(toItem);
    return {
      items: page,
      nextSeq: page.at(-1)?.boardSeq ?? afterSeq,
      hasMore: result.rows.length > page.length,
    };
  }

  async claim(tenant: TenantId, input: BoardClaimInput): Promise<BoardItem> {
    const expectedStatus = input.expectedStatus ?? 'todo';
    const now = this.#now();
    const boardSeq = await this.#allocateSeq(tenant);

    // `holder_id IS NULL` is the CAS on "unheld"; `status = $4` is the caller's
    // status expectation; `status IN ('todo','in_progress')` is the claimability
    // rule. All three in one guard, so exactly one concurrent caller wins.
    const claimed = await this.#pool.query<BoardRow>(
      `UPDATE board_item
          SET status    = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END,
              holder_id = $3,
              held_since = $5,
              board_seq = $6::bigint,
              updated_at = $5
        WHERE tenant_id = $1 AND item_id = $2
          AND holder_id IS NULL
          AND status = $4::text
          AND status IN ('todo', 'in_progress')
       RETURNING ${BOARD_COLUMNS}`,
      [tenant, input.itemId, input.holderId, expectedStatus, now, boardSeq],
    );
    const won = claimed.rows[0];
    if (won !== undefined) return toItem(won);

    const current = await this.get(tenant, input.itemId);
    if (current === undefined) throw this.#itemNotFound(input.itemId);

    if (current.assignee !== undefined) {
      if (current.assignee.holderId === input.holderId) {
        // The same holder retrying is not a second winner. But an EXPLICIT
        // `expectedStatus` is a full CAS by contract, and short-circuiting past
        // it here would let the holder's retry confirm a status it no longer
        // believes in. The `todo` default is deliberately not applied on this
        // path: a retry of a successful claim legitimately observes
        // `in_progress`.
        if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) {
          throw this.#statusConflict(input.itemId, current, input.expectedStatus);
        }
        return current;
      }
      throw new CoreConflictError(
        'board_claim_conflict',
        `Board item ${input.itemId} is held by ${current.assignee.holderId}.`,
        current,
        this.#now(),
      );
    }
    if (current.status !== expectedStatus) {
      throw this.#statusConflict(input.itemId, current, expectedStatus);
    }
    throw new CoreConflictError(
      'board_transition_invalid',
      `Board item ${input.itemId} cannot be claimed from ${current.status}.`,
      current,
      this.#now(),
    );
  }

  async unclaim(tenant: TenantId, input: BoardUnclaimInput): Promise<BoardItem> {
    const now = this.#now();
    const boardSeq = await this.#allocateSeq(tenant);

    // Releasing someone else's item is not a legal move, so the holder is part
    // of the guard rather than a comparison the caller is trusted to have made.
    const released = await this.#pool.query<BoardRow>(
      `UPDATE board_item
          SET status     = CASE WHEN status = 'in_progress' THEN 'todo' ELSE status END,
              holder_id  = NULL,
              held_since = NULL,
              board_seq  = $4::bigint,
              updated_at = $5
        WHERE tenant_id = $1 AND item_id = $2 AND holder_id = $3
       RETURNING ${BOARD_COLUMNS}`,
      [tenant, input.itemId, input.holderId, boardSeq, now],
    );
    const row = released.rows[0];
    if (row !== undefined) return toItem(row);

    const current = await this.get(tenant, input.itemId);
    if (current === undefined) throw this.#itemNotFound(input.itemId);
    if (current.assignee === undefined) {
      throw new ByokCoreError(
        'board_not_held',
        `Board item ${input.itemId} is not held by anyone.`,
      );
    }
    throw new CoreConflictError(
      'board_claim_conflict',
      `Board item ${input.itemId} is held by ${current.assignee.holderId}, not ${input.holderId}.`,
      current,
      this.#now(),
    );
  }

  async updateStatus(tenant: TenantId, input: BoardStatusUpdateInput): Promise<BoardItem> {
    // Legality is a pure function of two caller-supplied values, so it is
    // decided before the statement rather than smuggled into the guard as a
    // boolean parameter. An illegal move skips the write entirely and falls
    // straight to the rejection ladder below, whose order is the contract's:
    // a missed `expectedStatus` outranks a holder mismatch, which outranks an
    // illegal transition.
    if (isLegalBoardTransition(input.expectedStatus, input.status)) {
      const now = this.#now();
      const boardSeq = await this.#allocateSeq(tenant);
      const updated = await this.#pool.query<BoardRow>(
        `UPDATE board_item
            SET status = $4::text, board_seq = $6::bigint, updated_at = $7
          WHERE tenant_id = $1 AND item_id = $2
            AND status = $3::text
            AND ($5::text IS NULL OR holder_id = $5::text)
         RETURNING ${BOARD_COLUMNS}`,
        [
          tenant,
          input.itemId,
          input.expectedStatus,
          input.status,
          input.holderId ?? null,
          boardSeq,
          now,
        ],
      );
      const row = updated.rows[0];
      if (row !== undefined) return toItem(row);
    }

    const current = await this.get(tenant, input.itemId);
    if (current === undefined) throw this.#itemNotFound(input.itemId);
    if (current.status !== input.expectedStatus) {
      throw this.#statusConflict(input.itemId, current, input.expectedStatus);
    }
    if (input.holderId !== undefined && current.assignee?.holderId !== input.holderId) {
      throw new CoreConflictError(
        'board_claim_conflict',
        `Board item ${input.itemId} is not held by ${input.holderId}.`,
        current,
        this.#now(),
      );
    }
    if (!isLegalBoardTransition(input.expectedStatus, input.status)) {
      throw new CoreConflictError(
        'board_transition_invalid',
        `${input.expectedStatus} to ${input.status} is not a legal board transition.`,
        current,
        this.#now(),
      );
    }
    // Every guard the CAS checked reads as satisfied now, so the row moved and
    // moved back between the write and this read. The caller lost a race, and
    // saying so with the current snapshot is more useful than retrying into it.
    throw this.#statusConflict(input.itemId, current, input.expectedStatus);
  }

  /**
   * One statement, its own transaction, lock released immediately. See the file
   * header for why this is not a CTE inside the write it feeds.
   */
  async #allocateSeq(tenant: TenantId): Promise<bigint> {
    const result = await this.#pool.query<{ board_seq: bigint }>(
      `INSERT INTO tenant_stream (tenant_id, board_seq)
       VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET board_seq = tenant_stream.board_seq + 1
       RETURNING board_seq`,
      [tenant],
    );
    return result.rows[0]!.board_seq;
  }

  #itemNotFound(itemId: string): ByokCoreError {
    return new ByokCoreError(
      'board_item_not_found',
      `Board item ${itemId} does not exist in this tenant.`,
    );
  }

  #statusConflict(
    itemId: string,
    current: BoardItem,
    expected: BoardStatus,
  ): CoreConflictError<BoardItem> {
    return new CoreConflictError(
      'board_status_conflict',
      `Board item ${itemId} is ${current.status}, not ${expected}.`,
      current,
      this.#now(),
    );
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
