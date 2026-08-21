# Plan: Tenant Readiness Primitives

> **Status**: Executing
> **Created**: 20260821-1715
> **Slug**: tenant-readiness-primitives
> **Artifact Level**: work-package
> **Promotion Reason**: This slice couples a public SDK read model, a forward-only PostgreSQL migration, and daemon WS/HTTP identity projections across Core, Cloud, Dataplane, Client, and Protocol. The tenant-isolation and expiry/revocation invariants must be reviewed and rolled back as one unit, so a checklist row cannot provide sufficient scope or evidence authority.
> **Verification Boundary**: tenant-scoped device plus unexpired-presence aggregate with in-memory/PostgreSQL parity
> **Rollback Surface**: revert the additive readiness projection before release
> **Dependency**: U4a Local Agent release identity must freeze first

## Goal

Expose one SDK-owned per-tenant readiness projection over durable device facts
and TTL-bounded presence hints. Salesko consumes the aggregate for policy; it
must not join `listDevices()` and `listPresence()` or invent expiry/revocation
semantics.

## P1 — Authority map

- durable device/pairing/revocation facts remain cloud/dataplane authority.
- presence remains lossy, unsigned, TTL-bounded observation; expiry means absent.
- U4a owns the single Local Agent release identity projected into presence.
- SDK owns aggregation semantics and tenant isolation; Salesko owns admission,
  queueing, API/UI response, and fail-closed behavior when unavailable.

## P2 — Concrete trace

Device pairing/revocation plus latest unexpired presence publication →
tenant-bound store query/aggregate → `ByokCloud` readiness read model → Salesko
admission policy. Revoked devices never count as observed-online even if a stale
presence row remains. Missing runtime/auth facts remain unknown.

## P3 — Decision

Add one public aggregate (final naming may differ from
`readTenantReadiness`). Field names must say `observed`/`hint` rather than
claim authoritative readiness. Do not add a scheduler, load score, capability
heuristic, semver gate, or host-side fallback aggregation. At 10x, the first
pressure point is per-device joins, so PostgreSQL must aggregate set-wise.

## Scope / ownership

- Owns the public readiness type/API and in-memory/PostgreSQL aggregate stores.
- Owns presence projection of U4a release identity for both WS and first-hop
  long-poll publication paths.
- Runtime inventory/auth fields enter only with a real probe authority;
  otherwise the schema represents unknown by omission.
- Separate contract worktree; begins after U4a identity freeze.

## Acceptance matrix

- zero devices; active paired; revoked-only; paired without presence
- each presence level and exact TTL expiry boundary
- revoked device with residual presence
- multi-tenant isolation
- missing release/runtime/auth facts remain unknown
- WS and first-hop long-poll report the same identity/readiness facts
- in-memory/PostgreSQL parity and set-wise query evidence

## Task Breakdown

- [ ] Complete/freeze U4a process identity and packed-manifest parity.
- [x] Create a dedicated strict contract/worktree with mutually exclusive presence-schema ownership.
- [x] Define red projection tests and exact TTL/revocation semantics.
- [x] Implement tenant-bound aggregate ports and both store compositions.
- [x] Project the single U4a identity through both device publication paths.
- [x] Run targeted suites, real dataplane parity, full required checks, and review.

## Authorization boundary

No publish, deploy, production migration, secret mutation, Salesko glue,
capability/load scheduler, or admission-policy implementation is authorized.

## Evidence Contract

- **State/progress path**: this plan's `## Task Breakdown`,
  `tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md`,
  `tasks/reviews/20260821-1715-tenant-readiness-primitives.review.md`, and
  `tasks/notes/20260821-1715-tenant-readiness-primitives.notes.md`.
- **Verification evidence**: the four focused U3 suites, the disposable
  Postgres+MinIO readiness suite with migration application, `bun run build`,
  `bun run typecheck`, `bun run test`, and the strict workflow/contract traces
  under `.ai/harness/checks/` and `.ai/harness/runs/`.
- **Evaluator rubric**: the review must confirm all declared presence levels,
  zero/expiry/revocation/multi-tenant parity, set-wise PostgreSQL aggregation,
  bounded presence input, and one U4a identity source across WS and first-hop
  HTTP; it must also distinguish local substrate evidence from production.
- **Stop condition**: U4a identity freeze is complete, all Task Breakdown
  items are complete, required local and real-substrate checks pass, and the
  strict contract verifier records a current result.
- **Rollback surface**: revert the additive readiness projection and
  `0010_tenant_readiness.sql` before release; no production migration or
  publish action is authorized by this work-package.

## Promotion Gate

- **Merge/PR unit**: the tenant readiness projection, its single forward-only
  migration, and the matching WS/first-hop identity tests move together.
- **Rollback surface**: revert the additive projection and `0010` migration
  before release; do not create a compatibility aggregate or host fallback.
- **Verification boundary**: focused U3 tests, real Postgres+MinIO readiness
  parity, workspace build/typecheck/test, deploy SQL ordering, strict workflow,
  and strict contract verification.
- **Review/acceptance boundary**:
  `tasks/reviews/20260821-1715-tenant-readiness-primitives.review.md` must
  record the source/substrate result and any harness residual.
- **High-risk surface**: tenant isolation, revoked residual presence, exact TTL
  expiry, forward-only schema ordering, and release-identity authority.
- **Why not checklist row**: the public, persistence, and daemon projection
  invariants span five packages and a migration; their safety depends on one
  bounded contract rather than independently landable edits.
