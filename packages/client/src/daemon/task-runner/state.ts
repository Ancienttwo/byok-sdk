/**
 * M4 Phase 3: default wait for `requestApproval` (see its own doc comment)
 * before force-resolving an unanswered out-of-band approval as a fail-closed
 * rejection — generous enough for a real human to actually notice and act on
 * an approval prompt, short enough that a genuinely abandoned task doesn't
 * tie up daemon/task bookkeeping forever. Overridable via
 * `TaskRunnerDeps.approvalTimeoutMs` (ultimately `DaemonConfig`-configurable —
 * see `create-daemon.ts`).
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Finding F5(a) (cross-model adversarial review): bound on how long
 * `shutdownTask` waits for a single task's OWN `session.interrupt()` before
 * giving up on it specifically and reporting `task.fail` anyway. Without an
 * INNER bound here, a hung `interrupt()` (a misbehaving runtime adapter
 * whose promise never settles) meant `task.fail` for THAT task was never
 * sent at all — not eventually, not ever — because the send was sequenced
 * strictly AFTER the `await`. The OUTER deadline
 * `create-daemon.ts`'s `performControlShutdown` races `shutdownActiveTasks`
 * against (`SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS`) does not help: racing at
 * that layer only unblocks the CALLER to proceed to `stop()`/closing the
 * connection — it does nothing to unstick THIS function's own
 * still-suspended `await`, which just keeps running (harmlessly, since
 * nothing awaits it anymore) in the background forever after, its
 * `deps.send` line never reached. Deliberately shorter than the outer
 * 10s deadline so one hung task's own interrupt can't itself consume the
 * whole outer budget and starve however many OTHER tasks
 * `shutdownActiveTasks` awaits concurrently via `Promise.all`. Overridable
 * via `TaskRunnerDeps.shutdownInterruptTimeoutMs` (ultimately
 * `DaemonOverrides.shutdown.taskInterruptTimeoutMs` — see `create-daemon.ts`).
 */
export const DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS = 5_000;

/** Bounded retry before terminal publication degrades observably. */
export const AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS = 3;

/**
 * M4 Phase 4 (fold-in from the P3 gate): bound on how many `requestApproval`
 * calls may sit QUEUED (not yet dispatched — see that method's own doc
 * comment) for the same task at once. Claude's parallel tool use can fire
 * more than one concurrent approval request for the same taskId; this is a
 * defensive ceiling on that fan-out, mirroring `approvals.ts`'s own
 * `MAX_PENDING_APPROVALS` (a whole-daemon cap) one level down (a per-task
 * cap) — not a realistic workload limit. A request arriving once a task's
 * queue is already at this size is rejected fail-closed immediately, the
 * same shape `requestApproval` already uses for an unknown/inactive taskId.
 */
export const MAX_PENDING_APPROVALS_PER_TASK = 16;

/**
 * M3-B: cap for both `finishedTaskIds` and `pendingCancelled` below (each
 * gains one entry per finished/cancelled task and was never pruned) — fine
 * for the short-lived CLI invocations M0-M2 ran as, but M3 turns the daemon
 * into a background service meant to stay up for weeks, so unbounded growth
 * here is a real, if slow, memory leak. Each collection evicts its OLDEST
 * (first-inserted) entry once over this cap — the bounded-ring idiom the old
 * reference server's per-device dedup window used, applied here to task ids
 * (server-side dedup is now the cloud kernel's dedup store). `Map`/`Set` iterate in insertion order (ECMA-262), so "oldest"
 * always means "finished/cancelled longest ago" — neither collection is
 * touched on a read, only on insert, so eviction order depends purely on
 * insertion time. See `finishedTaskIds` and `pendingCancelled`'s own doc
 * comments below for why a cap this size can't remove an entry either
 * invariant still needs.
 */
export const MAX_TRACKED_TASK_IDS = 2000;

/**
 * M5 batch-3 (workstream 2): stable, documented reason PREFIX a `task.fail`
 * carries when `payload.limits.maxDurationMs` (daemon-authoritative
 * wall-clock enforcement — see `armMaxDurationTimer`) is exceeded. Only the
 * prefix itself is the contract an embedder can match against
 * (`reason.startsWith(...)`); everything after it is human-readable detail,
 * not part of the stable shape.
 */
export const MAX_DURATION_EXCEEDED_REASON_PREFIX = 'resource limit exceeded: maxDurationMs';

/** M5 batch-3 (workstream 2): same contract as {@link MAX_DURATION_EXCEEDED_REASON_PREFIX}, for `DaemonConfig.maxTaskOutputBytes` — see `TaskRunner.pump`'s own per-event byte counting. */
export const MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX = 'resource limit exceeded: maxTaskOutputBytes';

/** Stable fail-closed reason for one normalized event that cannot fit the configured activity batch budget. */
export const ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX =
  'resource limit exceeded: activity ingress budget';

/**
 * Wire v3 result channel: the stable reason PREFIX of the `task.fail` a
 * `terminalProjection.mode: 'result-document'` task gets when its runtime
 * ended the turn without a staged `submit_result` outcome. Same
 * stable-prefix contract as {@link MAX_DURATION_EXCEEDED_REASON_PREFIX};
 * `retryable: false`, because the same offer on the same runtime has no
 * reason to submit on a second attempt. The SDK never derives the outcome
 * from the runtime's text.
 */
export const RESULT_NOT_SUBMITTED_REASON_PREFIX = 'result_not_submitted';

/**
 * Stable reason PREFIX of the `task.fail` a result-document task gets when
 * its staged outcome cannot be read back at `turn_end` (an unreadable or
 * mismatched record in the Agent home). `retryable: false`; the record is
 * preserved for repair.
 */
export const RESULT_UNREADABLE_REASON_PREFIX = 'result_unreadable';

/**
 * Bounded admission: the stable reason PREFIX a prepared Execution's
 * `task.fail` carries when any one of its provider calls reported prompt
 * tokens AT OR ABOVE the context window of the model its frozen request D was
 * compiled for (`RuntimePreparedLaunchV1.expected.model.contextWindow`).
 *
 * A purely numeric classification over the runtime's own usage observation:
 * no provider error text is read, no pattern is matched, and the upstream
 * runtime's heuristic overflow detector is deliberately not consulted. The
 * execution is torn down and fails closed (`retryable: false`) — the same D
 * re-sent against the same window would overflow again. Everything after the
 * prefix is human-readable detail.
 */
export const PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX = 'context_overflow';

/**
 * Bounded admission: the stable reason PREFIX a prepared Execution's
 * `task.fail` carries when it cannot produce the prepared observation — it
 * settled with no provider usage observed at all, or one of its provider calls
 * reported no positive, representable prompt token count. A prepared result
 * without that observation cannot be checked against the byte bound it was
 * admitted under, so it is never accepted as success (`retryable: false`).
 *
 * A reported prompt of zero is "unavailable", not "zero": D is never empty, and
 * the Pi runtime initialises a call's usage to zeros and leaves them there when
 * the provider streams no usage.
 */
export const PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX = 'usage_unavailable';

/**
 * The SDK-owned environment variable that carries one host toolset server's
 * `BYOK_HOST_TOOLSET_CONTEXT` nonce (contract §8.1).
 *
 * Injected by the daemon beside `BYOK_STORE_DIR`/`BYOK_PRODUCT_ID` — the two a
 * child already needs to dial this daemon's control socket. A host's own
 * `mcpToolsets` registry still cannot supply an `env` block at all
 * (`toolset-registry.ts`), so this name can only ever hold a value the daemon
 * minted.
 */
export const HOST_TOOLSET_CONTEXT_ENV = 'BYOK_HOST_TOOLSET_CONTEXT';
