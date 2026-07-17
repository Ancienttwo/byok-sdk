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
