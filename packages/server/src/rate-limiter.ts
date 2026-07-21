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
 *
 * Finding R5 (cross-model re-review — F10 residual): `burst` specifically
 * must be `>= 1`, not merely `> 0`. A `0 < burst < 1` value used to pass
 * the old `<= 0` check cleanly, but `consume()`'s own debit logic
 * (`if (bucket.tokens < 1) return false;`) can NEVER succeed once the
 * bucket's own CEILING (`burst`) is itself below 1 — `Math.min(this.burst,
 * ...)` caps refill there, so `tokens` can never reach 1 no matter how
 * long the bucket sits idle. The old validation let this construct
 * silently — a limiter that rejects every single message, forever, for
 * every key, is not a rate LIMIT, it's a permanent, total block; that
 * should be a construction-time error, not a runtime surprise discovered
 * once real traffic starts getting rejected.
 */

export interface RateLimiterOptions {
  /** Sustained refill rate, tokens (i.e. messages) per second. Must be a finite number > 0. Default 50. */
  messagesPerSecond?: number;
  /** Bucket capacity — how many messages may arrive back-to-back before the limit engages. Must be a finite number >= 1 (finding R5 — see the module doc comment for why `< 1` can never let a single message through, ever). Default 100. */
  burst?: number;
  /** Hard cap on how many distinct keys (finding R5) this limiter tracks at once — see {@link DEFAULT_MAX_TRACKED_DEVICES}'s own doc comment. Must be a finite number >= 1. Default 10,000. */
  maxTrackedDevices?: number;
}

const DEFAULT_MESSAGES_PER_SECOND = 50;
const DEFAULT_BURST = 100;
/**
 * Finding R5 (cross-model re-review — F10 residual): hard cap on
 * `RateLimiter.buckets`' size — see {@link RateLimiter.evictOldestIfAtCapacity}
 * for the eviction policy this backs. Without a HARD cap, the existing idle
 * sweep (`evictIdleBucketsIfDue`) only ever reclaims a bucket once it's
 * been quiet for `idleEvictionThresholdMs` — a flood of many THOUSANDS of
 * genuinely-distinct, ACTIVELY-used keys arriving faster than they ever go
 * idle (a legitimately huge fleet, or a same-shape Sybil-style attack
 * registering many fake device ids) would otherwise grow `buckets` without
 * bound regardless of the idle sweep, exactly the unbounded-growth shape
 * this codebase caps everywhere else (`MAX_PENDING_APPROVALS`,
 * `MAX_TRACKED_TASKS`, `MAX_LIVE_TASK_ANCHORS`, ...). 10,000 is generously
 * sized for any plausible real deployment while still being a genuine,
 * enforced ceiling — not a real-world limit this is expected to ever
 * approach in ordinary operation.
 */
const DEFAULT_MAX_TRACKED_DEVICES = 10_000;

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
  /** Finding R5: hard cap on `buckets.size` — see {@link DEFAULT_MAX_TRACKED_DEVICES}'s own doc comment. */
  private readonly maxTrackedDevices: number;
  /** Calls to `consume()` since the last sweep — see `EVICTION_SWEEP_EVERY_N_CALLS`. */
  private callsSinceSweep = 0;

  constructor(opts: RateLimiterOptions = {}) {
    const messagesPerSecond = opts.messagesPerSecond ?? DEFAULT_MESSAGES_PER_SECOND;
    const burst = opts.burst ?? DEFAULT_BURST;
    const maxTrackedDevices = opts.maxTrackedDevices ?? DEFAULT_MAX_TRACKED_DEVICES;
    if (!Number.isFinite(messagesPerSecond) || messagesPerSecond <= 0) {
      throw new TypeError(`RateLimiter: messagesPerSecond must be a finite number > 0, got ${messagesPerSecond}`);
    }
    // Finding R5: `< 1`, not `<= 0` — see the module doc comment for why a
    // burst between 0 and 1 (exclusive) constructs a limiter that can never
    // let a single message through, ever, for any key.
    if (!Number.isFinite(burst) || burst < 1) {
      throw new TypeError(`RateLimiter: burst must be a finite number >= 1, got ${burst}`);
    }
    if (!Number.isFinite(maxTrackedDevices) || maxTrackedDevices < 1) {
      throw new TypeError(`RateLimiter: maxTrackedDevices must be a finite number >= 1, got ${maxTrackedDevices}`);
    }
    this.messagesPerSecond = messagesPerSecond;
    this.burst = burst;
    this.maxTrackedDevices = maxTrackedDevices;
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
      // Finding R5: enforce the hard cap right before growing the map with
      // a genuinely NEW key — see `evictOldestIfAtCapacity`'s own doc
      // comment for the eviction policy and its equivalence/best-effort
      // split.
      this.evictOldestIfAtCapacity();
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

  /**
   * Finding R5 (cross-model re-review — F10 residual): called right before
   * inserting a bucket for a genuinely NEW key, evicting the single
   * LEAST-RECENTLY-refilled entry if `buckets` is already at
   * `maxTrackedDevices` — an O(n) scan, but one that only ever runs once
   * the map is already at its hard ceiling (a rare/bounded event under
   * ordinary operation, not a per-call cost), mirroring this codebase's own
   * established "acceptable O(n) for a rare/bounded case" precedent (e.g.
   * `audit-log.ts`'s `compactPreservingLiveTasks` during rotation).
   *
   * Equivalence split (stated explicitly, not left implied):
   * - For any evicted bucket that was ALREADY idle for at least
   *   `idleEvictionThresholdMs` (i.e. `evictIdleBucketsIfDue` would have
   *   reclaimed it anyway, just not yet — sweeps only run every
   *   `EVICTION_SWEEP_EVERY_N_CALLS` calls, not continuously), eviction is
   *   PROVABLY equivalent to an in-place refill: both cap at `burst`, so a
   *   caller can never observe the difference (see `idleEvictionThresholdMs`'s
   *   own doc comment for the identical reasoning `evictIdleBucketsIfDue`
   *   already relies on).
   * - For a bucket evicted EARLY — still within its idle threshold, forced
   *   out only because `buckets` is at capacity (many thousands of
   *   genuinely-distinct, actively-used keys, not a quiet one) — this is
   *   BEST-EFFORT, not equivalence-preserving: whatever partial token debt
   *   that key had is discarded, and its very next `consume()` call starts
   *   completely fresh (`tokens: this.burst`), a strictly MORE permissive
   *   outcome than if it had kept its place. This is an accepted,
   *   deliberately bounded trade-off — it only ever engages under
   *   cardinality far beyond any plausible real deployment — favoring
   *   bounded memory over perfect per-key continuity in that one extreme
   *   case.
   */
  private evictOldestIfAtCapacity(): void {
    if (this.buckets.size < this.maxTrackedDevices) return;
    let oldestKey: string | undefined;
    let oldestLastRefillMs = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefillMs < oldestLastRefillMs) {
        oldestLastRefillMs = bucket.lastRefillMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}
