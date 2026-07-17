import { createInterface } from 'node:readline/promises';
import type { Daemon } from '../../index';

/** Thrown when `unpair` didn't get a `--yes`/confirmed and either declined interactively or has no TTY to prompt on. Caught by `byok-agent.ts`'s top-level handler like any other error (clean message, exit 1) — never left to hang. */
export class UnpairNotConfirmedError extends Error {
  constructor() {
    super('unpair cancelled: not confirmed (pass --yes to skip the prompt — required for a headless/background invocation, since there is no TTY to ask on)');
    this.name = 'UnpairNotConfirmedError';
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
 */
export async function runUnpairCommand(daemon: Pick<Daemon, 'unpair'>, deps: UnpairDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

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
    'unpaired: local device identity cleared (a separately running `byok-agent start` process, if any, is NOT stopped by this — it only affects the NEXT start)',
  );
}
