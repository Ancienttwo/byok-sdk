import { APPROVAL_REQUIRES_HOST } from '../../daemon/approvals';
import { ControlError } from '../../daemon/control-protocol';
import { connectControlClient } from '../../daemon/control-client';

export interface ApproveRejectDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
}

/**
 * `approve`/`reject` from a separate, short-lived CLI invocation: they call
 * the running daemon's control-socket `approvals.resolve` method, backed by
 * `daemon/approvals.ts`'s `ApprovalRegistry`. Pending approvals come from the
 * `auto` tool gate (`tool-authorization`) and from runtimes or custom
 * adapters that ask whether a task may continue (`task-terminal`);
 * `byok-agent approvals` lists them, and `approvals.list` returns each kind.
 *
 * The control socket is a same-user channel, so it can reject anything and
 * approve a `task-terminal` approval, but approving a `tool-authorization`
 * approval fails with `approval_requires_host` unless the Host set
 * `DaemonConfig.localToolApproval: 'allow'` (see `docs/security.md`). An
 * unknown id fails `not_found`, and an unreachable daemon is reported first.
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
    } else if (err instanceof ControlError && err.code === APPROVAL_REQUIRES_HOST) {
      error(`${err.message} — approve it in the Host, or run \`byok-agent reject ${approvalId}\``);
    } else {
      error(`${decision} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    conn.client.close();
  }
}
