> **Archived**: 2026-08-10 15:36
> **Related Plan**: plans/archive/plan-20260810-1514-adr-025-device-agent-identity.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260810-1536

# Implementation Notes: adr-025-device-agent-identity

> **Status**: Active
> **Plan**: plans/plan-20260810-1514-adr-025-device-agent-identity.md
> **Contract**: tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md
> **Review**: tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md
> **Last Updated**: 2026-08-10 15:16
> **Lifecycle**: notes

## Design Decisions

- `Device` remains the paired execution-host/device-key/presence authority.
  Persistent `Agent` identity is a separate future resource; it is not a
  runtime entry, task, session, or workspace.
- `AgentPlacement(agentId, deviceId, generation, lease)` is the only future
  assignment authority. `AgentObservation` is explicitly non-authoritative and
  stale lifecycle commands fail closed.
- Protocol v1 and the current AiphaBee Local Agent CLI device/task path remain
  unchanged. The ADR authorizes no code or fleet feature.

## Deviations From Plan Or Spec

- The preceding client-adapter contract was not merged from its local branch:
  current `origin/main` already contains the superior published/verified
  `v0.1.1` implementation. Continuing the old-base commit would have regressed
  package versions, release checks, and CI wording. ADR-025 therefore starts
  from clean `origin/main@9d02167`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reuse runtime/task identity | Rejected | Capability and execution-attempt state cannot own persistent Agent lifecycle. |
| Copy RAFT multi-server attachments | Rejected | No AiphaBee requirement justifies credential/control-plane fan-out. |
| Separate Agent + fenced placement | Accepted | Preserves current CLI while freezing the minimum split-brain-safe authority boundary. |

## Open Questions

- Implementation remains intentionally untriggered. A future fleet slice must
  first name a concrete host workflow, capacity model, and acceptance cases.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- BYOK Device identity: `packages/server/src/auth.ts:121-166`.
- BYOK dispatch trace: `packages/server/src/hub.ts:1452-1494` and
  `packages/server/src/hub.ts:1655-1659`.
- Runtime discovery contract: `packages/protocol/src/messages.ts:17-74`.
- RAFT bounded reference: `docs/researches/raft-architecture-reference.md` and
  the reverse-skill case report under
  `/Users/ancienttwo/.local/share/reverse-skill/work/20260810-raft-multi-computer-agents/report/`.
- Contract verification: 8/8 passed; no Mermaid fence was added or changed, so
  diagram rendering was not an applicable delta gate.
- Exact-subject acceptance: user-waiver receipt binds ADR-only subject
  `sha256:672c05ca02c825ed111cd96115b07a30b0a6b86974f2f071953c7295e1c9d09c`
  to `main@9d02167335d4b4434632b05acc79028f67fd6fe0`; reviewed paths are exactly
  the ADR, canonical architecture, and research index.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
