/**
 * The Postgres composition's `InboundRateLimiter`: one in-process token bucket
 * per `(tenant, device)`. Every inbound envelope and every admitted device
 * route request spends one token from the same bucket.
 *
 * In-process on purpose: a per-request Postgres write would cost more than the
 * flood it refuses. Each replica therefore enforces its own budget, so a fleet
 * behind N replicas can reach N times the configured rate at most; a
 * deployment that needs one global budget still puts an edge limiter in front.
 *
 * Memory is bounded by `maxTrackedDevices`: buckets are kept in recency order
 * and the least recently used one is dropped when a new device arrives at the
 * cap. A dropped bucket comes back full, which only ever admits more, never
 * less, than keeping it would have.
 */
import type { InboundRateLimiter, RateLimitDecision, RateLimitUnit } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';

export interface PostgresRateLimitOptions {
  /** Sustained refill per device, tokens per second. A finite number > 0. */
  readonly tokensPerSecond: number;
  /** Tokens a device may spend back to back. A finite number >= 1. */
  readonly burst: number;
  /** Device buckets this process tracks at once. An integer >= 1; default {@link DEFAULT_MAX_TRACKED_DEVICES}. */
  readonly maxTrackedDevices?: number;
}

export const DEFAULT_MAX_TRACKED_DEVICES = 100_000;

interface Bucket {
  tokens: number;
  refilledAtMs: number;
}

export class TokenBucketRateLimiter implements InboundRateLimiter {
  readonly #tokensPerSecond: number;
  readonly #burst: number;
  readonly #maxTrackedDevices: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: PostgresRateLimitOptions, private readonly clock: Clock) {
    const maxTrackedDevices = options.maxTrackedDevices ?? DEFAULT_MAX_TRACKED_DEVICES;
    if (!Number.isFinite(options.tokensPerSecond) || options.tokensPerSecond <= 0) {
      throw new TypeError(`rateLimit.tokensPerSecond must be a finite number > 0, got ${options.tokensPerSecond}`);
    }
    // Below one token a bucket can never admit anything: that is a block, not a limit.
    if (!Number.isFinite(options.burst) || options.burst < 1) {
      throw new TypeError(`rateLimit.burst must be a finite number >= 1, got ${options.burst}`);
    }
    if (!Number.isSafeInteger(maxTrackedDevices) || maxTrackedDevices < 1) {
      throw new TypeError(`rateLimit.maxTrackedDevices must be an integer >= 1, got ${maxTrackedDevices}`);
    }
    this.#tokensPerSecond = options.tokensPerSecond;
    this.#burst = options.burst;
    this.#maxTrackedDevices = maxTrackedDevices;
  }

  async consume(tenant: TenantId, deviceId: string, _unit: RateLimitUnit): Promise<RateLimitDecision> {
    const key = `${tenant}\0${deviceId}`;
    const now = this.clock.now().getTime();
    const bucket = this.#touch(key, now);
    bucket.tokens = Math.min(
      this.#burst,
      bucket.tokens + (Math.max(0, now - bucket.refilledAtMs) / 1000) * this.#tokensPerSecond,
    );
    bucket.refilledAtMs = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / this.#tokensPerSecond) * 1000) };
  }

  /** The key's bucket, moved to the most-recent end; a new key may evict the least recent. */
  #touch(key: string, now: number): Bucket {
    const existing = this.#buckets.get(key);
    if (existing !== undefined) {
      this.#buckets.delete(key);
      this.#buckets.set(key, existing);
      return existing;
    }
    if (this.#buckets.size >= this.#maxTrackedDevices) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    const created = { tokens: this.#burst, refilledAtMs: now };
    this.#buckets.set(key, created);
    return created;
  }
}
