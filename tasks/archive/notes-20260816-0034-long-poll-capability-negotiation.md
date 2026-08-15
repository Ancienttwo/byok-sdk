> **Archived**: 2026-08-16 00:34
> **Related Plan**: plans/archive/plan-20260815-1532-long-poll-capability-negotiation.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260816-0034

# Implementation Notes: long-poll-capability-negotiation

## Root Cause

`ConnectionManager.serverCapabilities` was sourced exclusively from WS `conn.ack`; long-poll cleared that state but had no transport-native advertisement. Pure cloud/long-poll deployments therefore always failed the `result-document` gate despite persisting the field correctly inbound.

## Pre-fix Evidence

Two focused regressions were observed red: the client long-poll-only case
received `[]` instead of `['approval_resolved']`, and the Bun-compatible
protocol guard stripped the new response field before the schema addition.

> **Status**: Active
> **Plan**: plans/plan-20260815-1532-long-poll-capability-negotiation.md
> **Contract**: tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md
> **Review**: tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md
> **Last Updated**: 2026-08-15 15:33
> **Lifecycle**: notes

## Design Decisions

- `EventsPollResponse.capabilities` is optional and untyped `string[]`, matching
  WS forward compatibility. Missing means `[]`; malformed means the poll fails
  and the prior advertisement is withdrawn.
- `@byok-sdk/cloud` owns an explicit protocol capability set containing
  `result-document`; it is not derived from hosted `CLOUD_CAPABILITIES`.
- `@byok-sdk/server` advertises the same `CAPABILITY_FLAGS` over long-poll that
  its WS `conn.ack` already advertises.
- Capability publication occurs before events from the response are delivered.
  A late long-poll response cannot overwrite a newer WS ack because the
  connection manager accepts it only while long-poll remains current.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reuse the last WS advertisement | Rejected | It makes capability authority sticky across a transport switch. |
| Derive protocol flags from hosted deployment declarations | Rejected | They are separate vocabularies with different owners. |
| Advertise capabilities in every poll response | Chosen | It gives stateless long-poll a current, fail-closed authority. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix red: `.ai/harness/runs/long-poll-capability-negotiation-pre-fix.log`
- Focused suites: protocol 27/27, client 6/6, cloud 12/12, server 8/8.
- Full suite: client 1237, cloud 149, cloud-dataplane 55, conformance 137,
  core 248, example broker 25, keys 345, protocol 262, server 243,
  testkit 4, sdk 1 passed; 56 optional cloud-dataplane tests skipped by the
  existing environment gate.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
