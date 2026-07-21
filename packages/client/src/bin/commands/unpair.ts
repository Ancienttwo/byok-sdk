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
 */
export class UnpairBlockedByRunningServiceError extends Error {
  constructor(detail: string) {
    super(
      `unpair refused: the background service is currently running (${detail || 'installed and running'}) — stop it first (byok-agent service-stop), then retry unpair`,
    );
    this.name = 'UnpairBlockedByRunningServiceError';
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
   * "confirmed not running"; see the module doc comment for what that
   * residual gap means and why it's still honestly reported regardless.
   */
  lifecycle?: Pick<ServiceLifecycle, 'status'>;
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
 *   successfully constructed) and it reports `running: true`, this throws
 *   {@link UnpairBlockedByRunningServiceError} BEFORE even prompting for
 *   confirmation, rather than proceeding and quietly losing the race.
 * - A `start` running directly in the foreground (no OS service involved)
 *   cannot be detected at all from a separate short-lived CLI invocation —
 *   this residual gap is called out explicitly in the success message below
 *   every time, not just in a doc comment nobody reads at the terminal.
 */
export async function runUnpairCommand(daemon: Pick<Daemon, 'unpair'>, deps: UnpairDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  if (deps.lifecycle) {
    const status = await deps.lifecycle.status();
    if (status.running) {
      throw new UnpairBlockedByRunningServiceError(status.detail);
    }
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
  log(
    'unpaired: local device identity cleared. NOTE: this cannot detect or stop a `byok-agent start` running directly in the foreground (no OS service involved) — if one is running against this same store, its next proactive token renewal will re-write device.json and silently undo this unpair; stop that process yourself first. (An installed background SERVICE is checked automatically; true cross-process live unpair needs the M4 control socket.)',
  );
}
