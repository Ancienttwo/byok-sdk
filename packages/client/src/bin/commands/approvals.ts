import { ControlError, type ApprovalsListResult } from '../../daemon/control-protocol';
import { connectControlClient } from '../control-client';
import { formatApprovalsListLines } from '../format';

export interface ApprovalsListDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
  /** DI for tests: pin "now" for deterministic age rendering — see `formatApprovalsListLines`. */
  now?: () => number;
}

/**
 * Finding F4 (cross-model adversarial review): `byok-agent approvals` —
 * before this command existed, an operator had no way to ever learn a
 * pending approval's `approvalId` short of reading raw `audit.jsonl`
 * entries by hand (and even that only worked if the daemon happened to
 * surface one there at all): `approve`/`reject` both *require* an
 * `approvalId`, but nothing in this CLI ever printed one.
 *
 * Lists the control socket's `approvals.list` result — the exact same
 * `ApprovalRegistry` entries `approve`/`reject` resolve against
 * (`create-daemon.ts`'s method registry, backed by `daemon/approvals.ts`) —
 * as one line per pending approval: `approvalId`, `taskId`, `age`, and a
 * (possibly truncated — see `formatApprovalsListLines`) summary excerpt.
 *
 * No persisted-state fallback, mirroring `approve`/`reject`
 * (`commands/approve-reject.ts`): a pending approval only ever means
 * anything against a LIVE daemon, so daemon-unreachable is reported as a
 * clear, specific error (and this command exits non-zero) rather than a
 * silent "no approvals" — those are different outcomes and a script
 * parsing this output needs to be able to tell them apart.
 */
export async function runApprovalsCommand(storeDir: string, productId: string, deps: ApprovalsListDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const connectControl = deps.connectControl ?? connectControlClient;
  const now = deps.now ?? (() => Date.now());

  const conn = await connectControl({ storeDir, productId });
  if (!conn.ok) {
    const message = `cannot list approvals: daemon not reachable (${conn.reason}) — is \`byok-agent start\` (or the installed service) running?`;
    error(message);
    throw new Error(message);
  }

  try {
    const result = await conn.client.request<ApprovalsListResult>('approvals.list');
    for (const line of formatApprovalsListLines(result.approvals, now())) log(line);
  } catch (err) {
    if (err instanceof ControlError) {
      error(`approvals list failed: ${err.message}`);
    } else {
      error(`approvals list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    conn.client.close();
  }
}
