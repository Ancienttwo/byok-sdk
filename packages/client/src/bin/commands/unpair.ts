import { createInterface } from 'node:readline/promises';
import type { Daemon, ServiceLifecycle } from '../../index';
import { connectControlClient, isControlDaemonGone } from '../control-client';

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
  /**
   * M4 Phase 2: `storeDir`/`productId` to attempt a LIVE control-socket
   * unpair before ever falling back to the service-state-based flow below
   * — see this file's own module doc comment. Omitting either (e.g. an
   * older test exercising only the fallback path) skips straight to that
   * flow, exactly as before this feature existed.
   */
  storeDir?: string;
  productId?: string;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
  /** DI for tests: substitute the real "has the daemon actually exited" probe. */
  isControlDaemonGone?: typeof isControlDaemonGone;
  /** How long to wait for the daemon to actually exit after `shutdown` is sent, before giving up (the store is still cleared either way — see the live-path log message). Default 15000ms. */
  controlExitTimeoutMs?: number;
  /** Poll interval while waiting for exit. Default 300ms. */
  controlExitPollIntervalMs?: number;
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
 * ## M4 Phase 2: the control socket makes live unpair actually possible
 *
 * When `deps.storeDir`/`deps.productId` are supplied (the real
 * `byok-agent.ts` dispatch always supplies them), this first tries the
 * control socket (`control-client.ts`). If a `byok-agent start` — foreground
 * OR installed as a service, no distinction needed anymore — is genuinely
 * reachable right now, that's a definitively confirmed "yes, something is
 * running against this store", strictly better than the OS-service-state
 * GUESS the rest of this doc comment describes: after confirming, this
 * sends `shutdown {reason:'unpair'}`, waits for the daemon to actually exit
 * (polling `isControlDaemonGone` — both the control token file gone AND a
 * fresh connect refused), then clears the store exactly as below. Only when
 * the control socket is NOT reachable (daemon not running at all, or an
 * older daemon build predating this feature) does this fall through to the
 * heuristic, OS-service-state-based flow this whole doc comment otherwise
 * describes — untouched, including every refusal below.
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
 *   used to be undetectable at all from a separate short-lived CLI
 *   invocation, even when the OS-service check above came back clean. The
 *   M4 control-socket path above now closes exactly this gap — a reachable
 *   control socket is a definitive "yes, something is running" regardless
 *   of whether it's a foreground process or an installed service. This
 *   heuristic OS-service-state flow (and its residual "foreground daemon
 *   is invisible" gap) only still applies when the control socket itself
 *   isn't reachable at all.
 */

/**
 * Shared confirmation prompt for BOTH the live (control-socket) and
 * fallback (OS-service-state) unpair paths in {@link runUnpairCommand}
 * below: `--yes` (`deps.confirmed`) skips it outright; an interactive TTY
 * gets a y/N prompt; a non-TTY invocation (background/CI) throws
 * {@link UnpairNotConfirmedError} immediately rather than hanging on stdin
 * input that will never arrive.
 */
async function confirmUnpair(deps: Pick<UnpairDeps, 'confirmed' | 'isTTY' | 'input' | 'output'>, isTTY: boolean): Promise<void> {
  if (deps.confirmed) return;
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

/** Cancellable-by-nothing plain delay — this poll loop is itself bounded by `timeoutMs`, so no separate abort signal is needed. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForControlExit(
  storeDir: string,
  productId: string,
  checkGone: typeof isControlDaemonGone,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await checkGone(storeDir, productId)) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function runUnpairCommand(daemon: Pick<Daemon, 'unpair'>, deps: UnpairDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  if (deps.storeDir !== undefined && deps.productId !== undefined) {
    const connectControl = deps.connectControl ?? connectControlClient;
    const conn = await connectControl({ storeDir: deps.storeDir, productId: deps.productId });
    if (conn.ok) {
      try {
        // Declining (or a non-TTY throw) must not leak this connection —
        // the `finally` below closes it regardless of which way this
        // settles, including the confirmation-declined path, which used to
        // fall straight through to the thrown error without ever reaching
        // `conn.client.close()`.
        await confirmUnpair(deps, isTTY);
        // Best-effort: the daemon has already responded `ok` by the time
        // `request()` resolves (or the connection simply drops as it tears
        // itself down) — either way, the poll below is the real
        // confirmation, not this call's own success/failure.
        await conn.client.request('shutdown', { reason: 'unpair' }).catch(() => {});
      } finally {
        conn.client.close();
      }

      const checkGone = deps.isControlDaemonGone ?? isControlDaemonGone;
      const exited = await waitForControlExit(
        deps.storeDir,
        deps.productId,
        checkGone,
        deps.controlExitTimeoutMs ?? 15_000,
        deps.controlExitPollIntervalMs ?? 300,
      );

      await daemon.unpair();
      log(
        exited
          ? 'unpaired: the running daemon was told to shut down over the control socket, confirmed exited, and the local device identity has been cleared.'
          : 'unpaired: the running daemon was told to shut down over the control socket but did not confirm exit within the timeout; local device identity has still been cleared — verify no byok-agent process is still running against this store.',
      );
      return;
    }
  }

  const serviceState = await checkServiceState(deps.lifecycle);
  if (serviceState.outcome === 'confirmed-running') {
    throw new UnpairBlockedByRunningServiceError(serviceState.detail);
  }
  if (serviceState.outcome === 'unknown' && !deps.force) {
    throw new UnpairUnknownDaemonStateError(serviceState.reason);
  }

  await confirmUnpair(deps, isTTY);

  await daemon.unpair();
  if (serviceState.outcome === 'unknown') {
    log(
      `unpaired: local device identity cleared. WARNING: --force was used to proceed WITHOUT confirming no background service/daemon is running (${serviceState.reason}) — if one IS running against this same store, its next proactive token renewal will re-write device.json and silently undo this unpair. Stop it yourself, then re-run unpair to verify. (Live unpair over the control socket, above, is used automatically whenever it's reachable.)`,
    );
  } else {
    log(
      'unpaired: local device identity cleared. NOTE: this cannot detect or stop a `byok-agent start` running directly in the foreground with no reachable control socket (an older daemon build, or one that failed to bind it) — if one is running against this same store, its next proactive token renewal will re-write device.json and silently undo this unpair; stop that process yourself first. (An installed background SERVICE is checked automatically; a reachable control socket is used automatically and is the fully-safe path — see above.)',
    );
  }
}
