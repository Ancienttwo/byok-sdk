# Plan: C07 record-aware detection and typed refusal

> Status: Executor evidence complete; independent product gate pending
> Task Profile: feature
> Task Contract: `tasks/contracts/20260917-c07-record-aware-detection.contract.md`
> Task Review: `tasks/reviews/20260917-c07-record-aware-detection.review.md`
> Implementation Notes: `tasks/notes/20260917-c07-record-aware-detection.notes.md`

## Goal

Register API-D+API-R as one SDK public-boundary design: both installed forms bind detection to their existing runtime authority and fixed dispatch prefix, and named refusals survive validated local projections without arbitrary diagnostics. Initial docs-only registration was accepted; af77aee2 bounded product review subsequently activated the exact implementation scope. No runtime dispatch is enabled.

## Authority / isolation

Supervisor explicitly released this docs-only slice after accepting Salesko public consumption packet2a692dc. Worktree byok-sdk-wt-c07-pi-launch, branch codex/c07-pi-runtime-launch, clean basef5258d8f. Root is sole writer of the five files in this contract. Salesko transaction8c934f8/producteb5b6cc remains accepted and untouched. No new branch required for docs; no push inferred. Native and all other trees read-only.

## P1 / P2 / P3

P1: Host selected runtime declaration → shared physical measurement → client detection/prepare → strict result validation → daemon/task selection and CLI/doctor projection.
P2: current Pi detect ignores the configured authority and fixed dispatch prefix, performs resolveBin/CLI version probing, then generic error classification; Salesko therefore explicitly refuses and observes only probe-failed. Configured task prepare already resolves the record separately.
P3: one authority per datum; reuse measurement, do not duplicate the record reader or create a second author. Detect is local observation, not credential authorization/readiness/admission or a cache for prepare. At10x, fresh asset measurement grows linearly; no cache or extra per-kind child launches are assumed.

## Task Breakdown

- [x] Confirm clean SDK subject and read current specification/public call paths.
- [x] Map detect, default/injected adapter construction, task/daemon validation and local display consumers.
- [x] Register closed docs-only paths, authority constraints and semantic negative vectors.
- [x] Supervisor bounded design review accepted a4dab4a4 and freeze8e9d8416; Q1-Q4 directions accepted without freezing API shape.
- [x] Record accepted directions and exact product-entry prerequisites; product registration remains a separate review boundary.
- [x] Exact product candidate af77aee2 accepted; Q5-A fixed order/first reason/equal version, exact paths activated.
- [x] Commit test-only drivers8c9f7a26 and preserve real behavioral RED5/6.
- [x] Implement physical observation, routing, refusal and consumer cutover; focused verification and two-golden review.
- [x] Freeze product9f697036/docs d5949148 and run discovery14-package matrix once; retain23 new fixture failures plus inherited S2.
- [x] Register03c82d99 and correctc5c5e081 only two local fake-adapter declarations; original assertions/product unchanged.
- [x] Freeze correctionc5c5e081; client full once:2801 passed, only inherited S2 failure; combine unchanged13-package evidence.
- [ ] Independent gate: build/typecheck/focused/API/strict/release-pack; do not repeat full.

## Verification

Scope/hash/attribution/diff/YAML/workflow plus product required checks. Executor runs one complete test matrix on the frozen head; supervisor gate independently runs build/typecheck/focused checks/api/strict/release-pack and reads the full raw logs/hashes, without a second full run. Existing native/S2/Windows limitations remain explicit; no new failure is automatically waived.
