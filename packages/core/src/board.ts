/**
 * Board coordination state (§12.3).
 *
 * This is the *human and multi-device* collaboration lifecycle, and it is a
 * separate vocabulary from the frozen wire execution vocabulary on purpose. One
 * run attempt is not one work item: an item can outlive several attempts, and a
 * finished attempt does not mean a human accepted the result. The constraint
 * test asserts that no wire execution state name appears in this file — if the
 * two vocabularies ever merge, status sniffing comes back and the board becomes
 * a second, unreliable execution authority.
 *
 * Three invariants the ports below encode:
 *
 * - **assignee and status are two fields**, not one enum. "Who holds it" and
 *   "where it is" change independently.
 * - **every mutation is a CAS.** `claim` compares against "unheld"; every status
 *   move carries `expectedStatus`. There is no last-write-wins path.
 * - **conflicts return the snapshot they lost to**, so the caller re-decides
 *   against real state instead of retrying blind.
 */
import type { TenantId } from './tenant';

/** The five board statuses. `closed` means "terminated, unaccepted" (§12.3). */
export const BOARD_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'closed'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/**
 * Legal transitions, transcribed from the §12.3 state diagram.
 *
 * `in_review → done` is the human acceptance step: a device reporting a
 * terminal record can push an item to `in_review`, never straight to `done`.
 * `done` and `closed` are sinks — if archival semantics are ever needed, §12.3
 * pins the answer to an `archivedAt` field, not a sixth status.
 */
export const BOARD_TRANSITIONS: Readonly<Record<BoardStatus, readonly BoardStatus[]>> = {
  todo: ['in_progress', 'closed'],
  in_progress: ['todo', 'in_review', 'closed'],
  in_review: ['in_progress', 'done', 'closed'],
  done: [],
  closed: [],
};

export function isLegalBoardTransition(from: BoardStatus, to: BoardStatus): boolean {
  return BOARD_TRANSITIONS[from].includes(to);
}

/** Who currently holds the item. Separate from {@link BoardItem.status}. */
export interface BoardAssignee {
  readonly holderId: string;
  readonly heldSince: string;
}

/**
 * One work item.
 *
 * `boardSeq` is monotonic **per tenant** and bumps on every mutation, which is
 * what makes incremental list polling possible without a cross-tenant sequence
 * (a global sequence would leak other tenants' write rate).
 */
export interface BoardItem {
  readonly tenantId: TenantId;
  readonly itemId: string;
  readonly channel: string;
  readonly title: string;
  readonly status: BoardStatus;
  readonly assignee?: BoardAssignee;
  readonly boardSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BoardItemInput {
  readonly itemId: string;
  readonly channel: string;
  readonly title: string;
  /** Defaults to `todo`. Creating directly into a sink status is legal but explicit. */
  readonly status?: BoardStatus;
}

export interface BoardListQuery {
  /** Exclusive lower bound on `boardSeq`, for incremental polling. */
  readonly afterSeq?: number;
  readonly channel?: string;
  readonly status?: BoardStatus;
  readonly limit?: number;
}

export interface BoardPage {
  readonly items: readonly BoardItem[];
  /** Highest `boardSeq` in this page, or the requested `afterSeq` when empty. */
  readonly nextSeq: number;
  readonly hasMore: boolean;
}

export interface BoardClaimInput {
  readonly itemId: string;
  readonly holderId: string;
  /**
   * Status the claimer believes the item is in. Defaults to `todo`; supplying
   * it explicitly makes the claim a full CAS rather than an assignee-only one.
   *
   * The CAS holds on the idempotent path too: a re-claim by the current holder
   * that supplies a stale `expectedStatus` fails with `board_status_conflict`
   * and the current item. The default is *not* applied there — a retry of a
   * successful claim legitimately observes `in_progress`.
   */
  readonly expectedStatus?: BoardStatus;
}

export interface BoardUnclaimInput {
  readonly itemId: string;
  /** Must match the current holder — releasing someone else's item is not a legal move. */
  readonly holderId: string;
}

export interface BoardStatusUpdateInput {
  readonly itemId: string;
  readonly expectedStatus: BoardStatus;
  readonly status: BoardStatus;
  /** Optional holder assertion, for transitions only the holder may make. */
  readonly holderId?: string;
}

/**
 * Board port. Tenant-first, async.
 *
 * Raises: `board_item_not_found`, `board_claim_conflict` (loser gets the
 * winner's holder snapshot), `board_status_conflict` (`expectedStatus` missed —
 * carries the current item), `board_transition_invalid` (move not in
 * {@link BOARD_TRANSITIONS} — also carries the current item), `board_not_held`.
 */
export interface BoardStore {
  create(tenant: TenantId, input: BoardItemInput): Promise<BoardItem>;
  get(tenant: TenantId, itemId: string): Promise<BoardItem | undefined>;
  list(tenant: TenantId, query: BoardListQuery): Promise<BoardPage>;
  /** CAS on "unheld". Exactly one concurrent caller wins; losers get the holder snapshot. */
  claim(tenant: TenantId, input: BoardClaimInput): Promise<BoardItem>;
  unclaim(tenant: TenantId, input: BoardUnclaimInput): Promise<BoardItem>;
  updateStatus(tenant: TenantId, input: BoardStatusUpdateInput): Promise<BoardItem>;
}
