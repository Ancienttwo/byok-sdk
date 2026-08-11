# Implementation Notes: llm-access-provider-adapter

> **Status**: Active
> **Plan**: plans/plan-20260812-0333-llm-access-provider-adapter.md
> **Contract**: tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md
> **Review**: tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md
> **Last Updated**: 2026-08-12 03:33
> **Lifecycle**: notes

## Design Decisions

- Added strict additive `dispatchSelection` with an additive
  `dispatch-selection` connection capability. The server refuses a selection
  for an older v1 daemon before task creation, preventing unknown-field
  stripping from degrading into legacy runtime-only execution.
- Server and TaskRunner derive the runtime from the exact selection and reject
  contradictory legacy `runtime` values. Claude/Codex pin `--model`; Pi pins a
  namespaced projected provider and exact model through a separate launcher.
- The keys launcher opens the profile database read-only, resolves the key only
  for authenticated profiles, writes a private credential-blind projection,
  reconstructs Pi's environment from a closed platform/proxy baseline plus the
  exact key, and opens no listener. Deep review also changed session-directory
  setup to chmod only a directory created by this invocation; an existing
  host-owned directory is never permission-mutated.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Hermes / second transport | Reject | Pi 0.84.1 already owns provider interpretation, transport, and agent loop. |
| Shared mutable `models.json` | Reject | A private process-scoped projection avoids cross-task target races. |
| In-process key read | Reject | A no-listener launcher preserves the dispatch graph's zero credential edge. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pinned Pi positive and zero-network negative control:
  `docs/researches/pi-provider-baseurl-probe.md`
- Targeted suites before freeze: protocol 195, server 221, client 1043,
  keys 339. One pre-existing timing-sensitive long-poll test failed once in a
  full client run and passed immediately in isolated rerun; no source change
  was made for that unrelated flake.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
