/**
 * The daemon's one lifecycle model (issues #391 and #394).
 *
 * `start()` resolves once local startup is done; whether the server has
 * accepted this device is a network fact, reported here and nowhere else. A
 * condition that a restart cannot fix ends the run as `halted` with a reason
 * from one closed set, whether it is found 100 ms or 10 days after start.
 */

/** Why a daemon run ended and must not be restarted automatically. Closed set. */
export const DAEMON_HALT_REASONS = [
  /** No device record: `pair` first. */
  'unpaired',
  /** The device record on disk is unusable and only a fresh `pair` replaces it. */
  're_pair_required',
  /** The OS enrollment of this productId was not paired by this storeDir (`device_store_not_bound`). */
  'store_not_bound',
  /** Another daemon owns this store. Thrown by `start()`; never reported through `lifecycle`. */
  'store_owned',
  /** The server revoked this device. */
  'device_revoked',
  /** The server answered this device's `conn.hello` with a rejection. */
  'handshake_rejected',
  /** The server no longer retains the history after this device's acknowledged cursor. */
  'replay_cursor_too_old',
  /** The configuration cannot work; a restart with the same configuration fails the same way. Thrown by `start()`; never reported through `lifecycle`. */
  'config_invalid',
] as const;

export type DaemonHaltReason = (typeof DAEMON_HALT_REASONS)[number];

export function isDaemonHaltReason(value: unknown): value is DaemonHaltReason {
  return typeof value === 'string' && (DAEMON_HALT_REASONS as readonly string[]).includes(value);
}

/**
 * - `stopped`: not started, or stopped normally.
 * - `awaiting-enrollment`: a service-enrollment daemon waiting for its first `enrollment.pair`.
 * - `running`: local startup is done; `connection` is `open` once the server
 *   accepted this run's `conn.hello` and `connecting` otherwise.
 * - `halted`: the run ended on a {@link DaemonHaltReason}. It stays halted
 *   (also after `stop()`) until the next `start()`.
 * - `crashed`: the run ended on an unexpected error after `start()` resolved
 *   (an observer callback or the reconnect loop threw). The connection
 *   stops and a `lifecycle` operational-health failure is recorded; unlike a
 *   halt, a restart may fix it, so `byok-agent start` exits 1 and the OS
 *   supervisor restarts it. It stays crashed (also after `stop()`) until the
 *   next `start()`.
 */
export type DaemonLifecycle =
  | { phase: 'stopped' }
  | { phase: 'awaiting-enrollment' }
  | { phase: 'running'; connection: 'connecting' | 'open' }
  | { phase: 'halted'; reason: DaemonHaltReason; at: string }
  | { phase: 'crashed'; at: string };

/**
 * `start()` throws this for a halt it finds locally. `store_owned` and
 * `config_invalid` are found before this process owns the store, so they
 * leave `lifecycle` unchanged: the run they describe never began, and the
 * store's owner (if any) is still the authority on its own lifecycle. Every
 * other reason is also reported as `lifecycle.halted`.
 */
export class DaemonHaltError extends Error {
  constructor(
    readonly reason: DaemonHaltReason,
    options?: { cause?: unknown },
  ) {
    super(`daemon halted: ${reason}`, options);
    this.name = 'DaemonHaltError';
  }
}

/**
 * Strict read of a persisted or transported {@link DaemonLifecycle} (an
 * `audit.jsonl` line, a control `status` answer). Anything outside the closed
 * shape is `undefined`: an unreadable value is reported as unknown, never
 * guessed.
 */
export function parseDaemonLifecycle(value: unknown): DaemonLifecycle | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  switch (raw.phase) {
    case 'stopped':
      return { phase: 'stopped' };
    case 'awaiting-enrollment':
      return { phase: 'awaiting-enrollment' };
    case 'running':
      return raw.connection === 'connecting' || raw.connection === 'open'
        ? { phase: 'running', connection: raw.connection }
        : undefined;
    case 'halted':
      return isDaemonHaltReason(raw.reason) && typeof raw.at === 'string'
        ? { phase: 'halted', reason: raw.reason, at: raw.at }
        : undefined;
    case 'crashed':
      return typeof raw.at === 'string' ? { phase: 'crashed', at: raw.at } : undefined;
    default:
      return undefined;
  }
}
