#!/usr/bin/env node
import { connectControlClient, type ControlClient } from './control-client';
import { serveApprovalMcpOverStdio, type ApprovalMcpDeps } from './approval-mcp-server';

/**
 * `byok-approval-mcp`: the bin entry `claude`'s own `--permission-prompt-tool`
 * spawns as its child process under `PermissionPolicy.mode: 'confirm'` — see
 * `approval-mcp-server.ts`'s module doc comment for the full protocol/design
 * writeup and `../adapters/claude/permission-mapping.ts`'s `confirm`-mode
 * doc comment for the empirical basis. This file is intentionally thin (glue
 * only, never imported by a test — mirrors `byok-agent.ts`'s own split from
 * `bin/commands/*.ts`): read env, wire a real `ApprovalMcpDeps.requestApproval`
 * against the control socket, hand off to `serveApprovalMcpOverStdio`.
 *
 * Env vars (set by `../adapters/claude/claude-adapter.ts`'s `start()` via the
 * generated `--mcp-config`'s own `env` block — never read from the daemon's
 * ambient environment, since a DIFFERENT product/device's config must never
 * leak in):
 *   BYOK_STORE_DIR            — this daemon's control-socket storeDir.
 *   BYOK_PRODUCT_ID           — this daemon's productId.
 *   BYOK_TASK_ID              — the task this approval request belongs to.
 *   BYOK_APPROVAL_TIMEOUT_MS  — `TaskContext.approvalChannel.timeoutMs`,
 *                                echoed here so this process's OWN control
 *                                request waits at least that long (plus
 *                                slop) rather than timing out earlier than
 *                                the daemon's own authoritative deadline.
 */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Slop added on top of the daemon's own approval timeout for this process's OWN control-socket request timeout — the daemon's `TaskRunner.requestApproval` is the authoritative deadline (see its own doc comment); this must never fire first and race it. */
const REQUEST_TIMEOUT_SLOP_MS = 5_000;

/**
 * Reads a required env var, or exits fatally. Declared to RETURN `string`
 * (never `string | undefined`) so every caller gets a real, closure-safe
 * `string` type structurally — TypeScript's control-flow narrowing from an
 * `if (!x) process.exit(1)` guard does NOT survive being captured by a
 * nested function/closure (`getClient` below), so relying on that narrowing
 * directly on `process.env.X` would silently widen back to `string |
 * undefined` inside any closure that reads it. `process.exit` is typed
 * `never`, so this function's own control flow is sound without an explicit
 * `else`/`throw`.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`byok-approval-mcp: missing required env var ${name} — refusing to start\n`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const storeDir = requireEnv('BYOK_STORE_DIR');
  const productId = requireEnv('BYOK_PRODUCT_ID');
  const taskId = requireEnv('BYOK_TASK_ID');
  const timeoutMs = Number(process.env.BYOK_APPROVAL_TIMEOUT_MS ?? '600000');

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write('byok-approval-mcp: invalid BYOK_APPROVAL_TIMEOUT_MS env var — refusing to start\n');
    process.exit(1);
  }

  // Connect lazily (on first tools/call, not at startup) and cache the
  // in-flight connection attempt itself (not just the resolved client) so
  // concurrent tools/call requests (claude's parallel tool use can fire more
  // than one) share ONE connection attempt rather than racing several.
  let clientPromise: Promise<ControlClient> | undefined;
  function getClient(): Promise<ControlClient> {
    if (!clientPromise) {
      clientPromise = connectControlClient({ storeDir, productId, requestTimeoutMs: timeoutMs + REQUEST_TIMEOUT_SLOP_MS }).then(
        (conn) => {
          if (!conn.ok) {
            clientPromise = undefined; // let the NEXT call retry a fresh connection rather than caching a permanent failure
            throw new Error(conn.reason);
          }
          return conn.client;
        },
      );
      clientPromise.catch(() => {
        clientPromise = undefined;
      });
    }
    return clientPromise;
  }

  const deps: ApprovalMcpDeps = {
    requestApproval: async (tId, summary) => {
      let client: ControlClient;
      try {
        client = await getClient();
      } catch (err) {
        throw new Error(`could not connect to the daemon control socket: ${errorMessage(err)}`);
      }
      try {
        return await client.request('approvals.request', { taskId: tId, summary });
      } catch (err) {
        // The connection may be genuinely broken (daemon restarted, socket
        // reset, etc.) — drop the cache so a LATER tools/call in this same
        // claude session gets a fresh connection instead of repeating the
        // same dead one forever. This call itself still fails closed via
        // handleMcpRequest's own catch.
        clientPromise = undefined;
        throw err;
      }
    },
  };

  serveApprovalMcpOverStdio({ taskId, deps });
}

main().catch((err: unknown) => {
  process.stderr.write(`byok-approval-mcp: fatal error: ${errorMessage(err)}\n`);
  process.exit(1);
});
