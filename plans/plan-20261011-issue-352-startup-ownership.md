# Issue 352: Own startup resources in one client module

Status: Complete (implementation, local validation, and Draft PR)
Issue: https://github.com/Ancienttwo/byok-sdk/issues/352
Approval: The owner approved this slice on 2026-10-11.
Base: 45d104282431cd93a1b2c9e5df00c5720bab6e53

## Scope

Move the existing startup resource owner into a private client module.
Keep public exports, wire schemas, storage formats, adapters, and active task finalization unchanged.
Do not copy RAFT source into this MIT project.

## P1: Boundary

TaskRunner receives admitted offers and owns task contexts.
StartupOwnership will own resources before active task registration.
TerminalCommitQueue remains the terminal commit authority.
Runtime start remains responsible for late sessions and cleanup receipts.

## P2: Path

Durable receive -> offer settlement -> prepare -> claim -> startOwnedRuntime.
A returned or aborted startup registers an owner.
The owner settles terminal intent, checks pending startup, disposes runtime,
awaits terminal commit, and releases the lease in that order.
The active task handoff remains synchronous.
Shutdown waits for offer settlements before disposing startup owners.

## P3: Decision

Extract the existing map, disposal single flight, and retry timer.
Use callbacks for in-flight checks, retry admission, terminal commit, and context cleanup.
Keep one startup map. Keep TaskRunner's context and cancellation authorities.
A grace timeout is not a runtime cleanup receipt.
The change is a refactor, not a new fault fix or performance claim.

## Task Breakdown

- [x] Install frozen dependencies and run the existing baseline build and focused tests.
- [x] Add StartupOwnership and route every existing startup use through it.
- [x] Add tests for cleanup order, single flight, retry, late startup, and synchronous transfer.
- [x] Run the focused tests and all five required checks. Keep exit-code evidence.
- [x] Complete independent review and self-review.
- [x] Open a Draft PR.

## Verification

Focused tests: runtime-start, task-runner-shutdown-startup, task-runner-cancel-race,
task-runner-shutdown, terminal-commit-queue, adapter-disposal-parity, daemon-control-socket,
and the new startup-ownership tests.
Required: bun run build; bun run typecheck; bun run test;
bun run check:api-surface; bun run check:version-authority.
Do not change existing test assertions to fit the extraction.

## Reference

The [approved issue](https://github.com/Ancienttwo/byok-sdk/issues/352) uses the installed RAFT Computer 1.0.45 as the primary reference.
The readable 1.0.43 source links remain explicitly secondary.
See `docs/researches/2026-10-11-raft-computer-1.0.45-startup-ownership.md`.
These references support the design discussion, not code reuse.

## Verification notes

The baseline build and seven focused suites passed (42 tests).
The extraction and five new owner tests passed (47 tests in eight suites).
The first required run passed build, typecheck, and version authority.
The Pi workflow test failed without an explicit Bun path on both the patch and unchanged main.
The existing BYOK_TEST_BUN_BIN setting points to the installed Bun for the final test run.
The API golden update changes only private opaque members and comments.
Public declaration text is identical after those private details are removed.
No existing test assertion or API gate implementation was changed.

The strict copied-host check failed with the same Homebrew Node loader error on unchanged main.
An official Node 24.21.0 archive was SHA-256 checked and used only in ignored worktree operations.
The copied Node host case passed with that interpreter.
One default-worker full run failed 50 wake-inbox tests. The same 128-test file passed independently on main and this branch.
An earlier four-worker full run timed out in Pi export asset construction. The final passing run used one file worker.
No test assertion, timeout, skip rule, or test-runner source was changed.

Final required checks all returned exit 0 with official Node 24.21.0, Bun 1.4.3, an explicit Bun pin, and VITEST_MAX_WORKERS=1.
Vitest reported 7487 passed and 160 skipped. The root test command also ran Cloud DO Node test scripts.
The 128 wake-inbox cases and the two Pi export asset cases passed on both unchanged main and this branch.
Earlier parallel failures and supported-runtime setup failures remain recorded; this is not a claim that all parallel profiles passed.
MIT, manifests, wire schemas, and storage formats are unchanged.

## Review

The native gatekeeper accepted the final six-file patch in the second review round.
Coverage includes the full final diff and relevant caller paths.
It found no blocking code or test issue. The stale worker-count sentence above was corrected.
The earlier parallel failures and platform/substrate skips remain limits of the evidence.
The review does not approve a merge, release, or deployment.

## Delivery

Draft PR: https://github.com/Ancienttwo/byok-sdk/pull/354.
Implementation commit: a4f947470a8840453540f31fc2022b6d34a2dcb0.
The pushed branch matches this commit. The PR is open and remains a draft.
CI has started. Merge, release, and deployment are outside this delivery.
