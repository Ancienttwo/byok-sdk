> **Outcome**: Completed
> **Archive Projection V1**: `plans/plan-20260908-embedded-operator-apis.md` => `plans/archive/plan-20260908-embedded-operator-apis.md`

# Public embedded-host operator APIs

> **Status**: Archived
> **Task Contract**: tasks/contracts/20260908-embedded-operator-apis.contract.md
> **Implementation Notes**: tasks/notes/20260908-embedded-operator-apis.notes.md
> **Task Review**: tasks/reviews/20260908-embedded-operator-apis.review.md
Approval: user approved SDK public export and acceptance slice, 2026-09-08.
Base: 9de5e12, isolated codex/embedded-operator-apis worktree. Main SDK and Salesko WIP remain untouched.

## P1 Architecture Map
Client diagnostics owns bounded health inspection/quarantine and redacted support bundles. AgentMessageOutbox owns terminal audit snapshots and live-log compaction. Device store/owner and AgentHomeManager own identity/leases. Embedded hosts and SDK CLI are consumers; host service lifecycle remains outside the SDK operator APIs.

## P2 Concrete Trace
Health: public confirmation -> control offline check -> existing quarantine owner lease + bounded corrupt source -> durable evidence/manifest -> source removal -> receipt.
Bundle: real host adapters -> existing collect/redaction -> existing atomic no-overwrite writer -> receipt; no credentials or source mutations.
Archive: confirmation/exact expected tenant/device/AgentRef -> device owner -> metadata binding -> canonical existing Agent home + exclusive Agent lease -> complete outbox identity check -> bounded terminal evidence -> durable archive before live log replacement -> receipt. Archive files are sensitive local audit material, never another recovery input.

## P3 Decision
Three public functions plus closed operator error codes; no public internal DI seams, deep imports, shadow storage parser, service manager or background maintenance. Reuse owning code. Bound archive source bytes; reject symlink/nonregular input, wrong identity, live writers, existing output directories. Preserve original records/profile revisions and pending/held messages. Additive public API requires prepared SDK0.16.0 / keys0.4.2 graph; publication is separate. At 10x scale archive memory/disk and diagnostic probe cost fail bounded rather than scanning all Agents.

Approval follow-up: user approved independent acceptance; completed with one reviewer-prescribed README correction and passing delta checks. Release freeze/publication remain outside this slice.

## Task Breakdown
- [x] Implement public health quarantine, support bundle and per-Agent terminal archival functions/types.
- [x] Add public-boundary confirmation/lease/identity/redaction/no-overwrite/receipt tests; reuse internal fault tests.
- [x] Update API golden, minor train manifests/lock and spec/changelog/integration guidance.
- [x] Independent acceptance and prescribed documentation correction with delta checks.
- [x] Build, focused tests, full required checks, built public-import and compiled-host smoke and record evidence.

Allowed paths: packages/client/src/diagnostics/operator-actions.ts (new public composition), diagnostics/types.ts, diagnostics/diagnostics.ts, client index.ts, public operator tests; existing outbox terminal selector reused to avoid duplicate classification; package manifests/bun.lock; api-surface/client.d.ts; README/CHANGELOG/docs spec/integration guide; matching plan/contract/notes/review and docs/researches/2026-09-08-embedded-operator-apis evidence.
No publish/tag/push/deploy, production data, credentials, or downstream pin to an unpublished version. Salesko stays on the verified released dependency until a consumable new release exists.
