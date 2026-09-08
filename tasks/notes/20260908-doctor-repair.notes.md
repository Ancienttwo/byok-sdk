# Doctor repair implementation notes

## Outcome and boundary

Implemented in isolated worktree `/Users/kito/Projects/byok-sdk-wt-doctor-repair`, branch `codex/doctor-repair`, base `62e83ae` (fresh origin/main). Plan commit: `6cd908d`. Original root WIP was preserved; the preceding guide and its navigation edits were imported deliberately.

Implementation is complete; whole-repo test acceptance is NOT passed. No push, merge, publication, live credential access, daemon operation, or deployment was performed. New public API requires a MINOR release boundary; package versions were not modified.

## P1 / P2 / P3

- P1: public device diagnostics and explicit operator repair sit in client; OS enrollment remains authority, DeviceStore metadata remains its non-secret projection. Task/cloud/Agent profile semantics are unchanged.
- P2: confirmation + expected tenant/device -> authenticated control check -> existing exclusive store lease -> safe metadata read -> OS authority read and target match -> shared reconcileMetadata -> readback -> lease release. No AuthManager construction/renewal or network call in repair.
- P3: startup and explicit repair share one projection reconciliation. Separate public diagnostics types prevent publishing private collector DI through the type dependency graph. Missing/valid-stale metadata can be rebuilt; invalid/legacy/special-file state and absent/mismatched authority refuse. Existing --fix remains health-only. Results describe metadata readback, not credential validity, power-loss durability or Agent readiness.

## Planning and workflow

Initial read-only Claude plan session reached 330s without stdout/stderr plan; no external plan approval is claimed. Main-agent file plan records the decision. A bounded read-only explorer independently confirmed the source path and limitations. Initial plan extraction exposed missing template gates; the plan fields were completed and the final required `check-task-workflow --strict` passed. No successful plan-to-todo extraction or independent semantic acceptance receipt is claimed.

## Verification

Node: 22.22.3, resolved through npm's version-pinned node package; Bun: 1.4.2. No direct OS credentials in tests: existing Vitest in-memory credential seam was used.

- `bun run build`: PASS on final code.
- `bun run typecheck`: PASS on final code.
- `bun run check:api-surface`: PASS; deliberately updated client golden, with public data types separated from private collector seams.
- `bun run check:version-authority`: PASS.
- `repo-harness run check-task-workflow --strict`: PASS after plan metadata completion.
- `git diff --check`: PASS before closeout.
- Targeted initial run: 49 existing auth/store/diagnostics tests passed. New fixture initially called nonexistent credential `save`; corrected to existing `replace`. All 22 new tests then passed. A readback refusal test and JSON failure assertion were added; final client suite includes all 23 new tests without failure.
- `bun run test`: FAIL in client stage, 180 files passed / 4 failed / 2 skipped; 1853 tests passed / 7 failed / 11 skipped. Root sequential run stopped at the client failure; later package suites are not claimed passed. No whole-suite rerun was attempted.

## Failing checks outside this slice

1. `agent-egress-spool.test.ts`: natural compaction retaining 1 and 3 records, 2 timeouts at 10s.
2. `agent-message-outbox.test.ts`: natural compaction retaining 0 drafts, 1 timeout at 10s.
3. `durable-egress-faults.test.ts`: outbox compaction temp/target/directory sync failures, 3 timeouts at 10s.
4. `agent-home-projection.test.ts:237`: expected hookCwds length 2, observed 3.

These files and their feature implementations were not changed. Baseline reproduction was not run, so these are NOT declared pre-existing or unrelated by proven root cause. Under the user's scope boundary, stop and report rather than fix other features or repeatedly rerun expensive tests.

## Evidence and next boundary

Local full logs: `_ops/doctor-repair/build-final.log`, `typecheck-final.log`, `api-final.log`, `version-final.log`, `workflow-final.log`, `test-final.log`. Core source/API fingerprint and full-suite log hash below bind this evidence; document-only closeout does not change the tested source.

Next bounded slice: isolate the seven failing checks on pinned base and candidate to determine baseline versus regression before acceptance. Do not publish this candidate as fully verified. Native live credential-provider repair remains a separate integration qualification; no real device repair was performed.

- Source/API SHA-256: `28383f665b7b1fad41635455f8e10527abbb0fae97581f9163408da5b2504267`
- Full test log SHA-256: `f77a7a79af8573350e1d66ef6e226d5766097dddb25957e5a72fb656e067c7a2`
