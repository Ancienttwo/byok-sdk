# Implementation Notes: agent-egress-fresh-session-authority

> **Status**: Active
> **Plan**: plans/plan-20260823-2300-agent-egress-fresh-session-authority.md
> **Contract**: tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md
> **Review**: tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md
> **Last Updated**: 2026-08-23 23:00
> **Lifecycle**: notes

## Design Decisions

- Salesko frozen subject `4c57675a5f62187e231e6fa6b35cb2d2583040d2`
  failed independent acceptance because it generated a random pre-dispatch
  `sessionRef`.  Published client 0.7.0 interprets every strict Agent offer
  session as exact resume evidence and calls `requireMatch` before runtime
  start; the only valid `record` happens after the runtime returns its native
  session.  Existing Pi coverage hid the gap by manually pre-seeding the SDK
  store.
- Protocol v1 forbids changing required `sessionRef` to optional.  The repair
  is the additive `task.offer_for_agent_with_egress_fresh` message plus durable
  `agent-egress-fresh-session` capability.  The old message remains exact
  resume; missing or mismatched evidence never becomes fresh execution.
- Fresh runtime session authority belongs to the adapter result.  The client
  must fsync the exact AgentRef/runtime/canonical-cwd/session handoff before
  `task.started` or reliable egress.
- `publishReliableAgentEgress` currently accepts invented session ids.  This
  slice adds runtime/task exact-match inputs and requires the canonical-home
  handoff before append/send.  Cloud receipt and ack remain delivery facts.
- No new cloud session/reservation table is justified.  Existing durable
  device capability persistence, task attempt, Agent-home lease, handoff and
  bounded spool/ack authorities are sufficient.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Make existing egress `sessionRef` optional | Reject | Required-to-optional changes frozen v1 semantics and requires protocol v2. |
| Add cloud/pre-dispatch session reservation | Reject | It creates a second lifecycle/identity authority and still cannot mint a native runtime session. |
| Add fresh-only message and capability | Use | It is additive, keeps old daemons safe, and makes fresh versus resume explicit. |

## Open Questions

- Package versions will be chosen only after source/tests close.  Because the
  public client reliable-publish input tightens under 0.x, the current
  candidate is a new aligned minor train; npm publication remains separately
  unauthorized.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
