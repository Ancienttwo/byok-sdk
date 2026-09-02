> **Archived**: 2026-08-31 15:29
> **Related Plan**: plans/archive/plan-20260831-1248-agent-session-parallel-contract-canary.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260831-1529

# Implementation Notes: agent-session-parallel-contract-canary

> **Status**: Active
> **Plan**: plans/plan-20260831-1248-agent-session-parallel-contract-canary.md
> **Contract**: tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md
> **Review**: tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md
> **Last Updated**: 2026-08-31 14:48
> **Lifecycle**: notes

## Design Decisions

- Keep one cross-process Agent-home activity marker until the final session
  exits, but multiplex distinct session execution leases beneath it.
- Rekey fresh task admission to the runtime-created `sessionRef` atomically;
  exact resume starts session-keyed and duplicate session admission fails busy.
- Once an execution lease is session-keyed, reject every attempt to bind a
  different runtime session without deleting or replacing the authoritative
  admission key.
- Serialize only SDK-reserved initialization, handoff, terminal evidence, and
  first-open shared stores; do not claim to serialize opaque Agent-owned files.
- Treat Agent-memory hosted projection as the bounded exception: serialize the
  complete close-time transaction per canonical home because independently
  opened outbox instances otherwise race one CAS revision. The publish wait is
  still bounded by its existing timeout and runtime sessions remain parallel.
- Extend the existing exact-SHA pack/install gate instead of adding a second
  artifact authority.

## Deviations From Plan Or Spec

- The independent exact-subject gate found two P1 findings. First, an exact-resume
  lease could be re-keyed when the runtime returned a different `sessionRef`,
  freeing the original admission key for duplicate execution. The reviewed
  subject therefore failed and was not merged.
- Second, parallel session close opened separate Agent-memory outbox instances.
  Their instance-local `writeTail`s did not coordinate, both loaded the same
  file revision, and the second CAS replacement failed, dropping that close's
  hosted snapshot projection.
- The repaired subject adds an immutable session-bound state, a regression that
  proves the original key remains busy after a rejected rebind, the same check
  in the installed-tarball canary, and explicit single-process wording in the
  product contract. It requires a fresh external review because its source
  content differs from the failed subject.
- The second repair adds a per-home projection transaction queue around
  open/replay/snapshot/redact/append/replay. The regression was observed red as
  one fulfilled plus one rejected projection, then green as two fulfilled
  projections with source sequences 1 and 2.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Whole-home full-turn lease | Reject | It serializes unrelated conversations for one Agent. |
| Agent id per conversation | Reject | It destroys durable Agent identity and home continuity. |
| Session execution lease plus short home gate | Adopt | It preserves exact duplicate rejection, parallelism, and relocation safety. |

## Open Questions

- Opaque Agent-owned files remain outside the SDK's short mutation gate. A
  runtime or product requiring application-level coordination inside one Agent
  home must provide that coordination without turning it into another SDK
  session authority.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Repaired focused regressions passed 28/28 across the Agent-home contract and
  Agent-memory concurrency suite. The new parallel-close guard was run red
  before the fix and failed with `['fulfilled', 'rejected']`.
- Repaired root build and typecheck passed; full test passed with client 1563
  passed / 11 skipped.
- Exact ten-tarball pack/install smoke passed from repaired source commit
  `8042cee029828451d86fddd868500c403a0bbe23`; installed
  `@byok-sdk/client@0.11.0` ran same-Agent different-session concurrency,
  duplicate-session rejection, exact-resume rebind rejection with continued
  original-key exclusion, and final-home-release checks. The client tarball
  SHA-256 was
  `bca8ae94fd7db5e43b146aca83c3fb9cc6be4b975788262056f7018c1c494567`.
- Fresh change assessment froze the ten source/contract paths as review subject
  `sha256:fe0863c72c5783bc3908bda3e3f042920b6fb89a15d71b3e037dc953f12ca755`
  against `main@7a937e5ed8eb5aef102eacb0df9183f296da7e1f`.
- The first root full-test attempt hit an unrelated Wrangler packaging timeout
  at five seconds. The exact test immediately passed 6/6 and the one allowed
  full-suite rerun passed without changing that out-of-scope surface.
- `repo-harness run check-task-workflow --strict` passed after the artifact
  gate. No package was published and no downstream or production state changed.
- The first isolated-worktree test attempt failed before workspace build
  because internal package `dist` entries did not exist; the prescribed
  build-first sequence resolved it without a code change.

## External Review Disposition

- Both P1 findings are confirmed and remediated: exact-resume re-key freed the
  authoritative admission key, and parallel close raced independently opened
  Agent-memory outboxes. The old exact subject remains a failed review subject.
- Sibling sweep: AgentMemory has no second production open path; reliable spool
  uses controller single-flight plus its internal queue, and message outbox is
  shared per home by TaskRunner. No third instance-local queue race was found.
- P2 resolved by source inspection: message-outbox operations do not retain
  open file handles; the observed TaskRunner finish path records terminal
  evidence before releasing the execution lease.
- P2 corrected in contract: same-Agent session multiplexing is within one
  daemon process; another daemon remains excluded by the home marker.
- P2 retained as review risk: host projection callbacks currently run under a
  non-reentrant per-home gate, so re-entry or a slow callback can block sibling
  session admission/mutation. This was not the external P1 and is not silently
  expanded into a second design change before re-review.
- With explicit user approval, the frozen repaired subject was sent once to the
  read-only `claude-review` flow. `fable` and the sole `opus` fallback produced
  no stdout; transcript recovery was empty. Claude Code emitted only a local
  unrecognized-model/config warning. The advisory outcome is `SKIPPED`, not a
  pass or fail, and no third attempt or narrowed diff was performed.
- The user then explicitly chose to skip the unavailable external verdict.
  The contract-permitted `user_waiver` was materialized for owner `kito`, and
  the typed AcceptanceReceipt binds the repaired subject
  `sha256:fe0863c72c5783bc3908bda3e3f042920b6fb89a15d71b3e037dc953f12ca755`
  to `main@7a937e5ed8eb5aef102eacb0df9183f296da7e1f`. This acceptance does not
  authorize local merge, push, publish, downstream upgrade, or production
  unpause.
- `repo-harness run verify-sprint --prepare-acceptance` passed 19/19, the
  receipt verified as `User / user-waiver / user_waiver`, and the final
  `repo-harness run verify-sprint` finalized acceptance without rerunning the
  frozen verification evidence.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
