# Release readiness audit — 2026-09-08

## Decision

The condition “all work is handled” is not met. Do not label the current source
release-ready or produce/publish 0.14.1 artifacts yet. This audit corrects README
publication status and records the already-landed R1–R6 changes in CHANGELOG;
it does not modify version policy, package manifests, runtime behavior or WIP.

## P1: authorities and current state

- Remote main: `32f3a80cdfc501a914aef60f2b9759707200e367`; its push CI
  [34128146028](https://github.com/Ancienttwo/byok-sdk/actions/runs/34128146028)
  completed successfully. It contains accepted PR168/169 and R1–R6.
- npm latest: SDK `0.14.0`, keys `0.4.0`, read directly from the registry.
- Remote `v0.14.0` Git tag exists, but its GitHub Release endpoint returns 404.
  GitHub's latest published Release is `v0.13.0`. This is a missing release page,
  not evidence that the 0.14.0 npm train was never published.
- Source manifests and spec target unpublished SDK `0.15.0` / keys `0.4.1`.
  README incorrectly carried the old “all artifacts registry-verified” statement
  next to that candidate, named Pi 0.84.2 despite manifest 0.85.1, and suggested
  installing an unpublished package version. Those statements are corrected.
- Local main checkout is `1dcbff5` with unrelated WIP. No checkout reset/pull or
  WIP mutation was performed. The existing release-015-prep/runtime-probe branch
  tips are ancestors of remote main; they are not missing integration work.

## P2: remaining execution paths

| Finding | Current remote source | Existing work and remaining gap |
| --- | --- | --- |
| R7 P1 | `AgentMessageOutbox.compact` and `AgentReliableSpool.compact` omit the final newline. The next append can concatenate JSON objects, making reopen fail. | `codex/r7-jsonl-compaction` has uncommitted two-writer repairs and six natural-compaction regressions. Its note reports 22 targeted tests and 3822 full tests passed / 135 skipped on its earlier base. These are local evidence, not merged-source/CI evidence. The fix is absent from remote main. |
| R8 P2 | Cloud validates an earlier task read, then awaits atomic `tasks.claim` but discards the returned claimed identity. Concurrent conflicting claims can both receive admission despite one stored owner. | The supplied prior isolated probe reproduced this ordering; current `applyLifecycle(task.claim)` still does not inspect the returned identity. Needs atomic-outcome validation and concurrent identity regression. |
| R9 P1 | TaskRunner persists `refused`, clears the timer and revokes message context, then returns. Pending message completion is published only by the accepted path. | The supplied prior isolated probe left an active task/pending completion with no terminal/disposal. Needs refusal convergence through the existing terminal/disposal authority, including before/after turn_end races. |

Prior R7–R9 probe notes were inspected in the main checkout. They explicitly used
isolated source probes on Node 26.3.1 and are not whole-SDK, supported-runtime or
new-main execution evidence. This audit traced the current remote source and did
not rerun those probes or the full repository tests. Closed GitHub issues and
green CI do not establish that these separately recorded scenarios are fixed.

## P3: release scope and smallest next step

The requested 0.14.1 remains conditional on completion. Current main includes a
breaking custom RuntimeDetectResult contract, new public methods/signals and
protocol/migration additions compared with v0.14.0. The current spec deliberately
assigns these to MINOR 0.15.0. Preparing the entire main tree as 0.14.1 would need
an explicit release-scope/policy decision; this audit does not silently downgrade
manifests or drop changes to make a patch number fit.

First land the existing bounded R7 fix after rebasing/validating its exact source,
then repair R9 terminal convergence and R8 atomic claim outcome handling. Freeze
one combined source only after these pass. Reconcile the chosen release train,
keys dependency edge, README/CHANGELOG, exact push-CI pack manifest and registry
vacancy at that boundary. A GitHub release page is created from an actually
published train, not used as a substitute for npm publication.

## Verification and limits

- Read back remote main, accepted merge CI, all open issues, GitHub release list,
  the v0.14.0 tag and release endpoint, and npm SDK/keys latest versions.
- Verified release/runtime-probe branch ancestry against remote main.
- Documentation change: version-authority and diff whitespace checks passed.
- A release-graph attempt in this fresh documentation-only worktree could not
  resolve dependencies because node_modules is not installed; no install or
  repack was performed. The unchanged code's successful main CI remains the
  existing source evidence, not a new release candidate certification.
- No npm/GitHub release publication, tag creation, merge, deployment, production
  migration or modification of the existing R7 worktree was performed.
