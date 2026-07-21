/**
 * M4 Phase 4 (part A): per-key token bucket, used by `ConnectionHub`
 * (`hub.ts`) to rate-limit inbound daemon->server envelopes per device.
 * Framework-agnostic on purpose (no hub/transport types here) so it stays
 * unit-testable in isolation, mirroring `event-queue.ts`'s own
 * transport-agnostic split.
 *
 * Token bucket, not a fixed window: `burst` tokens are available immediately
 * (accommodating a legitimate short spike — e.g. a reconnect's redelivery
 * catch-up), refilling continuously at `messagesPerSecond` tokens/sec up to
 * that same `burst` ceiling. A bucket is created lazily per key on first use
 * and persists for as long as it stays active — deliberately NOT reset when
 * a device disconnects/reconnects (see `ConnectionHub`'s own use of this
 * class): resetting on reconnect would let a device that just got
 * disconnected for exceeding its budget immediately burst again on
 * reconnect, defeating the limit entirely. It IS dropped once idle long
 * enough that keeping it around would be pointless — see
 * `evictIdleBucketsIfDue`.
 *
 * Construction validates `messagesPerSecond`/`burst` fail-fast (throws
 * `TypeError` on anything non-finite or <= 0) rather than silently building
 * a limiter that either divides into `NaN` token math or (an `Infinity`
 * burst/rate) never actually limits anything.
 */

export interface RateLimiterOptions {
  /** Sustained refill rate, tokens (i.e. messages) per second. Must be a finite number > 0. Default 50. */
  messagesPerSecond?: number;
  /** Bucket capacity — how many messages may arrive back-to-back before the limit engages. Must be a finite number > 0. Default 100. */
  burst?: number;
}

const DEFAULT_MESSAGES_PER_SECOND = 50;
const DEFAULT_BURST = 100;

/**
 * Sweep cadence for idle-bucket eviction (`evictIdleBucketsIfDue`), in
 * number of `consume()` calls across ALL keys — not a wall-clock timer, so
 * this class stays fully synchronous and framework-agnostic (per this
 * file's own top doc comment): no timer handle to create, `unref`, or clean
 * up on shutdown, and no lifecycle wiring needed in `ConnectionHub`.
 */
const EVICTION_SWEEP_EVERY_N_CALLS = 1000;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly messagesPerSecond: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, Bucket>();
  /**
   * Wall-clock idle duration (ms) after which a bucket is GUARANTEED to
   * already be refilled to `burst`, regardless of its actual token count at
   * last touch — i.e. the time to go from 0 tokens to `burst` at this
   * instance's configured rate. `evictIdleBucketsIfDue` uses this as the
   * eviction threshold: dropping an entry idle at least this long and
   * recreating it fresh (tokens = burst) on the next `consume()` is
   * therefore behaviorally IDENTICAL to refilling it in place would have
   * been — both cap at `burst` — so eviction is semantically invisible to
   * the caller.
   */
  private readonly idleEvictionThresholdMs: number;
  /** Calls to `consume()` since the last sweep — see `EVICTION_SWEEP_EVERY_N_CALLS`. */
  private callsSinceSweep = 0;

  constructor(opts: RateLimiterOptions = {}) {
    const messagesPerSecond = opts.messagesPerSecond ?? DEFAULT_MESSAGES_PER_SECOND;
    const burst = opts.burst ?? DEFAULT_BURST;
    if (!Number.isFinite(messagesPerSecond) || messagesPerSecond <= 0) {
      throw new TypeError(`RateLimiter: messagesPerSecond must be a finite number > 0, got ${messagesPerSecond}`);
    }
    if (!Number.isFinite(burst) || burst <= 0) {
      throw new TypeError(`RateLimiter: burst must be a finite number > 0, got ${burst}`);
    }
    this.messagesPerSecond = messagesPerSecond;
    this.burst = burst;
    this.idleEvictionThresholdMs = (burst / messagesPerSecond) * 1000;
  }

  /**
   * Debit one token from `key`'s bucket, refilling first for however much
   * wall-clock time has elapsed since its last refill. Returns `false`
   * (and debits nothing) when the bucket is currently empty — the caller is
   * over budget right now.
   */
  consume(key: string): boolean {
    const now = Date.now();
    this.evictIdleBucketsIfDue(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefillMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedMs = now - bucket.lastRefillMs;
      if (elapsedMs > 0) {
        bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsedMs / 1000) * this.messagesPerSecond);
        bucket.lastRefillMs = now;
      }
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Every `EVICTION_SWEEP_EVERY_N_CALLS` calls to `consume()`, drops every
   * bucket idle for at least `idleEvictionThresholdMs` (see that field's doc
   * comment for why this is safe). Without this, `buckets` would hold one
   * permanent entry per historical key forever — every device that ever
   * connected, even long after it disconnected for good — growing without
   * bound over a long-lived server's lifetime.
   */
  private evictIdleBucketsIfDue(now: number): void {
    this.callsSinceSweep++;
    if (this.callsSinceSweep < EVICTION_SWEEP_EVERY_N_CALLS) return;
    this.callsSinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillMs >= this.idleEvictionThresholdMs) {
        this.buckets.delete(key);
      }
    }
  }
}
