/**
 * The client's default task-startup deadline, which bounds the Windows Pi
 * projection ACL native suite's cold case. Test instrumentation, not product
 * policy.
 *
 * Keep it in sync with the client default
 * (startupTimeoutMs ?? 30_000 in packages/client/src/daemon/task-runner/offer.ts).
 */
export const PI_ACL_CLIENT_STARTUP_DEADLINE_MS = 30_000;
