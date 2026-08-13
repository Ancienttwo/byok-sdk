/**
 * In-memory {@link PresenceStore} and {@link ActivityStore} reference (§12.3).
 *
 * Expiry is absence. A hint past its `expiresAt` is filtered out of every read
 * and lazily dropped, so no reader can ever observe a stale level and mistake
 * it for a live one. Both stores read time from the injected clock, which is
 * what lets the conformance suite assert expiry without sleeping.
 */
import { ByokCoreError } from '../errors';
import {
  DEFAULT_ACTIVITY_CAPACITY,
  type ActivityAppendInput,
  type ActivityEntry,
  type ActivityStore,
  type ActivityTail,
  type PresenceHint,
  type PresenceHintInput,
  type PresenceStore,
} from '../presence';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';

function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ByokCoreError(
      'hint_ttl_invalid',
      `Hint ttl must be a positive number of milliseconds, received ${String(ttlMs)}.`,
    );
  }
}

function assertMinimumInterval(minimumIntervalMs: number): void {
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
    throw new ByokCoreError(
      'hint_ttl_invalid',
      `Hint minimum interval must be a non-negative number of milliseconds, received ${String(minimumIntervalMs)}.`,
    );
  }
}

export class InMemoryPresenceStore implements PresenceStore {
  readonly #hints = new Map<string, PresenceHint>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint> {
    assertTtl(input.ttlMs);
    assertMinimumInterval(input.minimumIntervalMs);
    const now = this.#clock.now();
    const key = tenantKey(tenant, input.deviceId);
    const existing = this.#hints.get(key);
    if (
      existing !== undefined &&
      now.toISOString() < existing.expiresAt &&
      now.getTime() - Date.parse(existing.observedAt) < input.minimumIntervalMs
    ) {
      throw new ByokCoreError(
        'hint_rate_limited',
        `Presence for ${input.deviceId} was published more recently than the configured minimum interval.`,
      );
    }
    const hint: PresenceHint = {
      tenantId: tenant,
      deviceId: input.deviceId,
      level: input.level,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.configuredToolsets === undefined
        ? {}
        : { configuredToolsets: Object.freeze([...input.configuredToolsets]) }),
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    this.#hints.set(key, hint);
    return hint;
  }

  async read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined> {
    const key = tenantKey(tenant, deviceId);
    const hint = this.#hints.get(key);
    if (hint === undefined) return undefined;
    if (this.#isExpired(hint.expiresAt)) {
      this.#hints.delete(key);
      return undefined;
    }
    return hint;
  }

  async list(tenant: TenantId): Promise<readonly PresenceHint[]> {
    const prefix = tenantKey(tenant, '');
    const live: PresenceHint[] = [];
    for (const [key, hint] of [...this.#hints.entries()]) {
      if (!key.startsWith(prefix)) continue;
      if (this.#isExpired(hint.expiresAt)) {
        this.#hints.delete(key);
        continue;
      }
      live.push(hint);
    }
    live.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
    return live;
  }

  #isExpired(expiresAt: string): boolean {
    return this.#clock.now().toISOString() >= expiresAt;
  }
}

export class InMemoryActivityStore implements ActivityStore {
  readonly #tails = new Map<string, ActivityTail>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    assertTtl(input.ttlMs);
    const capacity = input.capacity ?? DEFAULT_ACTIVITY_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new ByokCoreError(
        'activity_capacity_invalid',
        `Activity capacity must be a positive integer, received ${String(capacity)}.`,
      );
    }
    if (input.details.length === 0 || !Number.isSafeInteger(input.dropped) || input.dropped < 0) {
      throw new ByokCoreError(
        'activity_batch_invalid',
        'Activity batches require at least one detail and a non-negative integer dropped count.',
      );
    }

    const now = this.#clock.now();
    const key = tenantKey(tenant, input.taskId);
    const existing = this.#tails.get(key);
    const live =
      existing !== undefined && now.toISOString() < existing.expiresAt ? existing : undefined;

    const appended: ActivityEntry[] = input.details.map((detail) => ({
      at: now.toISOString(),
      detail,
    }));
    const entries = [...(live?.entries ?? []), ...appended];
    let dropped = (live?.dropped ?? 0) + input.dropped;
    while (entries.length > capacity) {
      entries.shift();
      // Lossiness is data, not an omission: a reader can tell "nothing
      // happened" from "we lost the middle".
      dropped += 1;
    }

    const tail: ActivityTail = {
      tenantId: tenant,
      taskId: input.taskId,
      entries,
      dropped,
      capacity,
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    this.#tails.set(key, tail);
    return tail;
  }

  async read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined> {
    const key = tenantKey(tenant, taskId);
    const tail = this.#tails.get(key);
    if (tail === undefined) return undefined;
    if (this.#clock.now().toISOString() >= tail.expiresAt) {
      this.#tails.delete(key);
      return undefined;
    }
    return tail;
  }
}
