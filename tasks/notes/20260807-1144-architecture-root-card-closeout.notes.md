# Implementation Notes: architecture-root-card-closeout

> **Status**: Active
> **Plan**: plans/plan-20260807-1144-architecture-root-card-closeout.md
> **Contract**: tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md
> **Review**: tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md
> **Last Updated**: 2026-08-07 12:05
> **Lifecycle**: notes

## Design Decisions

### Legal closed status value: `Resolved`

Read from the installed repo-harness helper source, not guessed:

- `scripts/archive-architecture-request.sh:137-155` — `canonical_status()` is the only place that mints closed status strings. It accepts `resolved | superseded | rejected | no-change` and emits exactly `Resolved`, `Superseded`, `Rejected`, `No architecture change`.
- `scripts/architecture-queue.sh:370` (`pending_request_files`) and `:620` (`triage_command`) — the queue treats a card as pending only when `Status` is literally `Pending`; any other value drains it.
- `scripts/architecture-event.ts:300-305` — `isPendingRequest()` does the same test case-insensitively for index reindexing and contract-block rendering.

`Resolved` is the correct member of that set here: the drift was real and the boundary is recorded, as opposed to `Superseded` (merged into another card), `Rejected` (not a real change), or `No architecture change`.

### Closure by in-place edit, not by `archive-architecture-request`

The archive helper is the usual closure path, but it deletes the live card and moves it under `docs/architecture/requests/archive/<year>/` (`scripts/archive-architecture-request.sh:373-374`). This contract's `exit_criteria.files_exist` requires `docs/architecture/requests/root.md` to keep existing, so the card was closed in place with the same canonical status value the helper would have written.

### Card changes

`docs/architecture/requests/root.md`:

- `Status`: `Pending` -> `Resolved`.
- `Updated`: `2026-08-05T17:38:39+0800` -> `2026-08-07T12:00:00+0800`.
- New `## Adjudication (2026-08-07)` section: drift = the K0 creation of `packages/keys/package.json` and `packages/keys/tsconfig.json` (commit `a3ab9a9`); boundary already recorded by canonical `docs/architecture/sdk-architecture.md` §7 and re-verified by the 2026-08-07 v1/v2 architecture slices; provenance of the `Resolved` value; links to the ruling snapshot, plan, and contract.
- New `### Required Follow-up Disposition` table: every original follow-up item marked `done` or `not applicable`. The Mermaid and human-diagram items are `not applicable` — canonical §7 already carries the architecture diagram, so no new visual was drawn.

### Snapshot

`docs/architecture/snapshots/20260807-1200-root-card-ruling.md` — the directory's first artifact. Thin by design: it records only the event, the ruling, the pointer to canonical §7, and the slice artifacts. It does not restate §7, which stays the single source of truth for the boundary.

Filename carries the `root` block slug because `findLatestMatchingFile()` (`scripts/architecture-event.ts:653-658`) and the shell fallback (`scripts/context-contract-sync.sh:446-447`) both select the latest snapshot by substring match on the block slug plus lexical sort.

### `context-contract-sync sync-latest` wrote nothing

Output: `[ContextContractSync] Root scope or missing functional block; no local AGENTS/CLAUDE contract updated.` (exit 0). This is designed behavior, not a failure: `validate_block` rejects the root scope, and the last event in `.ai/harness/architecture/events.jsonl` has `functional_block: root`, so there is no functional-block `AGENTS.md` / `CLAUDE.md` to carry a snapshot link. `git status` after the run confirmed zero writes, so nothing landed outside Allowed Paths.

`repo-harness run architecture-queue reindex` was then run to keep the index honest — it rewrote the controlled Pending Requests block in `docs/architecture/index.md` to `- (none)`. Without it, `check-architecture-sync` would have reported a stale index (`scripts/check-architecture-sync.sh:250-251`).

## Verification

| Command | Result |
|---------|--------|
| `repo-harness run architecture-queue status` | `[ArchitectureQueue] pending=0 gate_mode=advisory gate_min_severity=medium blocking=0` (exit 0) |
| `repo-harness run check-architecture-sync` | `[ArchitectureSync] mode=advisory gate_min_severity=medium changed_capabilities=1 blocking=0` (exit 0), no pending-request warning |
| `repo-harness run check-task-workflow --strict` | `[workflow] OK` (exit 0) |

## Deviations From Plan Or Spec

- `repo-harness run architecture-queue reindex` was run in addition to the planned commands. It is required after any status edit and writes only `docs/architecture/index.md`, inside Allowed Paths.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Close via `archive-architecture-request --status resolved` | Rejected | Deletes the live card, breaking this contract's `files_exist` exit criterion |
| Use `No architecture change` | Rejected | The drift was a real boundary change; only its documentation was already complete |
| Restate §7 inside the snapshot | Rejected | Contract taste constraint: the snapshot links canonical §7, it must not duplicate it |
| Update `docs/architecture/index.md` `## Current Snapshot` lines by hand | Deferred | No harness script maintains those lines (created once by `ensure-task-workflow.sh:987-1015`, then never rewritten); editing them is outside this slice's stated scope |

## Open Questions

- `docs/architecture/index.md` `## Current Snapshot` still reads `(none yet)` although a snapshot now exists. No repo-harness command owns those lines for root scope; only functional-block contract files receive live snapshot links. Left untouched and flagged rather than hand-patched.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
