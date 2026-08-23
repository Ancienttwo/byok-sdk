# Implementation Notes: agent-local-cloud-egress-contract

> **Status**: Active
> **Plan**: plans/plan-20260823-1639-agent-local-cloud-egress-contract.md
> **Contract**: tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md
> **Review**: tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md
> **Last Updated**: 2026-08-23 16:42
> **Lifecycle**: notes

## Design Decisions

- One consumed `AgentEgressPolicy` is the public authority. Metadata/status is
  the default; contentful trajectory is explicit opt-in and capability-gated.
- Reliable and latest-value lanes use distinct types and stores. The accepted
  inbound task journal is not reused as outbound delivery authority.
- Every outbound lane calls one SDK-owned projection/sanitizer before envelope
  construction. Sanitizer failure produces denial/drop evidence and no
  original wire bytes.
- Workspace, transcript and artifact reads are separate capabilities and
  request types. Agent-home containment alone never authorizes upload.
- This follow-on is locally stacked on accepted Agent-home HEAD `3c47b03`.
  Verification/publication must remain explicit about that dependency until
  the parent is integrated; no main merge is implied by implementation.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| One mode-switching queue | Rejected | It permits silent reliable/lossy semantic fallback. |
| Reuse inbound journal | Rejected | Inbound execution truth and outbound delivery have different cursors and retirement rules. |
| Distinct lanes and stores | Selected | Makes retry, ack, quota and drop behavior independently testable. |

## Parallel Ownership

- Protocol/cloud worker: `packages/protocol/src/`, `packages/server/src/`,
  `packages/cloud/src/`, `packages/cloud-dataplane/src/`, `deploy/sql/` and
  their focused tests. It does not edit client files.
- Client egress worker: existing client execution/transport files plus new
  `agent-egress-*` modules and policy/spool tests. It does not edit content-read
  modules or non-client packages.
- Content-read worker: new `agent-content-read*` and
  `agent-content-audit*` modules/tests only. Integration into shared client
  entrypoints happens later under the parent agent to keep writer scopes
  disjoint.

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
