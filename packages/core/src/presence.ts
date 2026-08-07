/**
 * Presence and activity hints (§12.3).
 *
 * Both are lossy, TTL-bounded, unsigned, and never authoritative. Expiry means
 * *absence*, not a stale value: a hint past its TTL is invisible to readers, so
 * nothing downstream can mistake an old level for a live one.
 *
 * These hints must never be used to derive coordination state, execution state,
 * authorization, billing, or recovery — which is why this module shares no
 * vocabulary with `board.ts` and no vocabulary with the frozen wire states. The
 * constraint test enforces that separation by scanning this file for those
 * names. A device that looks busy is not evidence that any particular work item
 * moved anywhere.
 *
 * The activity tail is bounded by count and carries an explicit `dropped`
 * counter: lossiness is written into the data instead of being hidden behind a
 * stream that pretends to be complete.
 */
import type { TenantId } from './tenant';

/** The five presence levels. */
export const PRESENCE_LEVELS = ['online', 'thinking', 'working', 'error', 'offline'] as const;
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];

/** A device-level hint. `expiresAt` is authoritative: past it, the hint does not exist. */
export interface PresenceHint {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly level: PresenceLevel;
  /** Free-form host label, bounded by the composition. Never parsed by core. */
  readonly detail?: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface PresenceHintInput {
  readonly deviceId: string;
  readonly level: PresenceLevel;
  readonly detail?: string;
  /** Hint lifetime. §12.7.5 suggests 60-120s for presence. */
  readonly ttlMs: number;
}

/** One entry of a task's lossy tail. */
export interface ActivityEntry {
  readonly at: string;
  readonly detail: string;
}

/**
 * A task's bounded tail.
 *
 * `dropped` counts entries evicted by `capacity`, so a reader can tell the
 * difference between "nothing happened" and "we lost the middle".
 */
export interface ActivityTail {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly entries: readonly ActivityEntry[];
  readonly dropped: number;
  readonly capacity: number;
  readonly expiresAt: string;
}

export interface ActivityAppendInput {
  readonly taskId: string;
  readonly detail: string;
  /** Tail lifetime. §12.7.5 suggests 5-15 minutes for activity. */
  readonly ttlMs: number;
  /** Maximum retained entries. Must be a positive integer. */
  readonly capacity?: number;
}

/**
 * Presence port. Tenant-first, async.
 *
 * Reads filter expired hints out rather than returning them with a flag: an
 * expired hint is indistinguishable from one that was never written.
 */
export interface PresenceStore {
  publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
  read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
  list(tenant: TenantId): Promise<readonly PresenceHint[]>;
}

/**
 * Activity port. Tenant-first, async.
 *
 * Raises: `activity_capacity_invalid` (non-positive or non-integer capacity —
 * an unbounded tail is exactly what this contract exists to prevent).
 */
export interface ActivityStore {
  append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
  read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
}

/** Default tail capacity when an append does not specify one. */
export const DEFAULT_ACTIVITY_CAPACITY = 50;
