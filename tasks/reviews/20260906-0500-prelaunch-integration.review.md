# Prelaunch SDK integration review

Status: source review PASS after targeted finding closure; packed runtime/PR gates pending, no publication acceptance.

Independent reviewer: native Claude, read-only Read/Grep/Glob invocation against `c678548b05bf8e2d705f745b303c993d852a0339`. Review output retained at `/tmp/astra-sdk-integration-claude-review.md`; prompt and frozen diff retained beside it. No waiver or self-review substitution.

Confirmed source invariants: atomic original terminal bytes/hash/recovery marker; admission before claim; startup replay without runtime rerun; hash-bound transport confirmation; immutable task/device/Agent identity; cancellation outcome without rewriting original receipt; orderly close and unknown executable cursor refusal.

Blocking finding: a terminal exceeding the journal record cap is currently only logged, leaving the cloud attempt running until restart. The canonical outcome must explicitly fail with a bounded typed reason and remain durable/replayable; arbitrary I/O failures must not trigger semantic substitution. Fix and targeted independent recheck required.

Verification gap: predecessor hash-only SQLite schema must have an explicit refusal/preservation oracle. Darwin SIGKILL coverage remains platform-specific; Linux source CI is not native crash acceptance.

Root source build/typecheck/API/version/full tests passed before this finding. Exact packed artifacts, final native downstream CI and PR delivery are still pending; no registry publication or deployment is claimed.

## Targeted independent follow-up

Reviewed merged `a791526` source at `c3a7dcd`. Original report follows. Root additionally wired the review's non-skippable SQLite flag: `BYOK_REQUIRE_SQLITE=1` in the native job and an explicit module-load failure if the backend is absent. Required-mode SQLite suite passed 36/36 at root. The terminal-size semantic note is explicitly recorded in the contract.

**Verdict: PASS.** No invariant failure in the exact changes. One concrete residual gap and one semantic note.

**Oversized terminal (`create-daemon.ts:1847-1888`)**
- Only `JournalRecordTooLargeError` enters the catch; everything else rethrows to the single log sink. The size check at `sqlite-journal.ts:691` fires before the transaction, so the oversized attempt leaves no row.
- The failure is built only from the durable offer: `readTask` asserts enrollment identity, and the offer type plus `task_id` binding is checked before `agentRef` is copied. No guessed ref, no truncation, no synthetic success.
- The replacement goes through the same `recordTerminal` first-winner path, the same `connection.send`, and the same receipt-to-confirm cycle. No confirmation bypass.
- No recursion: a second too-large or storage error propagates to the log and the task stays visibly unsettled.
- `journalTerminalTail` is now the full chain including the catch, and it is awaited at `:2238` and `:2555`, so teardown waits for the settlement write.

**Test (`execution-recovery-kill.test.ts:354-380`)**
Uses `enqueueAgentOffer` (fixture `execution-recovery-cloud.ts:314-319`, real `task.offer_for_agent`). Asserts `task.fail` reason, `retryable: false`, exact `agentRef`, `task_id`, cloud body byte-equal to local `bytes`, `confirmed`, one runtime start before and after SIGKILL restart, and unchanged bytes/hash after restart. Attempt reaching `failed` rules out the oversized complete ever landing at the cloud.

**Hash-only oracle (`journal-sqlite.test.ts:299-322`)**
Snapshot is taken after the ALTER connection closes and before the first `build()`. Refusal at `sqlite-journal.ts:414-418` runs after `exec(SCHEMA)`, which is `IF NOT EXISTS` only, and after pragmas that are no-ops on an existing WAL database. Normalizing offsets 24-27 and 92-95 leaves the schema cookie (40-43), page count, and all page content in the comparison, so a schema or row change would still fail. Row-level equality and no-quarantine are asserted separately. The invariant is preserved without claiming raw physical equality.

**Native CI job (`ci.yml:114-145`)**
Node pinned by `.node-version` (22.22.3), Bun 1.4.0 matches `packageManager`, `uname` gate is enforced in the shell, `pipefail` plus `tee` keeps failures fatal, artifact upload errors on missing files.

**Remaining concrete defect (non-blocking)**
- `journal-sqlite.test.ts:105` still has `describe.skipIf(!isSqliteAvailable())`. If `node:sqlite` fails to load under vitest on the runner, the 36 SQLite tests skip and the job stays green. The shell only gates Darwin, not SQLite availability. Add a skip-count assertion on the log or an env flag that turns unavailability into a hard failure.

**Semantic note (accept or not, no code change required)**
- The catch converts any oversized terminal kind, including an oversized `task.fail` or `task.cancelled`, into `terminal_result_too_large` with `retryable: false`. The original reason and retryability are lost. Bounded and deliberate, but worth recording in the contract.

Final pack and downstream CI remain orchestrator gates.
