# Implementation Notes: connector-readonly-operability

> **Status**: Ready for Review
> **Plan**: plans/plan-20260821-2325-connector-readonly-operability.md
> **Contract**: tasks/contracts/20260821-2325-connector-readonly-operability.contract.md
> **Review**: tasks/reviews/20260821-2325-connector-readonly-operability.review.md
> **Last Updated**: 2026-08-21 23:50
> **Lifecycle**: notes

## Design Decisions

- `McpToolsetRegistry` is the only live configuration authority. It validates a
  complete candidate, derives deterministic registry and per-definition SHA-256
  revisions, and performs one expected-revision compare-and-swap replacement.
- Task admission reads one snapshot per offer. Existing tasks retain their
  already-sealed MCP projection; later offers use the post-reload snapshot.
- Presence heartbeats and the next `conn.hello` read logical ids from the same
  registry. Executable definitions remain device-local.
- Lifecycle state is not inferred from configuration or command availability.
  The host must report an observation tied to the current definition revision;
  otherwise status is explicitly `unobserved`.
- The CLI reads the host-owned config file and submits the complete definition
  set over the authenticated control socket. The daemon never reads an
  arbitrary caller-supplied path.

## Deviations From Plan Or Spec

- The contract worktree helper did not project ignored `.ai/harness/checks/`
  and `.ai/harness/runs/` directories. They were restored inside the allowed
  workflow scope before the strict gate was rerun.
- The first full test run had two load-sensitive failures: a control-socket test
  exceeded its timeout and the user-installed Pi runtime probe returned an empty
  version. Both exact tests passed on immediate isolated rerun, and the second
  complete `bun run test` passed without source changes.
- The first committed `prepare-acceptance` correctly selected the new registry
  and public type surface for `pattern_novelty`, then blocked because the
  contract still declared no review oracle. The existing contract-required
  deterministic suite was registered as the whole-subject oracle; no product
  behavior or test expectation changed.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Mutable counter revision | Rejected | It is not restart-stable and makes identical reloads non-idempotent. |
| Content-addressed revision | Selected | It gives deterministic CAS identity across ordering and daemon restarts. |
| Infer connector health from config or executable presence | Rejected | Neither proves a process is authorized, running, or healthy. |
| Explicit revision-bound host observation | Selected | It preserves truthful status and rejects late observations from replaced definitions. |
| Daemon reads a config path supplied over control RPC | Rejected | It broadens local file authority and complicates path validation. |
| CLI reads config and sends a complete candidate | Selected | File access remains with the invoking host and reload stays atomic. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Focused registry/control/discovery suite: 8 files, 142 tests passed.
- Final full suite: `bun run test` passed; client 126 files / 1310 tests plus
  all remaining workspace packages.
- Required static gates: `bun run build`, `bun run typecheck`, and
  `repo-harness run check-task-workflow --strict` passed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
