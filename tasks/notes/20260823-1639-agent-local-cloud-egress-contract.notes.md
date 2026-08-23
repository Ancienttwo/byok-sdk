# Implementation Notes: agent-local-cloud-egress-contract

> **Status**: Active
> **Plan**: plans/plan-20260823-1639-agent-local-cloud-egress-contract.md
> **Contract**: tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md
> **Review**: tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md
> **Last Updated**: 2026-08-23 18:24
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

- Content-read audit and idempotent Blob upload were not sufficient delivery
  evidence by themselves: after persisting the inbound cursor, a daemon could
  crash before an in-memory receipt reached cloud. The final design therefore
  stores the complete protocol-validated, content-free receipt in the existing
  Agent reliable spool with required stable `eventId`/positive `cursor`.
  Server/cloud persist the receipt before sending an exact
  `agent.egress.ack`; duplicate replay re-acks the same identity.
- Content bytes still use the existing authenticated Blob channel. No second
  content-transfer message, recursive Agent-home sync, reliable-to-latest
  fallback, or cloud transcript authority was introduced.
- Latest-value state retains at most one value per Agent. Its tenant byte quota
  does not reinterpret the reliable per-Agent event quota as a tenant-wide
  Agent-count limit; different Agents remain isolated.
- The first full typecheck found that the in-memory conformance composition did
  not project the newly required `egress` port. The port already existed in
  the cloud store authority; the fixture wiring was added and its 58-test
  composition suite passed.
- The first full test exposed an over-broad boundary: the new sanitizer was
  rewriting legacy `task.decline`/`task.fail` reasons. Sanitization is now
  restricted to active `task.offer_for_agent_with_egress` tasks; legacy tasks
  and plain Agent-home offers preserve their established wire semantics. A
  focused regression plus the previously failing legacy suites and the second
  full test pass prove the boundary.
- The first independent semantic gate rejected subject `fac1c0c` on two
  concrete gaps. Hosted long-poll cancellation filtering omitted
  `task.offer_for_agent_with_egress`, allowing an already-cancelled egress
  offer to be delivered beside `task.cancel`; `cdf1c5e` adds the new offer
  to the exact filter and proves cancel-only readback. Separately,
  per-envelope content audit stores had instance-local queues, so concurrent
  same-Agent writers could duplicate one request id; `1145c68` keys one
  writer queue by canonical Agent-home ledger path and proves exact replay,
  conflict refusal, restart readback, and cross-Agent isolation.

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
- Implementation commits: `9f559f2`, `1f36513`, `83f43f5`, `a82de7a`,
  `0b09328`, `d14ed20` (stacked on accepted Agent-home `3c47b03`).
- Focused receipt reliability evidence: protocol 121, client 8, server 3,
  cloud 18 tests passed; affected package typechecks and `git diff --check`
  passed before the final repository gate.
- Final machine evidence: `bun run build`, `bun run typecheck`, and
  `bun run test` passed at final code HEAD; client 1373, cloud 200,
  protocol 313, server 252, conformance 142 and every remaining package suite
  passed. Disposable Postgres/MinIO
  `agent-egress-contract.test.ts` passed 1/1 with
  `BYOK_REQUIRE_DATAPLANE=1`.
- `repo-harness run verify-contract ... --strict` passed 26/26 and projected
  the contract to `Fulfilled`. The disposable Docker substrate was removed
  with `down -v`; no migration was executed outside that test database.
- That 26/26 receipt and the first acceptance preparation belong to the
  rejected `fac1c0c` subject and are historical only. The replacement subject
  must regenerate machine evidence and semantic acceptance after the two gate
  fixes; no stale receipt may be reused.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
