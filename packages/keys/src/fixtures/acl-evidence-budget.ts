/**
 * Budget arithmetic for the Windows Pi projection ACL evidence test.
 *
 * These values are test instrumentation, not product policy:
 * - the cold watchdog fires inside the client's default 30s task-startup
 *   deadline, so a hung first ACL query still reports its phases;
 * - the warm watchdog and the negative cases stay inside Vitest's default 5s
 *   test timeout;
 * - teardown stays inside Vitest's default 10s hook timeout.
 *
 * The cold case still pays the account's first Windows PowerShell use. CI runs
 * no prepay, so the cold watchdog must not be raised above the product deadline
 * without a decision: nightly run 41143045892 is the open evidence that a fresh
 * hosted Windows account can spend the whole 30s before the interpreter answers.
 *
 * Keep the startup deadline in sync with the client default
 * (startupTimeoutMs ?? 30_000 in packages/client/src/daemon/task-runner.ts).
 */
export const PI_ACL_CLIENT_STARTUP_DEADLINE_MS = 30_000;
/** Leave room for the watchdog to fail and log before the test timeout fires. */
export const PI_ACL_EVIDENCE_MARGIN_MS = 200;
export const PI_ACL_COLD_EVIDENCE_BUDGET_MS = PI_ACL_CLIENT_STARTUP_DEADLINE_MS - PI_ACL_EVIDENCE_MARGIN_MS;
export const PI_ACL_WARM_EVIDENCE_BUDGET_MS = 4_800;
export const PI_ACL_ICACLS_DEADLINE_MS = 2_000;
/** Inside Vitest's unchanged 10s default hook budget. */
export const PI_ACL_TEARDOWN_EVIDENCE_BUDGET_MS = 9_800;

/** What remains of a whole-case budget after setup phases, never negative. */
export function remainingAclEvidenceMs(evidenceBudgetMs: number, elapsedMs: number): number {
  return Math.max(evidenceBudgetMs - elapsedMs, 0);
}
