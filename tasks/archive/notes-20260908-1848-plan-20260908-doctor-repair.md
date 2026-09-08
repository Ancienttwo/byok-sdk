> **Archived**: 2026-09-08 18:48
> **Related Plan**: plans/archive/plan-20260908-doctor-repair.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260908-1848
> **Archive Projection V1**: `plans/plan-20260908-doctor-repair.md` => `plans/archive/plan-20260908-doctor-repair.md`
> **Archive Projection V1**: `tasks/contracts/20260908-doctor-repair.contract.md` => `tasks/archive/contract-20260908-1848-plan-20260908-doctor-repair.md`
> **Archive Projection V1**: `tasks/reviews/20260908-doctor-repair.review.md` => `tasks/archive/review-20260908-1848-plan-20260908-doctor-repair.md`
> **Archive Projection V1**: `tasks/notes/20260908-doctor-repair.notes.md` => `tasks/archive/notes-20260908-1848-plan-20260908-doctor-repair.md`

# Doctor repair implementation notes

## Outcome and boundary

Implemented in isolated worktree `/Users/kito/Projects/byok-sdk-wt-doctor-repair`, branch `codex/doctor-repair`, base `62e83ae` (fresh origin/main). Plan commit: `6cd908d`. Original root WIP was preserved; the preceding guide and its navigation edits were imported deliberately.

Implementation and whole-repo local test acceptance are complete after the approved test correction below; independent semantic acceptance is now recorded below. No push, merge, publication, live credential access, daemon operation, or deployment was performed. New public API requires a MINOR release boundary; package versions were not modified.

## P1 / P2 / P3

- P1: public device diagnostics and explicit operator repair sit in client; OS enrollment remains authority, DeviceStore metadata remains its non-secret projection. Task/cloud/Agent profile semantics are unchanged.
- P2: confirmation + expected tenant/device -> authenticated control check -> existing exclusive store lease -> safe metadata read -> OS authority read and target match -> shared reconcileMetadata -> readback -> lease release. No AuthManager construction/renewal or network call in repair.
- P3: startup and explicit repair share one projection reconciliation. Separate public diagnostics types prevent publishing private collector DI through the type dependency graph. Missing/valid-stale metadata can be rebuilt; invalid/legacy/special-file state and absent/mismatched authority refuse. Existing --fix remains health-only. Results describe metadata readback, not credential validity, power-loss durability or Agent readiness.

## Planning and workflow

Initial read-only Claude plan session reached 330s without stdout/stderr plan; no external plan approval is claimed. Main-agent file plan records the decision. A bounded read-only explorer independently confirmed the source path and limitations. Initial plan extraction exposed missing template gates; the plan fields were completed and the final required `check-task-workflow --strict` passed. No successful plan-to-todo extraction or independent semantic acceptance receipt is claimed.

## Historical implementation verification

Node: 22.22.3, resolved through npm's version-pinned node package; Bun: 1.4.2. No direct OS credentials in tests: existing Vitest in-memory credential seam was used.

- `bun run build`: PASS on final code.
- `bun run typecheck`: PASS on final code.
- `bun run check:api-surface`: PASS; deliberately updated client golden, with public data types separated from private collector seams.
- `bun run check:version-authority`: PASS.
- `repo-harness run check-task-workflow --strict`: PASS after plan metadata completion.
- `git diff --check`: PASS before closeout.
- Targeted initial run: 49 existing auth/store/diagnostics tests passed. New fixture initially called nonexistent credential `save`; corrected to existing `replace`. All 22 new tests then passed. A readback refusal test and JSON failure assertion were added; final client suite includes all 23 new tests without failure.
- `bun run test`: FAIL in client stage, 180 files passed / 4 failed / 2 skipped; 1853 tests passed / 7 failed / 11 skipped. Root sequential run stopped at the client failure; later package suites are not claimed passed. No whole-suite rerun was attempted.

## Historical failures — resolved by the approved continuations

1. `agent-egress-spool.test.ts`: natural compaction retaining 1 and 3 records, 2 timeouts at 10s.
2. `agent-message-outbox.test.ts`: natural compaction retaining 0 drafts, 1 timeout at 10s.
3. `durable-egress-faults.test.ts`: outbox compaction temp/target/directory sync failures, 3 timeouts at 10s.
4. `agent-home-projection.test.ts:237`: expected hookCwds length 2, observed 3.

These files and their feature implementations were not changed. Baseline reproduction was not run, so these are NOT declared pre-existing or unrelated by proven root cause. Under the user's scope boundary, stop and report rather than fix other features or repeatedly rerun expensive tests.

## Historical evidence and then-current boundary

Local full logs: `_ops/doctor-repair/build-final.log`, `typecheck-final.log`, `api-final.log`, `version-final.log`, `workflow-final.log`, `test-final.log`. Core source/API fingerprint and full-suite log hash below bind this evidence; document-only closeout does not change the tested source.

Next bounded slice: isolate the seven failing checks on pinned base and candidate to determine baseline versus regression before acceptance. Do not publish this candidate as fully verified. Native live credential-provider repair remains a separate integration qualification; no real device repair was performed.

- Source/API SHA-256: `28383f665b7b1fad41635455f8e10527abbb0fae97581f9163408da5b2504267`
- Full test log SHA-256: `f77a7a79af8573350e1d66ef6e226d5766097dddb25957e5a72fb656e067c7a2`

## Approved follow-up: failure classification completed

The user approved only pinned-base comparison and attribution. Base `62e83ae` and candidate `06991fb` were isolated; 14 relevant files/configs/lockfile hashes match. Raw targeted tests passed 7/7 on each. A temporary sync-delay overlay (21ms on real JSONL file sync, 60s observer budget) passed all six original assertions on each, taking 15.60–18.30s per case, beyond the original 10s timeout. The initial overlay's mock recursion made that attempt invalid; the corrected overlay was rerun once. A disposable copy of the projection test waited for the second 503 before stopping A and reproduced expected 2 / observed 3 on both subjects; earlier original completion/cursor assertions passed. All temporary copied test files were removed.

Classification: shared baseline I/O-budget weakness for six cases; baseline scheduling assumption for projection. No doctor-specific functional regression was observed in these seven comparisons. Original failing-run disk load was not instrumented, so this is not an exact load measurement of that historical run or a performance benchmark. Product code and original tests were not changed, and whole-suite acceptance is still NOT passed.

Durable report and exact commands/results/source hashes: `docs/researches/2026-09-08-doctor-failure-classification.md`, `docs/researches/evidence/doctor-failure-classification-20260908/results.json`. Next bounded slice is test-only budget/event-barrier correction; not executed under the classification approval.

## Approved test correction

P1: Only the four named test files changed; production code/API remain identical to `06991fb`. Natural compaction crosses the public 512-entry threshold and performs over 1,000 actual file/directory syncs. Projection completion and mailbox ACK are separate asynchronous boundaries.

P2: A first events page is delivered to daemon A -> host hook -> injected completion 503 -> cursor stays 0. A test fetch barrier installed before start parks the next events request, with an abort listener as its stop receipt. The test waits for both the rejected completion and parked poll, asserts exactly one hook, stops A and verifies poll abortion. Daemon B then receives the retained row, completes idempotently and advances the same cursor to 1; exactly two total hooks and zero runtime sessions/tasks remain required.

P3: Local 60s budgets cover only natural-compaction parameterized families, preserving the real threshold, append/reopen and quarantine checks. No global timeout, no sync mock removal, no relaxed count assertion, no product retry policy change. The barrier replaces a timing assumption with controlled delivery; at higher disk load the same bounded I/O budget can still expire honestly.

Validation before full-suite freeze: projection file 5/5 PASS; all 12 natural-compaction cases PASS under the existing 21ms slow-sync overlay (97.41s total), retaining the package 10s default and relying only on the new local budgets. Root typecheck PASS. Source hashes and sync profile are in `docs/researches/evidence/doctor-failure-classification-20260908/test-repair-*`. Local logs: `_ops/doctor-repair/barrier-test.log`, `repair-budget-test.log`, `test-repair-typecheck.log`. No production files changed since the previous passing build; that build evidence is reused rather than reproduced.

Frozen full-suite result: `bun run test` PASS (exit 0), 13 packages, 3905 passed / 135 skipped; client 1860 passed / 11 skipped. No new failures. Full log `_ops/doctor-repair/test-repair-full.log`, SHA-256 `36f562d235bd289099fd8ab782dbf1eff01f6fbecf48388c6d0de4d4c18e51b9`. Root typecheck, API surface and version authority PASS. This supersedes the earlier full-suite blocker; historical failure records remain above. Independent semantic acceptance and real OS-provider qualification are not claimed.

Workflow closeout keeps the active plan nonterminal for its pending independent acceptance boundary. An attempted terminal status triggered active-plan/terminal-plan-count validation; corrected only this plan status rather than archiving unrelated plans.

Final `repo-harness run check-task-workflow --strict` and `git diff --check`: PASS. No test rerun after document-only closeout.

## Independent semantic acceptance continuation

User approved the independent review. Read-only gatekeeper found no semantic contract violations, reran 23 doctor tests successfully, and validated existing source/log evidence. Original candidate 30743c8 failed cumulative diff whitespace only; main agent removed exactly the final blank line in diagnostics/types.ts as prescribed. No behavioral change or broad test rerun. Independent report and mechanical closure are in the review file; no formal harness AcceptanceReceipt or external operation is claimed. Plan status is Ready for Integration; automatic archive was not performed because it requires separate current verify-sprint/AcceptanceReceipt evidence.

## Final closeout — 2026-09-08

Implementation, tests, independent semantic acceptance and formal integration acceptance are complete. The final AcceptanceReceipt is external_pass with target_revision 62e83ae9ac76e38b5448307fec02850f780d7347. The older local-main receipt was superseded. verify-sprint finalized PASS; original required build/typecheck/full-test ledger passes are retained with current exact source/config-equality, single-field review-target-policy and 23 doctor/readback tests. This final state supersedes the historical blockers and next-step statements above.

The base merge policy returns required=false; this is a verified policy outcome, not an issued merge seal. Remaining external boundaries are merge/push, a future MINOR release/downstream uptake and real OS-provider qualification; none was performed. The approved closeout archives only this plan family and prepares merge facts while preserving original-root WIP.
