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

- None recorded.

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

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
