# Cloud 4c implementation evidence

Owner approved the design at f09c05cb. Work runs in cloud-4c-tools-jobs.

## Baseline

- Clean worktree at f09c05cb.
- bun ci: exit 0. 445 packages installed with the locked dependency graph.
- Pinned pi-durable, pi-ai and chord: 1.0.0.
- The runtime is private. The published package inventory does not change.

## Verification and review

Execution evidence will be added after each completed slice.

- Policy, configuration, input guard and real workerd ledger tests: 4 files, 85 passed, exit 0.
- Transport plus original 4b checks: 6 files, 388 passed, exit 0 before integration.
- Original credentials and storage tests after session integration: 2 files, 124 passed, exit 0.
- Native session integration and transport tests: 2 files, 109 passed, exit 0 before the final missing-context negative case.
- Package typecheck: exit 0.

## Storage decision

Session and stale data use a visible host SQL table in the existing DO database.
An actual workerd probe showed that DO KV creates _cf_KV, whose SQL rows are not readable.
The existing whole-table audit failed with SQLITE_AUTH. No audit assertion was changed.
The SQL host table restores complete audit coverage.

## Final review handoff

The owner requires Claude read-only review before any commit, per rule 488.
All changes remain uncommitted. HEAD is f09c05cb.

- cloud-do typecheck: exit 0.
- cloud-do test: exit 0. Vitest: 12 files, 585 passed, 0 failed.
- The separate Node proof passed: 1 test, 0 failed, 0 skipped. The real workerd replay lasted over 31 seconds.
- Total cloud-do tests: 586 passed. No assertions were loosened. No test was skipped. Existing timeouts were not increased.
- Full diff self-review covered credential storage, decoded arguments, native replay ownership, immutable results, budgets and cancellation.
- Published package APIs and versions are unchanged.

## Design details

No runtime scope deviation. There is no job executor, alarm handler or remote MCP implementation.
The private test command includes a Node wall-time proof. This keeps the existing Vitest timeout policy.
Tool argument assembly has a 65,536-byte cap. Decoded JSON checks have depth 32 and 10,000-node caps.
Tool schema and description strings are checked before native pi schema intake.
These limits and checks supplement the note's input boundary.

## Changed files

Under packages/cloud-do:

- package.json
- src/agent-do.ts
- src/errors.ts
- src/identity.ts
- src/index.ts
- src/platform-provider.ts
- src/provider-fetch.ts
- src/input-guard.ts
- src/invocation-ledger.ts
- src/session-config.ts
- src/session-runtime.ts
- src/tools.ts
- test/fixtures/financial-analysis.md
- test/input-guard.test.ts
- test/invocation-ledger-worker.ts
- test/invocation-ledger.test.ts
- test/recovery-walltime.node.mjs
- test/session-config.test.ts
- test/session-runtime-worker.ts
- test/session-runtime.test.ts
- test/tools-policy.test.ts
- test/transport-tools.test.ts

Workflow artifacts:

- tasks/notes/cloud-4c-inline-tools.md

READY FOR REVIEW

## Claude review repairs

Owner requested verification of all six findings in the Claude pre-commit review (local, not committed).
Findings 1 and 4 had real defects. Real native tests failed before source fixes.
Findings 2, 5 and 6 were already covered by the implementation and exact assertions.
Finding 3 confused native terminal cleanup with resumed model work. A real partial restart control proves isolation.

- Repair report: kept locally, not committed.
- Final cloud-do typecheck: exit 0.
- Final cloud-do tests: 599 Vitest + 1 Node proof = 600 passed; no failed or skipped tests.
- No old assertion was weakened. No timeout was increased.
- All changes remain uncommitted. The owner-deleted plan stays absent.

READY FOR RECHECK

## Review outcome

- Claude re-check: findings 1 and 4 resolved; rebuttals for 2, 3, 5 and 6 accepted. VERDICT: APPROVE.
- Full root gate passed before commit.
