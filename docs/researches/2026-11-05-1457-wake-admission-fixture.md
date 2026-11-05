# Wake admission fixture ordering (#1457)

Issue/design: [#1457](https://github.com/Ancienttwo/byok-sdk/issues/1457).
Base: `6ae713bcb0a294a8e6223b9d3f416d3612cec508`.

## Failure and baseline

[CI job 126985856252](https://github.com/Ancienttwo/byok-sdk/actions/runs/41948054037/job/126985856252)
failed `wake-inbox.test.ts`'s “keeps the admission digest and original selection
when cancel and expiry shrink a real claim”: expected `[1,2,3]`, got `[1,2]`.
That retention PR (#1456) had no changes to cloud-do or the lockfile.

On Linux with Node 24.22.1 and Vitest 4.1.12, the isolated original case passed
on base and #1456 head. On the separate base worktree, temporarily inserting
a 250 ms await between the second and third enqueue reproduced the exact
selection failure. The diagnostic was restored. The test's 200 ms due-time
offset does not ensure all three sequential RPCs finish before the real alarm.
`pauseAdmission` holds the admission response after selection; it cannot add a
later message to that selection. This demonstrates an existing test timing
hazard, not the measured interleaving of the original CI failure.

No matching repair was found in issue/PR searches for wake-inbox, original
selection and admission/alarm, or wake/admission branch searches. Closed #428
and #461 concern different cases in the same file. The existing 16-row
snapshot case already uses the fixture's alarm gate for the same setup concern.

## Event-driven regression and repair

The revised case waits after its second enqueue until `fixture_alarms` shows
the real platform alarm has arrived. It asserts that admission has not begun,
then enqueues the third row. Adding that checkpoint on the un-gated baseline
failed: expected zero admission records, got one (one isolated test, no retries).

The repair adds `pauseAlarm: true` at setup and calls `release-alarm` only after
the third enqueue. The same checkpoint and all original digest, selected-seq,
cancel, expiry, receipt and actual input assertions pass. Admission remains
paused until the original cancel/expiry operations are complete. No product
code, fixture interface, test timeout, fixed sleep or retry was added or changed.

## Checks and limits

- Isolated checkpoint: observed RED before the gate, GREEN after it.
- Complete `wake-inbox.test.ts`: 120/120 passed (103.67 s).
- Root build, typecheck, API surface (all nine existing goldens) and version
  authority checks pass. No API, budget, dependency or generated-file changes.
- Build's Cloudflare invocation is the existing `--dry-run`, not deployment.
- No complete repository test suite or old CI rerun was requested. #1456 stays
  Draft with its original failed CI and baseline evidence intact.

The tests run real local Miniflare/workerd alarms and SQLite, with synthetic
inbox rows and a local provider response fixture. No user credentials, live
provider calls or running services are involved. This change stabilizes test
setup; it is not a product admission semantics change. Hosted CI and formal
review are separate gates for the new Draft PR.
