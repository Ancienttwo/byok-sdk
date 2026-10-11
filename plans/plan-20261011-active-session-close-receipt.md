# Share the active Session close receipt

Status: Review
Approval: The owner approved this slice on 2026-10-11.
Base: 714fc4537ae1142722f29a308eaf35212d07f89d
Previous slice: https://github.com/Ancienttwo/byok-sdk/pull/354 (merged)

## P1: Boundary

TaskRunner owns the active task and its Session close receipt.
interruptBounded starts close. finishOnce waits for the receipt and reports failure.
TerminalCommitQueue remains the durable terminal authority.
Session.close remains the adapter quiescence receipt.

## P2: Path

Cancel selects the semantic terminal before it awaits interrupt.
interruptBounded starts close and permits queued events to drain.
finishOnce waits for close, then terminal commit, then snapshot and lease release.
Failed close retains the active task. A later retry reuses the selected terminal.

## P3: Decision

Keep the change inside TaskRunner. Do not add a module or another state map.
Use one helper to create and reuse the close receipt.
Use one helper to await it and keep the existing failure classification and retry clearing.
Store the Promise before calling Session.close. This also converts a synchronous throw into a rejected receipt.
Clear a failed receipt only when finalization reports it. An early rejection observer must not clear it.
Keep semantic terminal selection, contexts, snapshot, terminal commit, and lease release in their existing places.
No new framework, public contract, storage format, or license change.

## Task Breakdown

- [x] Run the existing affected tests on the merged baseline.
- [x] Add focused receipt tests through the real TaskRunner interface.
- [x] Share close creation, reuse, and failure retry handling.
- [x] Run build, typecheck, test, check:api-surface, and check:version-authority.
- [x] Review the change and verify that existing assertions remain intact.
- [ ] Push the branch and open a Draft PR.

## Verification

Keep existing assertions, timeouts, and skip rules.
Cover concurrent cancellation/shutdown, a failed close followed by retry, and a synchronous close throw.
Use task-runner shutdown/cancel tests, daemon shutdown parity, native cancel, terminal commit, and adapter disposal tests.
Use the same verified official Node 24.21.0 and Bun 1.4.3 from the previous slice.
Use BYOK_REQUIRE_BUN=1 and VITEST_MAX_WORKERS=1 for the local full run.
Local Docker dataplane suites retain their optional-substrate skips.

## Verification notes

The merged baseline passed 89 affected tests in six files.
The three new tests ran before implementation. The concurrent receipt case passed.
The typed and untyped synchronous close cases failed because no disposal failure event was recorded.
After implementation all 92 affected tests passed in seven files.
The new tests drive the real TaskRunner with the existing in-memory Session fixture.
They do not claim to reproduce a bundled runtime process failure.
Existing test assertions, timeouts, and skip rules are unchanged.

Build, typecheck, API surface, and version authority returned exit 0.
The client declaration golden adds only two opaque private member lines.
Removing those two lines restores the exact baseline bytes.
The API gate implementation is unchanged.
The full test run returned exit 0. All five required checks returned exit 0.
Vitest reported 7490 passed and 160 existing skipped cases across 15 packages and examples.
Cloud DO Node scripts reported 15 passed. The optional Docker dataplane substrate was not enabled.
Local validation uses one file worker. It does not prove every parallel profile.
MIT and manifests are unchanged.

## Review

The first read-only review found no blocking code or test issue.
It checked all four files and the related cancel, shutdown, pump, and finalization paths.
Its first-round acceptance was pending the full test exit code.
The second and final review accepted the patch after reading all five exit codes and final test summaries.
Coverage is complete for the four-file patch and recorded local profile. No blocking issue was found.
This acceptance does not approve a merge, release, or deployment.
