/**
 * In-memory {@link PresenceStore} reference (§12.3).
 *
 * Expiry is absence. A hint past its `expiresAt` is filtered out of every read
 * and lazily dropped, so no reader can ever observe a stale level and mistake
 * it for a live one. Both stores read time from the injected clock, which is
 * what lets the conformance suite assert expiry without sleeping.
 */
import { ByokCoreError } from '../errors';
import {
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
