# Implementation Notes: authenticated-enrollment-tenant-projection

> **Status**: Active
> **Plan**: plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md
> **Contract**: tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md
> **Review**: tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md
> **Last Updated**: 2026-08-23 20:27
> **Lifecycle**: notes

## Design Decisions

- Cloud pairing code claims and the registered cloud device row remain the
  authentication authority. The new wire field is only their non-secret opaque
  projection; it is never accepted from PairRequest.
- Client `DeviceRecord` becomes the one durable local enrollment projection.
  Its parser rejects a missing/invalid tenant binding, so pre-Stage-A records
  require re-pair rather than falling back to config or token parsing.
- `AgentEgressConfig` and `HostedJournalConfig` no longer author tenantId.
  Daemon start loads the record under the existing lifecycle/owner lease and
  binds egress/content/ack/journal operations to `record.tenantId`.
- Renewal spreads the exact record and changes only token/expiry. Re-pair saves
  a complete new record atomically after validating the required response.
- The required wire/config break prepares aligned 0.7.0. Because keys pins core
  exactly, its independently versioned companion candidate is 0.3.0. Neither is
  authorized for npm publication in this work-package.

## Deviations From Plan Or Spec

- `contract-worktree start` could not initialize CodeGraph and conservatively
  reported unresolved architecture. A direct `codegraph init` in the isolated
  worktree succeeded (640 files, 10,040 nodes, 44,026 edges), then
  `switch-plan` restored the strict active markers.
- The initial contract omitted the explicit `Workflow Profile` header, so state
  resolution returned `invalid_risk_input`. Adding `strict` restored an
  executing state with allowed-path enforcement; no product code had changed.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Host config + equality check | Rejected | Retains two tenant authorities and a mismatch state. |
| JWT/access-token decode | Rejected | Couples identity to secret token format and violates the no-parsing boundary. |
| Optional response/legacy fallback | Rejected | Lets an old record run without authenticated tenant provenance. |
| Required response/record and re-pair | Adopted | One explicit authority and fail-closed migration boundary. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- P1 static authority: `packages/cloud/src/auth/plane.ts` redeems code claims and
  registers the tenant-bound device; cloud/reference pair handlers currently
  return only deviceId/token/refresh metadata.
- P2 local gap: `packages/client/src/daemon/auth-manager.ts` saves a DeviceRecord
  without tenantId, while `packages/client/src/daemon/create-daemon.ts` consumes
  host-authored `config.agentEgress.tenantId`.
- P3 migration boundary: required record parser failure with explicit re-pair;
  no steady-state migration or fallback.
- Release graph proposal: aligned dispatch packages 0.7.0 and independently
  versioned keys 0.3.0; `check-package-graph` passes after exact bun.lock
  workspace-record updates. npm remains untouched.
- Focused projection tests pass in protocol (7), hosted cloud (2), reference
  server (3), client persistence/composition (8), and real disposable
  Postgres dataplane (1). The dataplane probe sends a conflicting request
  tenant, proves the response/device row retain the pairing-code tenant, then
  opens a fresh pool and reads back exact cross-tenant isolation.
- Full `bun run test` passes after one unchanged retry. The first run's sole
  failure was the existing worker-packaging Wrangler dry-run exceeding its
  fixed 5-second timeout; the retry completed that package with 74 passing and
  86 intentionally skipped tests. `bun run build`, `bun run typecheck`,
  `bun run check:release-graph`, release pack-smoke unit tests,
  `check-task-workflow --strict`, and `git diff --check` pass.
- Static source search finds no client `agentEgress.tenantId` or
  `hostedJournal.tenantId` configuration source and no access-token/JWT tenant
  parsing. Focused egress tests also assert access-token and private-key bytes
  do not appear in captured egress, journal, or wire envelopes.
- The release pack smoke closed all 10 tarballs to exact internal 0.7.0 edges
  (keys 0.3.0 -> core 0.7.0). A dedicated empty disposable Postgres database
  then passed the packed migration smoke across 13 migrations and was dropped;
  this remains local RC evidence, not npm publication or registry readback.
- Change Assessment declares both deterministic projection tests and runtime
  restart/dataplane readback across the whole selected auth/public-API surface.
- Independent review found `packages/client/README.md` still documented the
  removed host-authored `agentEgress.tenantId`. The contract scope was widened
  to both READMEs, the stale field was removed, and the root README now states
  that runtime tenant identity comes only from persisted authenticated
  enrollment. Published-current install pins intentionally remain 0.6.1 and
  keys 0.2.2 until a separately authorized registry publication.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
