# Runtime probe observation implementation notes

Base: `0f8fdb4a43774b9d21ccfec0ba7d49fa06fec009`; isolated worktree `byok-sdk-wt-runtime-probe`, branch `codex/runtime-probe-observation`. Main checkout research and package-context modifications are preserved.

Planning: existing `claude-consult` proposed a discriminated result and local projections. Main agent retained optional version, excluded free-form error codes, and chose a timer-owned timeout classification instead of killed/signal inference. This is a new observation feature, not a claim that current tests already fail.

## Implementation

The mandatory detect authoring shape is `RuntimeDetectResult.kind`: available, not-found, not-executable, timeout, probe-failed. Version/auth metadata is available-only. Three adapters share OS-code classification and an owned version-child deadline. Deadline kills the child with SIGKILL and closes its streams; an arbitrary killed/signal error is not timeout evidence. Local runtimes/status/doctor retain outcome; presence is derived. Daemon registration and task admission validate the new result, keep only available runtimes, and preserve existing wire/retry/policy behavior. Old/mixed custom-adapter shapes fail closed. Custom detect deadline observes silence but cannot cancel arbitrary adapter work.

Spec, Unreleased changelog, API golden, direct consumers and fixtures were updated. No version bump or external source copy. Production implementation is uncommitted on the isolated branch; original checkout WIP was verified unchanged.

## Initial verification history (superseded by final result below)

- PASS: frozen install, final `bun run build`, `bun run typecheck`, `bun run check:api-surface` (9 goldens), `bun run check:version-authority`, `git diff --check`.
- Final `repo-harness run check-task-workflow --strict`: OK with this worktree's blocked plan and owner markers registered (`_ops/runtime-probe/workflow-final.log`). This is structural workflow evidence, not semantic external acceptance.
- Both full `bun run test` attempts: client 173 files passed, 1 failed, 2 skipped; 1753 tests passed, 1 failed, 11 skipped. The sequential root command stopped at client, so later packages were not tested by these invocations. Probe/adapter/CLI/diagnostics/admission tests passed in both final full runs.
- Run 1: `execution-recovery-kill.test.ts:350`, terminal:after-commit replay read local journal truth_state=pending while expecting confirmed after cloud completion.
- Run 2, unchanged implementation: `execution-recovery-kill.test.ts:452`, cloud receipt reconstruction expected complete but observed failed with terminalCause=runtime adapter contract violation during run.
- No baseline reproduction or root cause established; do not label these failures pre-existing or unrelated. Two different recovery failures exceed this slice's bounded verification scope; no recovery production code was changed to force passage, and no third full rerun was performed.
- Evidence logs (local ignored artifacts): `_ops/runtime-probe/final-build.log`, `final-typecheck.log`, `final-api-surface.log`, `final-version-authority.log`, `final-test.log`, `final-test-retry.log`, `workflow.log`.

## Delivery boundary

Local implementation and verification complete after the follow-up below. No commit, merge, push, publish, registry or downstream evidence. No independent external acceptance receipt exists; local checks are not a ship approval.

## Clean-refactor follow-up (2026-09-07)

User requested a clean refactor without deferred technical debt. Work remains within one detection authority, no old-shape translator, no new retry/cache/repair path. Recovery test synchronization is the bounded verification repair; recovery product source is untouched.

### Root Cause Evidence

- Observable failure: run 1 observed cloud complete with local journal pending; run 2 observed runtime contract violation while the controlled session was consuming its finish instruction.
- Concrete trace: `finish()` used async writeFile directly on the existence-signaled finish path; the child checks existsSync then JSON.parse(readFile), permitting an empty/partial read. Its untyped SyntaxError is projected by TaskRunner into run-phase contract violation. Separately, cloud completion precedes the HTTP ACK callback and `confirmTerminal`, so waiting for the cloud attempt is insufficient proof of local durable confirmation.
- Pre-fix reproduction: untouched base 0f8fdb4 passed 14 ordinary recovery tests. Baseline-only fault controls (partial publication held for 100 ms; local confirmation delayed 500 ms) reproduced each exact failure independently, with no runtime-detection changes. Negative logs are `_ops/runtime-probe/negative-partial.log` and `negative-confirm.log`.
- Candidate fix and discriminating verification: finish JSON is written to a same-directory pending path then atomically renamed; all live cloud-to-local confirmed assertions wait on the existing journal truth helper. With both original fault conditions retained, the two repaired baseline cases passed (2 passed, 12 excluded by name filter). Controls are diagnostic-only, not production env switches. See `positive-controls.log` and `baseline-controlled-fixture.patch`.

## Final verification

- `bun run test`: PASS across all 13 test-bearing workspaces, 3786 passed / 134 skipped by the existing suite configuration. Client: 1755 passed / 11 skipped, all 14 compiled recovery cases passed. Log: `_ops/runtime-probe/clean-final-test.log`.
- `bun run typecheck`: PASS after the final test synchronization repair; `_ops/runtime-probe/clean-final-typecheck.log`.
- Final production source was rebuilt after the output-overflow correction: build, API surface (9 goldens) and version-authority checks passed (`clean-final-build.log`, `clean-final-api.log`, `clean-final-version.log`). Final tests and typecheck include the corrected source and tests. `git diff --check` and SEA smoke shell syntax check passed; the cross-platform packaging matrix was not rerun for comment-only edits.
- The disposable baseline worktree was removed after its controlled experiment patch and logs were preserved under `_ops/runtime-probe/`. No injected environment switch enters the implementation.
- Both earlier verification blockers are resolved by correcting fixture publication and assertion boundaries, with no recovery production behavior changes.


- Final workflow check with the Review plan registered: PASS (`_ops/runtime-probe/clean-final-workflow.log`). Original checkout WIP was rechecked unchanged after removing the disposable baseline.

## Final contract cleanup

Read-only consumer mapping found no remaining legacy detection authoring outside intentional rejection tests. `RUNTIME_DETECTION_FAILURE_KINDS` remains an internal module export used by the type/validator/diagnostics, not a root runtime API export. Daemon registration/admission preserve their existing direct custom detect await; CLI has a separate observation deadline. No cancellation compatibility shim was added.

Updated active Bun/SEA packaging docs, launcher comment and SEA smoke comment to the new success/failure vocabulary. Package resolution failure is probe-failed; explicit missing executable is not-found. This is documentation alignment, not a claim that the packaging matrix was rerun.

A real TERM-ignoring child that exceeded stdout maxBuffer reproduced a remaining classification defect: cleanup reached the probe deadline and overwrote the already-known output-limit failure with timeout. The execFile callback now retains its explicit ERR_CHILD_PROCESS_STDIO_MAXBUFFER cause as probe-failed even if deadline SIGKILL was required for cleanup. A parameterized real-process regression covers both TERM behavior variants; 30 focused probe tests passed. No message parsing or fallback was introduced.

## Approved independent acceptance and merge preparation

User approved independent acceptance and preparation of a mainline merge candidate. No actual push, mainline merge or publication is implied. Initial frozen commit f7ff9d4 reviewed against freshly fetched origin/main=0f8fdb4; merge-tree had no conflicts and worktree was clean.

Independent review correctly rejected the stale piDetect.present assertions in both packaging smokes. The parser and expectations now consume kind directly, closing the missed downstream authoring-contract cutover. Pre-fix Bun smoke reproduced the failure. SEA initially stopped earlier because the shell selected Node 26.3.1; the repo's .node-version is 22.22.3. A temporary exact Node 22.22.3 was installed in ignored _ops; global Node is unchanged. Final verification is rebound to the corrected commit and pinned runtime. The prior root results remain valid for their original environment but are not CI-Node evidence.

Final independent review and merge candidate receipt are local artifacts under _ops/runtime-probe so recording acceptance does not change the reviewed commit. Task status remains Review until separately authorized integration; no external harness receipt is fabricated.
