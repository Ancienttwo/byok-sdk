# Implementation Notes: public-package-topology

> **Status**: Active
> **Plan**: plans/plan-20260905-0114-public-package-topology.md
> **Contract**: tasks/contracts/20260905-0114-public-package-topology.contract.md
> **Review**: tasks/reviews/20260905-0114-public-package-topology.review.md
> **Last Updated**: 2026-09-05 01:17
> **Lifecycle**: notes

## Design Decisions

- Retain `@byok-sdk/server`: it owns the independently meaningful Node/Hono self-hosted deployment composition while delegating all coordination semantics to `@byok-sdk/cloud`.
- Retire the unscoped `byok-sdk` umbrella only in a separately approved breaking-release implementation. It owns no capability and forces all seven dispatch ownership packages into one install/release edge.
- Current and target state stay distinct: today is 10 public artifacts; after the later one-shot cutover it is 9. This docs slice does not change manifests, registry state, versions, or consumers.
- No alias, empty compatibility package, dual entrypoint, or semantic fallback survives the cutover. Historical immutable registry versions are not active compatibility code.

## Deviations From Plan Or Spec

- The required read-only Claude planning session produced only an unrecognized-model catalog warning and no plan; it was terminated after two minutes and not retried. Repository evidence supplied the ruling.
- A pre-existing aggregated WP3B architecture request blocked strict architecture sync. It was archived as no-change against `docs/architecture/snapshots/2026-09-04-wp3b-longpoll-only.md`; a later request emitted from the same queued context events is closed only after all decision edits freeze.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Delete `@byok-sdk/server` | Reject | It would erase the actual Node deployment boundary or require an equivalent replacement package. |
| Keep `@byok-sdk/server` | Accept | It is a real adapter/composition consumer boundary, not a second coordination authority. |
| Keep `byok-sdk` umbrella | Reject for steady state | No unique capability or inspected product-code consumer; release and install fan-out grows with every package. |
| Retire `byok-sdk` | Accept, implementation deferred | Reduces the public topology without crossing runtime or ownership boundaries. |

## Open Questions

- Exact release version/date and external consumer migration timing belong to the later release contract; the registry consumer population is unknown.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Architecture ruling: `docs/architecture/adr-2026-09-05-public-package-topology.md`
- Current architecture: `docs/architecture/sdk-architecture.md` §1.2 and appendix ADR-035.
- Prior O1 evidence: `docs/researches/evidence/2026-09-03-architecture-review/track-opus.md:59-65`.
- Current manifest inventory: 15 workspace manifests = 10 public + private conformance + 4 private examples.
- Current import inventory: server has `examples/basic`, client integration-test, and umbrella consumers; umbrella has only docs and release-smoke consumers in this repo, and neither candidate is imported by inspected Salesko product code.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- ADR-035 is the durable decision authority; no lesson or harness asset promotion is needed.
