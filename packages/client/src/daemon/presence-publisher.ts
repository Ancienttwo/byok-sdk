/**
 * Presence producer (§12.3): a periodic `{ level: 'online' }` heartbeat to
 * `PUT /byok/presence`, started only when the deployment's capability
 * declaration contains `presence.hints` (ADR-010 — see `capabilities-client.ts`).
 *
 * Three properties this module deliberately holds:
 *
 *  - **Only `online`.** The five levels exist in core, but nothing downstream
 *    consumes a `thinking`/`working`/`error` mapping yet, so none is invented
 *    here. That also keeps the rule below trivially true.
 *  - **It never reads or writes task state.** Presence is a lossy, unsigned,
 *    TTL-bounded hint that must never become coordination or execution state
 *    (`@byok-sdk/core`'s `presence.ts` module doc). This publisher's only input
 *    is a clock.
 *  - **Stopping IS the offline signal.** No explicit `offline` publish on
 *    shutdown: the hosted hint carries a TTL and expiry means *absence*, so a
 *    daemon that stops beating disappears on its own. Publishing `offline` too
 *    would express the same fact through a second channel that a crashed daemon
 *    could never use anyway.
 *
 * Auth reuses the daemon's one device-token lifecycle: {@link authedFetch}
 * attaches the current bearer and, on a 401, renews once through `AuthManager`
 * and retries exactly once. A revoked device (`DeviceRevokedError`) stops this
 * publisher permanently — there is no recourse but a fresh `pair()`, so
 * retrying would be a pure spin.
 */
import {
  BYOK_PRESENCE_PATH,
  type RuntimeInfo,
  type ToolsetId,
} from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import { DeviceRevokedError } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

/**
 * Client-side defaults, chosen against the hosted defaults
 * (`@byok-sdk/cloud`'s `DEFAULT_PRESENCE_TTL_MS` = 90s,
 * `DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS` = 5s) and core §12.7.5's suggested
 * 60-120s presence TTL. Spelled out here rather than imported: the daemon must
 * not depend on the hosted package, and these are this producer's own cadence
 * expectations, not a mirror of any deployment's configuration.
 *
 * The invariant that matters is `minimumIntervalMs < intervalMs < ttlMs`,
 * asserted in the constructor: beat faster than the store's throttle and every
 * other beat is rejected as `hint_rate_limited`; beat slower than the TTL and
 * the device flickers offline between beats.
 */
export const DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_PRESENCE_TTL_MS = 90_000;
export const DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS = 5_000;

/**
 * The cadence invariant, as a function so the two places that need it — this
 * module's constructor and `create-daemon.ts`'s synchronous config validation —
 * share one authority instead of two spellings of the same band.
 *
 * @throws {Error} when the cadence is outside `minimumIntervalMs < intervalMs < ttlMs`.
 */
export function assertPresenceHeartbeatCadence(cadence: {
  intervalMs: number;
  ttlMs: number;
  minimumIntervalMs: number;
}): void {
  const { intervalMs, ttlMs, minimumIntervalMs } = cadence;
  if (!(minimumIntervalMs < intervalMs && intervalMs < ttlMs)) {
    throw new Error(
      `presence heartbeat interval must satisfy minimumIntervalMs < intervalMs < ttlMs — got ${minimumIntervalMs} < ${intervalMs} < ${ttlMs}`,
    );
  }
}

export interface PresencePublisherOptions {
  serverUrl: string;
  auth: AuthManager;
  /** Sorted logical IDs only. Executable MCP definitions and credentials remain device-local. */
  configuredToolsets?: readonly ToolsetId[];
  /** U4a Local Agent release version; never inferred from the host package. */
  clientVersion?: string;
  /** The same runtime/auth snapshot sent in `conn.hello`. */
  runtimes?: readonly RuntimeInfo[];
  /** The same protocol-version snapshot sent in `conn.hello`. */
  protocolVersions?: readonly number[];
  /** Heartbeat cadence. Must sit strictly between {@link PresencePublisherOptions.minimumIntervalMs} and {@link PresencePublisherOptions.ttlMs}. */
  intervalMs?: number;
  /** The deployment's presence hint TTL, as this daemon understands it. Only used to validate the cadence. */
  ttlMs?: number;
  /** The deployment's minimum accepted interval between publications, as this daemon understands it. Only used to validate the cadence. */
  minimumIntervalMs?: number;
  /**
   * Observable degradation sink — one line per publish failure and one for the
   * permanent stop. The daemon passes its `console.warn` convention; tests read
   * it directly instead of scraping stdout.
   */
  onDegraded?: (reason: string) => void;
}

/**
 * Periodic `online` heartbeat. Construct once per `start()`, {@link stop} it in
 * the shutdown sequence.
 *
 * The loop is a self-rescheduling `setTimeout` rather than `setInterval`: a slow
 * publish must delay the next beat, not queue a second one behind it.
 */
export class PresencePublisher {
  private readonly url: URL;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** Set once a revoked device is observed. Terminal: `start()` will not restart this instance. */
  private stoppedPermanently = false;

  constructor(private readonly opts: PresencePublisherOptions) {
    const intervalMs = opts.intervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
    const ttlMs = opts.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    const minimumIntervalMs = opts.minimumIntervalMs ?? DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS;
    // Fail fast: a cadence outside this band is silently useless (rate-limited
    // on one side, flickering offline on the other), and neither shows up as an
    // error at the publish site.
    assertPresenceHeartbeatCadence({ intervalMs, ttlMs, minimumIntervalMs });
    this.intervalMs = intervalMs;
    this.url = new URL(BYOK_PRESENCE_PATH, toHttpBase(opts.serverUrl));
  }

  /** Publishes immediately, then every `intervalMs`. Idempotent; a no-op after a permanent stop. */
  start(): void {
    if (this.running || this.stoppedPermanently) return;
    this.running = true;
    void this.beat();
  }

  /** Stops the cadence. Idempotent, and the only "offline" signal this producer emits — the hint's TTL does the rest. */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.beat();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async beat(): Promise<void> {
    if (!this.running) return;
    try {
      const response = await authedFetch(
        this.url,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            level: 'online',
            ...(this.opts.configuredToolsets === undefined
              ? {}
              : { configuredToolsets: this.opts.configuredToolsets }),
            ...(this.opts.clientVersion === undefined ? {} : { clientVersion: this.opts.clientVersion }),
            ...(this.opts.protocolVersions === undefined
              ? {}
              : { protocolVersions: [...this.opts.protocolVersions] }),
            // Presence is a lightweight readiness fact, not a second
            // capability-negotiation channel. Keep its projection identical
            // to the persisted presence contract: the conn.hello snapshot's
            // runtime identity/version/auth facts, with no capabilities blob.
            ...(this.opts.runtimes === undefined
              ? {}
              : {
                  runtimes: this.opts.runtimes.map(({ id, version, authPresent }) => ({
                    id,
                    ...(version === undefined ? {} : { version }),
                    ...(authPresent === undefined ? {} : { authPresent }),
                  })),
                }),
          }),
        },
        this.opts.auth,
      );
      if (!response.ok) {
        // A 401 that survived `authedFetch`'s one renewal+retry is not a
        // transient failure this loop can outlast; every other status (a 429
        // from the store's own throttle, a 5xx) is, and is retried on the next
        // beat rather than escalated.
        if (response.status === 401) {
          this.stopPermanently(`presence heartbeat unauthorized after token renewal (HTTP 401)`);
          return;
        }
        this.opts.onDegraded?.(`presence heartbeat failed: HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof DeviceRevokedError) {
        this.stopPermanently('presence heartbeat stopped: device has been revoked; re-pair required');
        return;
      }
      this.opts.onDegraded?.(`presence heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.schedule();
  }

  private stopPermanently(reason: string): void {
    this.stoppedPermanently = true;
    this.stop();
    this.opts.onDegraded?.(reason);
  }
}
