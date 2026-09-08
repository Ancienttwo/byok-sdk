# SQLite device persistence investigation

Baseline: origin/main 0228973 (published 0.16.0 readback).

## Root Cause Evidence

- root_cause: createSqliteEmbeddedStores constructs createInMemoryCloudStores and replaces six coordination ports, leaving devices and enrollment captured by the in-memory composition. Reopening SQLite retains task attempts but reconstructs an empty device directory. This is the documented original scope, so the requested behavior is a capability extension rather than regression against that scope.
- repro: cd packages/server && bunx vitest run src/__tests__/sqlite-device-restart.test.ts
- regression_guard: packages/server/src/__tests__/sqlite-device-restart.test.ts exercises public pair, closes/reopens the same SQLite with stable token signer, expects original device and challenge/token renewal, then revoke and reopen rejection.
- pre_fix_failure_artifact: _ops/device-persistence-fail.log; one test fails at machines.list expected original device, actual []; baseline build succeeded.

AiphaBee full published-package SIGKILL evidence is in its codex/byok-016 worktree at docs/researches/2026-09-09-byok-016-local-install-test.md. It used actual SDK daemon enrollment and test runtime, no credential test override; task persisted, original enrollment reconnect failed.

No SDK production implementation has been edited. Public API/schema adoption decision remains under investigation; current v1 schema rejects unknown versions and has no explicit migration entrypoint. Do not change existing source until that boundary is resolved.

## Authorized implementation and validation

User explicitly approved SDK source changes in the isolated worktree after the
AiphaBee AGENTS prohibition was quoted. Implementation adds one durable SQLite
device directory and binds both pairing ports to it. Schema 2 rejects old builds;
v1 requires explicit `storage.migration: 'v1-to-v2'`, stopped writers and backup.
Public API golden includes only that new option and the composition doc update.

- build, typecheck, API surface, version authority and strict workflow passed.
  Before the final migration-column preflight, full test passed 3930 with 135
  skipped. After that bounded change, the final full rerun reports failures in
  unchanged client tests: session-workspace-store concurrent read/write exceeds
  10 seconds; runtime-detection-observation output-overflow classification also
  fails. Prior green evidence is not acceptance for the final revision. No client
  fixes or retries were attempted. Public pairing/restart passed separately.
- Six directory tests passed before the final preflight change; they cover persistent capability/harness declarations, tenant
  isolation, supersession/revoke, invalid replacement rollback, explicit migration,
  malformed/unknown storage, migration rollback after DDL and corrupt authority.
- Candidate is `bun pm pack` of packages/server, installed with npm into AiphaBee's
  isolated candidate harness. Manifest still says 0.16.0 because this is an
  unpublished source candidate; it must not be mistaken for registry 0.16.0.
- Published 0.16 creates actual schema v1; candidate refuses ordinary open,
  explicitly adopts v1, then published 0.16 refuses schema v2. Candidate reopen
  passes. Disposable migration state removed.
- Three public operators pass all 9 behavior groups on the candidate, using the
  real published client daemon/MCP and OS test enrollment. Cleanup confirmed.
- Original SIGKILL experiment now reconnects using the original enrollment and
  retains the original Complete task. It reaches replay, but cumulative execution
  is 3 rather than expected 2; original failure report remains unchanged. A second
  instrumented run reproduces 3 executions, with count 1 before explicit replay.
  There are two task IDs. Extra execution attribution is NOT proven: phase timing
  cannot identify a task. No SDK runtime/idempotency fix was attempted.

## Remaining boundary

Candidate device persistence behavior passed; final required full test and broader
crash/replay acceptance remain failed. Dispatch identity/handle recovery is the next separate slice. No publish,
push, merge, downstream pin change, staging or production deployment occurred.
The next release must be MINOR, per docs/spec.md. Required logs are under `_ops/`.

## Final artifact evidence

Final source also validates every required coordination-table column before v1
adoption; a dedicated missing-column negative test was added. Candidate rebuilt
and repacked after that change. Final migration smoke and all 9 operator groups
pass; final SIGKILL report again retains the original identity/task and records
3 executions after replay. The exact-2 assertion remains failed. Cleanup confirms
all random test enrollment and disposable state removed. No model was called.

Per the two-out-of-scope-fault stop rule, no runtime replay or client test fix is
included. Final reports live under AiphaBee's isolated worktree at
`Garbage/byok-016-local-test/candidate-final/`. Old reports remain in `candidate/`.

Final candidate tarball SHA-256: `31b4256445916341bf921379aa35a0467f1f33ce0a93fb0355dfdbaafd37412b`.

Final full test exited 1 in client before reaching later packages: 1869 passed,
2 failed, 11 skipped. Failures were expected probe-failed vs actual timeout,
and the 10-second concurrency timeout followed by ENOTEMPTY cleanup. The final
missing-column negative test has not run: the sequential full command stopped
before server. Do not claim all seven directory tests passed on final source.
The prior 3930-pass run remains preserved in `_ops/device-full-test.log`;
`_ops/device-full-test-final.log` is the failed final revision attempt.

## Follow-up: final test acceptance (explicitly approved)

P1/P2: client Vitest configuration uses CPU-count-derived workers while tests
spawn real probes/daemons and perform disk I/O. The runtime overflow fixture has
an explicit 1-second probe deadline; the store fixture performs 200 serialized
writes and concurrent independent reads under a 10-second test deadline. Previous
failure evidence contains deadline/cleanup failures, not a demonstrated torn read.

- Server targeted on c83345d: 5 files / 159 tests passed, including final migration
  column rejection, pairing/restart and SQLite conformance.
- The two previously failing client files, with file parallelism disabled:
  35 tests passed, no source changes.
- Unmodified full command rerun: 1869 passed / 2 failed / 11 skipped, but the two
  failures moved to journal-offer-family and agent-content-read-integration
  asynchronous observation assertions. Prior two failures did not recur.
- P3: cap client file-level maxWorkers at 4. No timeouts, test assertions, skips,
  intra-test concurrency, or product source change. Tradeoff is lower suite
  throughput; bound resource contention rather than expanding wall-clock budgets.
  Scheduling contention is a hypothesis, not a proven diagnosis of each failure.

Root Cause Evidence (test-execution mitigation):
- root_cause: likely resource contention from client file-level concurrency; exact
  cause of each timing-sensitive failure remains unproven.
- repro: bun run test, on c83345d, as recorded in device-full-test-final.log and
  device-full-test-acceptance.log; failures differ between runs.
- regression_guard: existing unchanged client assertions plus the complete suite.
- pre_fix_failure_artifact: _ops/device-full-test-acceptance.log; isolated success
  is separately recorded in _ops/device-client-isolated.log.

## Follow-up acceptance result

`bun run test` with client maxWorkers 4 exited 0: 3931 tests passed, 135 skipped.
Client 1871 passed/11 skipped; server 356 passed/19 skipped. All seven new
directory tests and the public restart regression are now covered on final source.
The installed Vitest default was availableParallelism minus one, 11 on this host;
only client file-level scheduling changes. Existing per-test races remain intact.
This is an observed stabilization, not proof that all intermittent failures are
eliminated. Product source is exactly c83345d; the final candidate package/runtime
evidence therefore remains applicable and was not regenerated unnecessarily.

Build, typecheck, API surface and version authority were rerun after the full
suite and passed; strict workflow is checked on these updated task artifacts.
Logs: `_ops/device-server-acceptance.log`, `_ops/device-client-isolated.log`,
`_ops/device-full-test-bounded.log`, and `_ops/device-{build,typecheck,api,version}-acceptance.log`.
The earlier failure logs remain available. No publish, merge or deployment.
