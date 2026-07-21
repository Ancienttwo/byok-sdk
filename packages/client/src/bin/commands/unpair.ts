import { createInterface } from 'node:readline/promises';
import type { Daemon, ServiceLifecycle } from '../../index';

/** Thrown when `unpair` didn't get a `--yes`/confirmed and either declined interactively or has no TTY to prompt on. Caught by `byok-agent.ts`'s top-level handler like any other error (clean message, exit 1) — never left to hang. */
export class UnpairNotConfirmedError extends Error {
  constructor() {
    super('unpair cancelled: not confirmed (pass --yes to skip the prompt — required for a headless/background invocation, since there is no TTY to ask on)');
    this.name = 'UnpairNotConfirmedError';
  }
}

/**
 * Finding P1 #2: thrown instead of clearing the store when the OS
 * background service (`byok-agent install`) is currently installed AND
 * running — see this file's own module doc comment for the full "why".
 * Unconditional: unlike {@link UnpairUnknownDaemonStateError}, `--force`
 * never bypasses this one — it exists for a KNOWN-unsafe state, not an
 * uncertain one.
 */
export class UnpairBlockedByRunningServiceError extends Error {
  constructor(detail: string) {
    super(
      `unpair refused: the background service is currently running (${detail || 'installed and running'}) — stop it first (byok-agent service-stop), then retry unpair`,
    );
    this.name = 'UnpairBlockedByRunningServiceError';
  }
}

/**
 * Finding P1 #2 (residual, now fixed across two rounds): thrown instead of
 * clearing the store when unpair could NOT positively confirm that no
 * background service/daemon is running. Three shapes all collapse to
 * "unknown", unsafe BY DEFAULT — exactly like a confirmed-running service —
 * unless the caller opts in via `--force`:
 *
 * - Round 1: a `deps.lifecycle` that could not even be constructed
 *   (unsupported platform, win32 without `--winsw-bin`, or no config to
 *   build one from at all).
 * - Round 1: a `status()` call that itself rejected (the query to the
 *   platform's service manager failed outright).
 * - Round 3: a `status()` call that RESOLVED but reported
 *   `determinate: false` — the manager query itself could not be answered
 *   (no reachable systemd `--user` D-Bus session, no launchd GUI domain for
 *   this uid, permission denied), so `running: false` in that response is a
 *   fallback, not a confirmed fact; see `lifecycle/service-types.ts`'s
 *   `ServiceStatusResult.determinate`. Every one of `systemd.ts`/
 *   `launchd.ts`/`winsw.ts` used to collapse exactly this case into a plain
 *   `running: false`, which this file's `checkServiceState` then trusted at
 *   face value — reopening the identical fail-open gap round 1 fixed for
 *   the other two shapes.
 *
 * Bypassable by `--force`, deliberately unlike
 * {@link UnpairBlockedByRunningServiceError}: this error means "can't
 * tell", not "confirmed unsafe".
 */
export class UnpairUnknownDaemonStateError extends Error {
  constructor(reason: string) {
    super(
      `unpair refused: could not confirm whether a background service is running (${reason}) — proceeding blind risks a running daemon silently re-writing the credential. Stop any \`byok-agent\` process/service yourself and retry, or pass --force to proceed anyway once you are sure none is running.`,
    );
    this.name = 'UnpairUnknownDaemonStateError';
  }
}

export interface UnpairDeps {
  log?: (line: string) => void;
  /** `--yes`: skip the confirmation prompt entirely. */
  confirmed?: boolean;
  /** Defaults to `process.stdin.isTTY` — overridable so a test never depends on the real test-runner's stdin. */
  isTTY?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * Finding P1 #2: an already-constructed lifecycle for the OS background
   * service this product MIGHT be installed as — `byok-agent.ts`'s `unpair`
   * dispatch builds this the same way `bin/commands/service.ts` does
   * (`buildServiceDefinition` + `createServiceLifecycle`) and passes it
   * through. `undefined` means "could not even check" (unsupported
   * platform, or Windows without `--winsw-bin`) — this is NOT the same as
   * "confirmed not running": see {@link UnpairUnknownDaemonStateError} and
   * the module doc comment for what that residual gap means and why it's
   * refused by default (bypassable only via `--force`).
   */
  lifecycle?: Pick<ServiceLifecycle, 'status'>;
  /**
   * Finding P1 #2 (residual): explicit opt-in to proceed when the service
   * check could NOT positively confirm "not running" (lifecycle
   * unavailable, or its `status()` call itself failed) — see
   * {@link UnpairUnknownDaemonStateError}. Does NOT bypass a lifecycle that
   * actively confirmed the service IS running
   * ({@link UnpairBlockedByRunningServiceError} is unconditional either
   * way) — `--force` overrides uncertainty, never a known-unsafe result.
   */
  force?: boolean;
}

/**
 * Finding P1 #2 (residual, now fixed across two rounds): the three outcomes
 * {@link runUnpairCommand} acts on. A `lifecycle` that's `undefined`, whose
 * `status()` call rejects, OR whose `status()` call resolves with
 * `determinate: false` (round 3 — see `lifecycle/service-types.ts`'s
 * `ServiceStatusResult.determinate`: the platform's own manager query
 * itself could not be answered) all collapse to `'unknown'` — deliberately
 * NOT reinterpreted as "confirmed not running" (that was the original
 * fail-open bug, and round 3's residual reopening of it via a `status()`
 * that resolves cleanly instead of rejecting). Only a `status()` call that
 * resolves with `determinate: true` is trusted at face value per
 * `ServiceStatusResult`'s own contract ("queried fresh from the platform's
 * own service manager... never a locally-cached guess" — see
 * `lifecycle/service-types.ts`).
 */
type ServiceCheckResult =
  | { outcome: 'confirmed-not-running' }
  | { outcome: 'confirmed-running'; detail: string }
  | { outcome: 'unknown'; reason: string };

async function checkServiceState(lifecycle: Pick<ServiceLifecycle, 'status'> | undefined): Promise<ServiceCheckResult> {
  if (!lifecycle) {
    return { outcome: 'unknown', reason: 'no background-service lifecycle could be constructed for this platform/config' };
  }
  try {
    const status = await lifecycle.status();
    if (status.running) {
      return { outcome: 'confirmed-running', detail: status.detail };
    }
    if (!status.determinate) {
      // Finding P1 #2 (residual, round 3): `status()` RESOLVED (didn't
      // throw) with `running: false`, but it was NOT a clean confirmation —
      // the manager query itself failed (unreachable/permission-denied).
      // Treat exactly like a thrown `status()` call: cannot confirm no
      // daemon is running.
      return {
        outcome: 'unknown',
        reason: `service status could not be confirmed — the service manager query was indeterminate rather than a clean "not running" result${status.detail ? `: ${status.detail}` : ''}`,
      };
    }
    return { outcome: 'confirmed-not-running' };
  } catch (err) {
    return { outcome: 'unknown', reason: `checking service status failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * `unpair()` itself only needs a `Daemon` this process just constructed
 * (never started) — clearing the on-disk device record and rebuilding
 * `AuthManager` in-memory doesn't require attaching to a live `start`
 * process (see `create-daemon.ts`'s `unpair()` doc comment: "safe to call at
 * any point in the lifecycle"). This is the one mutating query-adjacent
 * command that genuinely works standalone, unlike `approve`/`reject` — see
 * `commands/approve-reject.ts`.
 *
 * Confirmation: `--yes` skips the prompt outright. Without it, an
 * interactive TTY gets a y/N prompt; a non-TTY invocation (background/CI)
 * throws {@link UnpairNotConfirmedError} immediately rather than hanging on
 * stdin input that will never arrive — this CLI must work headless (see
 * `byok-agent.ts`'s header comment).
 *
 * ## Finding P1 #2: unpair used to silently fail (and self-revert) against a running daemon
 *
 * Clearing `device.json` on disk does nothing to a SEPARATE, already-running
 * `byok-agent start` process (foreground OR installed as a background OS
 * service) — that process loaded its own `AuthManager` at `start()` time and
 * keeps the device's JWT + private key cached in memory regardless of what
 * happens to the file afterward. Worse: `AuthManager`'s proactive renewal
 * timer (`auth-manager.ts`) fires on its own schedule and unconditionally
 * writes its in-memory record BACK to `device.json` on every successful
 * renewal — so a standalone `unpair` against a live daemon didn't just fail
 * to stop it, it got silently UNDONE by that daemon's own next renewal,
 * while the daemon stayed authorized and connected the whole time. There is
 * no IPC control socket yet (planned for M4) to reach a separate process and
 * actually tell it to stop, so this fix cannot make unpair truly live —
 * only honest:
 *
 * - If an installed OS service can be QUERIED (`deps.lifecycle` was
 *   successfully constructed AND its `status()` call resolves) and it
 *   reports `running: true`, this throws
 *   {@link UnpairBlockedByRunningServiceError} BEFORE even prompting for
 *   confirmation, rather than proceeding and quietly losing the race.
 *   Unconditional — `--force` does not bypass this; see below.
 * - Finding P1 #2 residual, round 1 (now fixed): every OTHER path used
 *   to FAIL OPEN — no `deps.lifecycle` at all (unsupported platform, win32
 *   without `--winsw-bin`, or no config to build one from), or a
 *   `status()` call that itself errored, both silently fell through to
 *   "proceed as if safe". That is now treated as "cannot confirm no daemon
 *   is running", which is unsafe BY DEFAULT: it throws
 *   {@link UnpairUnknownDaemonStateError} (before prompting, same position
 *   as the confirmed-running case above) unless the caller passes
 *   `--force`, which proceeds anyway and logs an explicit warning
 *   alongside the usual success message instead of the usual NOTE.
 * - Finding P1 #2 residual, round 3 (now fixed): a `status()` call that
 *   RESOLVED (didn't throw) with `running: false` was ALSO being trusted
 *   at face value even when the platform's own query had actually failed
 *   to reach the service manager at all — `systemd.ts`/`launchd.ts`/
 *   `winsw.ts` used to collapse a bus-connect/permission-denied/
 *   manager-unreachable query failure into a plain `running: false`,
 *   textually and structurally indistinguishable from a clean "confirmed
 *   not running" (the exact same re-open shape round 1 fixed for the
 *   other two paths). `ServiceStatusResult` is now tri-state
 *   (`determinate: boolean` — see `lifecycle/service-types.ts`), every
 *   platform's `status()` sets it accurately, and `checkServiceState`
 *   treats `determinate: false` exactly like a thrown `status()` call.
 *   Only a `status()` call that resolves `running: false` AND
 *   `determinate: true` is trusted at face value and proceeds without
 *   needing `--force` — this fix does not make every unpair require
 *   `--force`, only the genuinely-unconfirmable ones.
 * - A `start` running directly in the foreground (no OS service involved)
 *   cannot be detected at all from a separate short-lived CLI invocation,
 *   even when the OS-service check above comes back clean — this residual
 *   gap is called out explicitly in the success message below every time,
 *   not just in a doc comment nobody reads at the terminal. Fully-safe live
 *   unpair (able to confirm/stop ANY running daemon, foreground included)
 *   needs the M4 control socket.
 */
export async function runUnpairCommand(daemon: Pick<Daemon, 'unpair'>, deps: UnpairDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  const serviceState = await checkServiceState(deps.lifecycle);
  if (serviceState.outcome === 'confirmed-running') {
    throw new UnpairBlockedByRunningServiceError(serviceState.detail);
  }
  if (serviceState.outcome === 'unknown' && !deps.force) {
    throw new UnpairUnknownDaemonStateError(serviceState.reason);
  }

  if (!deps.confirmed) {
    if (!isTTY) {
      throw new UnpairNotConfirmedError();
    }
    const rl = createInterface({ input: deps.input ?? process.stdin, output: deps.output ?? process.stdout });
    let answer: string;
    try {
      answer = await rl.question(
        'This clears the locally paired device identity; the next `start` will require re-pairing. Continue? [y/N] ',
      );
    } finally {
      rl.close();
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new UnpairNotConfirmedError();
    }
  }

  await daemon.unpair();
  if (serviceState.outcome === 'unknown') {
    log(
      `unpaired: local device identity cleared. WARNING: --force was used to proceed WITHOUT confirming no background service/daemon is running (${serviceState.reason}) — if one IS running against this same store, its next proactive token renewal will re-write device.json and silently undo this unpair. Stop it yourself, then re-run unpair to verify. (True cross-process live unpair needs the M4 control socket.)`,
    );
  } else {
    log(
      'unpaired: local device identity cleared. NOTE: this cannot detect or stop a `byok-agent start` running directly in the foreground (no OS service involved) — if one is running against this same store, its next proactive token renewal will re-write device.json and silently undo this unpair; stop that process yourself first. (An installed background SERVICE is checked automatically; true cross-process live unpair needs the M4 control socket.)',
    );
  }
}
