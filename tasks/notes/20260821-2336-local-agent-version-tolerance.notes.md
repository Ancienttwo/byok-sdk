# Implementation Notes: local-agent-version-tolerance

> **Status**: Ready for Review
> **Plan**: plans/plan-20260821-2336-local-agent-version-tolerance.md
> **Contract**: tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md
> **Review**: tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md
> **Last Updated**: 2026-08-23 19:04
> **Lifecycle**: notes

## Design Decisions

- The already-bounded `ConnHelloPayload.clientVersion` string is retained as
  the sole self-hosted release projection; no new wire shape or server-owned
  identity is introduced.
- `ConnectionState` keeps the value across the existing WS disconnect lifecycle,
  and `MachineInfo` omits the field when a legacy daemon did not send it.
- Release SemVer is never read by connection or dispatch gates. Protocol
  membership and advertised capabilities remain the behavior authorities.

## Deviations From Plan Or Spec

- A clean worktree root typecheck initially failed because dependent workspace
  package `dist` outputs did not exist. Running the repository build first
  produced those ignored artifacts; the unchanged root typecheck then passed.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Add a Latest/minimum comparison in the server | Rejected | It would turn observability into a behavior gate and violate the shipped product contract. |
| Infer a missing version from server/package metadata | Rejected | The final Local Agent distribution is the only release authority. |
| Introduce a new object schema for this projection | Rejected | The existing bounded optional wire string already carries the exact required fact. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Red proof: before the hub forwarding change, the focused integration test
  connected and ran but failed because `machines.list()` omitted expected
  `clientVersion: 0.5.0`.
- Focused server integration: 18/18 passed, including the older-release full
  task completion and legacy-unknown cases.
- Package gates: server typecheck and build passed.
- Repository gates on rebased current `main`: full build, root typecheck, full
  test suite, architecture sync, task sync, and strict workflow passed. The
  initial full test attempt used stale worktree dependencies; after
  `bun install --force --frozen-lockfile`, all five focused failures passed
  43/43 and the full client suite passed 1375/1375.
- Installed repo-harness contract verification:
  `.ai/harness/runs/20260821-2336-local-agent-version-tolerance-contract.json`
  reports 12/12 pass and records the package-owned command
  `bun run --cwd packages/server test -- src/__tests__/integration.test.ts`.
- No push, merge, publish, deploy, or production mutation had been performed
  when this verification evidence was frozen.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
