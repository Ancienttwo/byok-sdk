import { ControlError } from '../../daemon/control-protocol';
import { connectControlClient } from '../control-client';

export interface ApproveRejectDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
}

/**
 * M4 Phase 2: `approve`/`reject` now genuinely work from a separate,
 * short-lived CLI invocation — they call the control socket's
 * `approvals.resolve` method (`create-daemon.ts`'s method registry, backed
 * by `daemon/approvals.ts`'s `ApprovalRegistry`) rather than requiring a
 * `Daemon` this same process just started (which never worked at all: see
 * git history for the pre-M4 version of this module, which called
 * `daemon.approve`/`daemon.reject` directly and always failed with
 * "daemon is not started" for exactly that reason — `byok-agent.ts` used to
 * not even dispatch to these commands as a result).
 *
 * Still honest about what these can resolve TODAY: no bundled runtime
 * adapter (pi/claude/codex) raises an approval yet (see `create-daemon.ts`'s
 * `toRuntimeInfoCapabilities` doc comment), so nothing ever calls
 * `ApprovalRegistry.register()` in this SDK version — every `approve`/
 * `reject` against a real daemon today resolves to the registry's own
 * `not_found` error, UNLESS the daemon isn't reachable at all, in which case
 * that's reported first. Both failure modes are reported with a clear,
 * specific message rather than a generic "not started" one.
 */
export async function runApproveCommand(
  storeDir: string,
  productId: string,
  approvalId: string,
  deps: ApproveRejectDeps = {},
): Promise<void> {
  return resolveApproval(storeDir, productId, approvalId, 'approve', undefined, deps);
}

export async function runRejectCommand(
  storeDir: string,
  productId: string,
  approvalId: string,
  reason: string | undefined,
  deps: ApproveRejectDeps = {},
): Promise<void> {
  return resolveApproval(storeDir, productId, approvalId, 'reject', reason, deps);
}

async function resolveApproval(
  storeDir: string,
  productId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
  reason: string | undefined,
  deps: ApproveRejectDeps,
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const connectControl = deps.connectControl ?? connectControlClient;
  const verb = decision === 'approve' ? 'approved' : 'rejected';

  const conn = await connectControl({ storeDir, productId });
  if (!conn.ok) {
    const message = `cannot ${decision} approvalId=${approvalId}: daemon not reachable (${conn.reason}) — is \`byok-agent start\` (or the installed service) running?`;
    error(message);
    throw new Error(message);
  }

  try {
    await conn.client.request('approvals.resolve', { approvalId, decision, reason });
    log(`${verb}: approvalId=${approvalId}${reason ? ` reason=${JSON.stringify(reason)}` : ''}`);
  } catch (err) {
    if (err instanceof ControlError && err.code === 'not_found') {
      // Finding F4: an unknown/already-resolved approvalId is exactly the
      // moment an operator needs pointing at the ONE command that lists
      // valid ones (`byok-agent approvals`) — before that command existed,
      // there was no way to learn a correct id short of raw audit-log JSON.
      // `err` itself (re-thrown below, unchanged) still carries the
      // original message alone; this hint is rendered-output-only.
      error(`${err.message} — run \`byok-agent approvals\` to see pending approvalIds`);
    } else {
      error(`${decision} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    conn.client.close();
  }
}
