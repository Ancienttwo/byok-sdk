# Implementation Notes: sdk-architecture-consolidation

> **Status**: Active
> **Plan**: plans/plan-20260807-0145-sdk-architecture-consolidation.md
> **Contract**: tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md
> **Review**: tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md
> **Last Updated**: 2026-08-07 01:45
> **Lifecycle**: notes

## Design Decisions

- **Fold before delete.** The readback file carried two things: corrected scale values and the counting convention that makes them recomputable. Only the values were strictly required, but moving the convention and the `find` + `wc -l` commands too is what lets the table stay auditable after the readback file is gone. A number without its recompute command drifts silently; a number with one gets caught.
- **Recomputed all four package rows, not just the two flagged as stale.** The task named `server` and `client` as drifted. Verifying only those would have accepted `protocol` and `keys` on the readback's authority alone. All four were recomputed from the live tree; all four matched, which also confirms the counting convention as written actually reproduces the table.
- **`packages/**` excluded from `allowed_paths` rather than merely promised.** The "docs-only" claim is enforced by the scope gate itself plus a `git status --porcelain -- packages/` assertion in `commands_succeed`, so a stray code edit fails the contract instead of passing on good intentions.
- **`docs/researches/raft-architecture-reference.md` committed unmodified.** It was untracked. Steps 2's repointed links would otherwise resolve to a file absent from version control. Its body — including the §16.2 the user corrected this round — is entered as-is; this slice does not touch its content.

## Deviations From Plan Or Spec

- **`git mv` failed; used plain `mv`.** `sdk-architecture-codex.md` was untracked, so `git mv` refused (`fatal: not under version control`). Plain `mv` between two paths both listed in `allowed_paths` achieves the same end state. Not a guard bypass — the scope gate covers Bash on the same allowed-path set.
- **The contract's Falsifier was corrected mid-slice.** It originally specified a repo-wide `rg` sweep. That sweep can never pass: a contract must name the files it deletes, so its own Why/Goal/Scope prose and `files_not_exist` list self-match, as does `tasks/current.md` (a harness-projected `git status` snapshot, not a reference). Narrowed to `docs/`, which is the surface where a dangling link would actually harm a reader. The reasoning is recorded in the contract's Falsifier section so the narrowing does not read as weakening the gate.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Widen the fulfilled K3 contract's `allowed_paths` | Rejected | Retro-editing a `Fulfilled` contract destroys the record of what it authorized and makes the scope gate meaningless |
| Keep both docs, mark the old one superseded | Rejected | A superseded marker is a compatibility path; the repo rule is one source of truth |
| Delete the scaffolding first, consolidate after | Rejected | Strands the corrected values and breaks the RAFT link mid-slice |
| Repo-wide falsifier grep | Rejected | Self-matching; unfalsifiable in practice. Scoped to `docs/` |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Mermaid render: 19/19 fences extracted from `docs/architecture/sdk-architecture.md` rendered clean under `npx @mermaid-js/mermaid-cli`; temp artifacts removed.
- Scale recompute: all four package rows reproduced from `packages/*/src` — `protocol 11/1,372 + 9/2,149`, `server 16/4,409 + 24/5,494`, `client 68/17,535 + 90/20,070`, `keys 18/2,697 + 15/2,934`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Candidate for `tasks/lessons.md`: a contract's falsifier grep must be scoped away from the contract's own text. Contracts necessarily name the files they retire, so any repo-wide pattern sweep built from those filenames is self-matching and can never pass. Meets the filter: it is surprising without local context, a real trade-off existed (scope narrowly and risk missing a reference vs. sweep widely and never pass), and the failure mode only surfaces at verify time. Holding here rather than promoting until it recurs a second time.
