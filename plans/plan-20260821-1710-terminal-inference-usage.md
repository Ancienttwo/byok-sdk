# Plan: Optional Terminal Inference Usage

> **Status**: Complete
> **Created**: 20260821-1710
> **Slug**: terminal-inference-usage
> **Artifact Level**: work-package
> **Verification Boundary**: protocol codec, all terminal variants, client projection, hosted receipt/result projection, additive golden compatibility
> **Rollback Surface**: revert the additive usage schema and projections before any release
> **Dependency**: U1 releases ownership of `docs/protocol.md`; U4a freezes the single Local Agent identity projection before `clientVersion` is wired

## Goal

Define one optional, normalized inference-usage block for `task.complete`,
`task.fail`, and `task.cancelled`. Missing usage leaves terminal validity
unchanged. The same typed object must survive codec, receipt, and
`TerminalResult` projection without raw-receipt parsing or reuse of storage
quota/accounting types.

## P1 — Authority map

- `@byok-sdk/protocol` owns the bounded additive schema and canonical codec.
- `@byok-sdk/client` projects only facts supplied by the selected runtime;
  unknown metrics are omitted, never synthesized as zero.
- `@byok-sdk/cloud` owns typed terminal receipt/result projection.
- U4a owns process-immutable Local Agent identity; U2 may consume its public
  projection but must not author a second version string.
- Salesko owns non-billing ledger policy and idempotent product projection.

## P2 — Concrete trace

Runtime terminal observation → TaskRunner terminal envelope → protocol codec →
hosted first-terminal receipt → typed `TerminalResult` → Salesko ledger. The
usage object is one optional observation across every boundary. Invalid
numbers, timestamps, or sizes fail schema validation; omission remains valid.

## P3 — Decision

Create a dedicated `TerminalInferenceUsage` contract. Do not reuse
`TenantStorageUsage`, parse provider catalogs, infer missing metrics, or treat
device-reported time/tokens as billing authority. At 10x, the first pressure
point is receipt/result payload size, so every string and numeric field is
bounded in protocol.

## Proposed shape

```ts
interface TerminalInferenceUsage {
  runtime: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  clientVersion: string;
  reportedAt: string;
}
```

Exact public naming is decided during implementation. Token and duration
values are bounded non-negative safe integers. `reportedAt` is canonical UTC
device observation, not server time. Unknown values are omitted.

## Scope / ownership

- Owns terminal schema/codec/goldens in `packages/protocol` after U1 code freeze.
- Owns terminal construction/projection tests in `packages/client` and
  `packages/cloud`.
- Does not own storage usage, billing, entitlement, release publication, or
  Salesko code.
- Separate contract worktree required before source edits.

## Acceptance matrix

- complete/fail/cancelled with and without the entire usage block
- partial metrics and omitted unknown fields
- negative, unsafe, non-integer, oversized, and malformed timestamp rejection
- first-terminal-wins replay with usage preserved from the winning receipt
- old-daemon omission remains valid
- canonical roundtrip and additive protocol-golden justification
- typed `TerminalResult` exposes the same object; no raw receipt parser

## Task Breakdown

- [x] Create a dedicated strict contract/worktree after U1 releases overlapping protocol/docs ownership.
- [x] Freeze the U4a identity field/type consumed by `clientVersion` (or its final name).
- [x] Add red codec/golden tests for the full acceptance matrix.
- [x] Implement one bounded protocol schema across all three terminal payloads.
- [x] Add client and cloud typed projections without storage-usage coupling.
- [x] Run targeted suites, full required checks, strict workflow validation,
  review, and packed-artifact API readback.

## Authorization boundary

Source, tests, docs, and local release evidence only. No publish, deploy,
production migration, secret mutation, or Salesko integration is authorized.
