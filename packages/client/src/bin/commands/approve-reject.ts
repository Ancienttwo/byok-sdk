import type { Daemon } from '../../index';

export interface ApproveRejectDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Honest caveat surfaced on every failure (not just printed once in --help):
 * none of the three bundled runtime adapters (pi/claude/codex) ever raises
 * `needs_approval` today (see `create-daemon.ts`'s `toRuntimeInfoCapabilities`
 * doc comment — each adapter's own `resolveApproval` throws unconditionally),
 * and this CLI has no cross-process link to an already-running
 * `byok-agent start` (no IPC yet — likely M4). `daemon.approve`/`reject` are
 * wired end-to-end and ready for both prerequisites, but effectively
 * unexercised until they exist.
 *
 * Finding P1 #1 (residual, STILL-OPEN, now fixed): a `Daemon` constructed by
 * a separate, short-lived CLI invocation (never `start()`ed) fails
 * `approve`/`reject` with "daemon is not started" on EVERY call — a
 * confusing, sounds-like-a-bug message for something that was never wired
 * to succeed in the first place. `byok-agent.ts` used to still DISPATCH
 * `approve`/`reject` to this module (just hidden from `usage()`'s advertised
 * list) — that dispatch has been removed entirely, so `byok-agent approve
 * <id>` now falls through to the ordinary unknown-command path, like any
 * typo, instead of running and failing with that message. This module's two
 * functions are unaffected and still directly tested (they behave exactly
 * as documented against whatever `Daemon`-shaped object they're given) —
 * they remain a ready-to-wire building block for the day cross-process IPC
 * (M4) makes calling them from this CLI meaningful; `byok-agent.ts` just no
 * longer routes to them.
 */
const UNEXERCISED_NOTE =
  'note: approve/reject are ready-but-unexercised — no bundled runtime adapter raises an approval yet, and byok-agent has no IPC link to an already-running `start` process (that is likely M4).';

export async function runApproveCommand(
  daemon: Pick<Daemon, 'approve'>,
  taskId: string,
  deps: ApproveRejectDeps = {},
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  try {
    await daemon.approve(taskId);
    log(`approved: taskId=${taskId}`);
  } catch (err) {
    error(UNEXERCISED_NOTE);
    throw err;
  }
}

export async function runRejectCommand(
  daemon: Pick<Daemon, 'reject'>,
  taskId: string,
  reason: string | undefined,
  deps: ApproveRejectDeps = {},
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  try {
    await daemon.reject(taskId, reason);
    log(`rejected: taskId=${taskId}${reason ? ` reason=${JSON.stringify(reason)}` : ''}`);
  } catch (err) {
    error(UNEXERCISED_NOTE);
    throw err;
  }
}
