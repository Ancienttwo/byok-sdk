> **Archived**: 2026-09-15 04:38
> **Related Plan**: plans/archive/plan-20260813-2350-device-toolset-discovery.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260915-0438
> **Archive Projection V1**: `plans/plan-20260813-2350-device-toolset-discovery.md` => `plans/archive/plan-20260813-2350-device-toolset-discovery.md`
> **Archive Projection V1**: `tasks/notes/20260813-2350-device-toolset-discovery.notes.md` => `tasks/archive/notes-20260915-0438-device-toolset-discovery.md`
> **Archive Projection V1**: `tasks/contracts/20260813-2350-device-toolset-discovery.contract.md` => `tasks/archive/contract-20260915-0438-device-toolset-discovery.md`
> **Archive Projection V1**: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md` => `tasks/archive/review-20260915-0438-device-toolset-discovery.md`

# Implementation Notes: device-toolset-discovery

> **Status**: Complete
> **Plan**: plans/archive/plan-20260813-2350-device-toolset-discovery.md
> **Contract**: tasks/archive/contract-20260915-0438-device-toolset-discovery.md
> **Review**: tasks/archive/review-20260915-0438-device-toolset-discovery.md
> **Last Updated**: 2026-08-14 00:05
> **Lifecycle**: notes

## Design Decisions

- `ConfiguredToolsetsSchema` is the protocol authority for the device inventory:
  at most 64 unique validated logical IDs. The daemon derives one sorted,
  frozen snapshot from the already validated local MCP registry and reuses it
  for WS hello and hosted presence.
- `undefined` is legacy/unknown while `[]` is known-none. No runtime capability
  is used to infer an inventory.
- Hosted presence is discovery-only and TTL-bounded. Embedded dispatch and the
  daemon's task-scoped toolset resolution both remain fail-closed execution
  gates.
- Postgres stores only the JSON array of logical IDs. A constraint test pins
  the SQL maximum to `CONFIGURED_TOOLSETS_MAX_ITEMS` so the duplicated database
  representation cannot drift silently.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Add a hosted handshake store | Rejected | Hosted long-poll has no `conn.hello`; adding a second durable capability authority would duplicate live presence and still become stale. |
| Publish logical IDs in presence | Chosen | It is the existing authenticated, TTL-bounded device discovery path; local task acceptance remains authoritative. |
| Publish executable MCP definitions | Rejected | Commands, args, env, headers, and credentials are host custody and must not cross the SaaS wire. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted server toolset dispatch: 5 tests passed.
- Targeted cloud-dataplane constraints: 23 tests passed.
- `pnpm -r run typecheck`: passed for 13 workspace projects.
- `pnpm -r run test`: passed; Postgres substrate suites remained explicitly
  skipped where `BYOK_TEST_POSTGRES_URL` was not configured.
- `pnpm -r run build`: passed; cloud-dataplane projected 6 migrations.
- `repo-harness run check-task-workflow --strict`: exited successfully.
- `repo-harness run verify-contract --contract tasks/archive/contract-20260915-0438-device-toolset-discovery.md --strict`: passed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
