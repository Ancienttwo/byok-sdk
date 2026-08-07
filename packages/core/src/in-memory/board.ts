/**
 * In-memory {@link BoardStore} reference (§12.3).
 *
 * The claim path is the interesting one: because JavaScript resolves each
 * `await` boundary atomically here, N concurrent `claim` calls serialize and
 * exactly one finds `assignee === undefined`. A SQL composition gets the same
 * outcome from a conditional `UPDATE ... WHERE assignee IS NULL`; the
 * conformance suite asserts the outcome, not the mechanism.
 *
 * `boardSeq` is per tenant and bumps on every mutation, which is what makes
 * `list({ afterSeq })` an incremental feed that cannot leak another tenant's
 * write rate.
 */
import {
  isLegalBoardTransition,
  type BoardClaimInput,
  type BoardItem,
  type BoardItemInput,
  type BoardListQuery,
  type BoardPage,
  type BoardStatusUpdateInput,
  type BoardStore,
  type BoardUnclaimInput,
} from '../board';
import { ByokCoreError, CoreConflictError } from '../errors';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';

const DEFAULT_LIST_LIMIT = 50;

export class InMemoryBoardStore implements BoardStore {
  readonly #items = new Map<string, BoardItem>();
  readonly #seqByTenant = new Map<string, number>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async create(tenant: TenantId, input: BoardItemInput): Promise<BoardItem> {
    const key = tenantKey(tenant, input.itemId);
    if (this.#items.has(key)) {
      throw new ByokCoreError(
        'board_item_exists',
        `Board item ${input.itemId} already exists in this tenant.`,
      );
    }
    const now = this.#now();
    const item: BoardItem = {
      tenantId: tenant,
      itemId: input.itemId,
      channel: input.channel,
      title: input.title,
      status: input.status ?? 'todo',
      boardSeq: this.#nextSeq(tenant),
      createdAt: now,
      updatedAt: now,
    };
    this.#items.set(key, item);
    return item;
  }

  async get(tenant: TenantId, itemId: string): Promise<BoardItem | undefined> {
    return this.#items.get(tenantKey(tenant, itemId));
  }

  async list(tenant: TenantId, query: BoardListQuery): Promise<BoardPage> {
    const afterSeq = query.afterSeq ?? 0;
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const prefix = tenantKey(tenant, '');
    const matches: BoardItem[] = [];
    for (const [key, item] of this.#items.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (item.boardSeq <= afterSeq) continue;
      if (query.channel !== undefined && item.channel !== query.channel) continue;
      if (query.status !== undefined && item.status !== query.status) continue;
      matches.push(item);
    }
    matches.sort((left, right) => left.boardSeq - right.boardSeq);
    const page = matches.slice(0, limit);
    return {
      items: page,
      nextSeq: page.at(-1)?.boardSeq ?? afterSeq,
      hasMore: matches.length > page.length,
    };
  }

  async claim(tenant: TenantId, input: BoardClaimInput): Promise<BoardItem> {
    const item = this.#require(tenant, input.itemId);
    const expectedStatus = input.expectedStatus ?? 'todo';

    if (item.assignee !== undefined) {
      if (item.assignee.holderId === input.holderId) {
        // The same holder retrying is not a second winner.
        return item;
      }
      throw new CoreConflictError(
        'board_claim_conflict',
        `Board item ${input.itemId} is held by ${item.assignee.holderId}.`,
        item,
        this.#now(),
      );
    }
    if (item.status !== expectedStatus) {
      throw new CoreConflictError(
        'board_status_conflict',
        `Board item ${input.itemId} is ${item.status}, not ${expectedStatus}.`,
        item,
        this.#now(),
      );
    }
    if (item.status !== 'todo' && item.status !== 'in_progress') {
      throw new CoreConflictError(
        'board_transition_invalid',
        `Board item ${input.itemId} cannot be claimed from ${item.status}.`,
        item,
        this.#now(),
      );
    }

    const now = this.#now();
    const claimed: BoardItem = {
      ...item,
      status: item.status === 'todo' ? 'in_progress' : item.status,
      assignee: { holderId: input.holderId, heldSince: now },
      boardSeq: this.#nextSeq(tenant),
      updatedAt: now,
    };
    this.#items.set(tenantKey(tenant, input.itemId), claimed);
    return claimed;
  }

  async unclaim(tenant: TenantId, input: BoardUnclaimInput): Promise<BoardItem> {
    const item = this.#require(tenant, input.itemId);
    if (item.assignee === undefined) {
      throw new ByokCoreError(
        'board_not_held',
        `Board item ${input.itemId} is not held by anyone.`,
      );
    }
    if (item.assignee.holderId !== input.holderId) {
      throw new CoreConflictError(
        'board_claim_conflict',
        `Board item ${input.itemId} is held by ${item.assignee.holderId}, not ${input.holderId}.`,
        item,
        this.#now(),
      );
    }
    const now = this.#now();
    const released: BoardItem = {
      tenantId: item.tenantId,
      itemId: item.itemId,
      channel: item.channel,
      title: item.title,
      status: item.status === 'in_progress' ? 'todo' : item.status,
      boardSeq: this.#nextSeq(tenant),
      createdAt: item.createdAt,
      updatedAt: now,
    };
    this.#items.set(tenantKey(tenant, input.itemId), released);
    return released;
  }

  async updateStatus(tenant: TenantId, input: BoardStatusUpdateInput): Promise<BoardItem> {
    const item = this.#require(tenant, input.itemId);
    if (item.status !== input.expectedStatus) {
      throw new CoreConflictError(
        'board_status_conflict',
        `Board item ${input.itemId} is ${item.status}, not ${input.expectedStatus}.`,
        item,
        this.#now(),
      );
    }
    if (input.holderId !== undefined && item.assignee?.holderId !== input.holderId) {
      throw new CoreConflictError(
        'board_claim_conflict',
        `Board item ${input.itemId} is not held by ${input.holderId}.`,
        item,
        this.#now(),
      );
    }
    if (!isLegalBoardTransition(input.expectedStatus, input.status)) {
      throw new CoreConflictError(
        'board_transition_invalid',
        `${input.expectedStatus} to ${input.status} is not a legal board transition.`,
        item,
        this.#now(),
      );
    }
    const now = this.#now();
    const updated: BoardItem = {
      ...item,
      status: input.status,
      boardSeq: this.#nextSeq(tenant),
      updatedAt: now,
    };
    this.#items.set(tenantKey(tenant, input.itemId), updated);
    return updated;
  }

  #require(tenant: TenantId, itemId: string): BoardItem {
    const item = this.#items.get(tenantKey(tenant, itemId));
    if (item === undefined) {
      throw new ByokCoreError(
        'board_item_not_found',
        `Board item ${itemId} does not exist in this tenant.`,
      );
    }
    return item;
  }

  #nextSeq(tenant: TenantId): number {
    const next = (this.#seqByTenant.get(tenant) ?? 0) + 1;
    this.#seqByTenant.set(tenant, next);
    return next;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
