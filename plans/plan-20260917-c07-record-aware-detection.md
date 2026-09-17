# Plan: C07 record-aware detection and typed refusal

> Status: Docs-only design accepted at a4dab4a4; exact product registration pending
> Task Profile: docs-only
> Task Contract: `tasks/contracts/20260917-c07-record-aware-detection.contract.md`
> Task Review: `tasks/reviews/20260917-c07-record-aware-detection.review.md`
> Implementation Notes: `tasks/notes/20260917-c07-record-aware-detection.notes.md`

## Goal

Register API-D+API-R as one SDK public-boundary design: both installed forms bind detection to their existing runtime authority and fixed dispatch prefix, and named refusals survive validated local projections without arbitrary diagnostics. No product/API implementation or activation in this slice. Final API shape is decided in SDK review.

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
- [ ] Submit exact API/spec/golden decisions, pre-fix driver plan and coherent consumer/path scope for product review; do not write product before acceptance.

## Verification

Scope/hash/attribution/diff/YAML/workflow checks only. Vectors are documentation, not executable tests and not PASS evidence. Do not repeat build/typecheck/full/pack on unchanged product. Future product slice must register exact implementation/test/golden/spec paths and use real pre-fix evidence before editing.
