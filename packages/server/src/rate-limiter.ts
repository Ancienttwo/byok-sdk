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
 * and persists for the life of this `RateLimiter` instance — deliberately
 * NOT reset when a device disconnects/reconnects (see `ConnectionHub`'s own
 * use of this class): resetting on reconnect would let a device that just
 * got disconnected for exceeding its budget immediately burst again on
 * reconnect, defeating the limit entirely.
 */

export interface RateLimiterOptions {
  /** Sustained refill rate, tokens (i.e. messages) per second. Default 50. */
  messagesPerSecond?: number;
  /** Bucket capacity — how many messages may arrive back-to-back before the limit engages. Default 100. */
  burst?: number;
}

const DEFAULT_MESSAGES_PER_SECOND = 50;
const DEFAULT_BURST = 100;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly messagesPerSecond: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions = {}) {
    this.messagesPerSecond = opts.messagesPerSecond ?? DEFAULT_MESSAGES_PER_SECOND;
    this.burst = opts.burst ?? DEFAULT_BURST;
  }

  /**
   * Debit one token from `key`'s bucket, refilling first for however much
   * wall-clock time has elapsed since its last refill. Returns `false`
   * (and debits nothing) when the bucket is currently empty — the caller is
   * over budget right now.
   */
  consume(key: string): boolean {
    const now = Date.now();
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
}
