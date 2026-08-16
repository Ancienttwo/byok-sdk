> **Archived**: 2026-08-16 19:58
> **Related Plan**: plans/archive/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260816-1958

# Implementation Notes: live-activity-timeline-pr1-tool-correlation

> **Status**: Complete
> **Plan**: plans/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
> **Contract**: tasks/contracts/20260816-1550-live-activity-timeline-pr1-tool-correlation.contract.md
> **Review**: tasks/reviews/20260816-1550-live-activity-timeline-pr1-tool-correlation.review.md
> **Last Updated**: 2026-08-16 16:20
> **Lifecycle**: notes

## Design Decisions

- `toolCallId` remains additive/optional on the v1 wire for N/N-1 and custom adapter compatibility, but when present it must contain a non-whitespace character.
- Bundled adapters treat provider-native required identity as authority: missing or malformed IDs fail closed with `RuntimeExecutionFailure`; no FIFO, tool-name, timing, or output heuristic is allowed.
- Claude and Pi project native outcome; Codex leaves outcome unknown because this slice found no equivalent first-class authority.
- Pi's pinned `0.84.1` installed RPC serializer is exercised by a subprocess JSONL probe, not only by copied fixtures or type declarations.

## Deviations From Plan Or Spec

- `$check` found two blocking omissions in the first candidate: Pi accepted a missing/non-boolean `isError`, and the wire accepted empty/whitespace `toolCallId`. Both were corrected before the frozen PASS review.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Synthesize missing identity/outcome | Rejected | Violates the provider authority and no-semantic-fallback boundary. |
| Keep Pi missing `isError` as unknown | Rejected | Pinned `0.84.1` declares the end-frame outcome as required native authority. |
| Normalize whitespace IDs | Rejected | Validation rejects malformed identity instead of changing provider semantics. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Final contract verification: `repo-harness run verify-contract --contract tasks/contracts/20260816-1550-live-activity-timeline-pr1-tool-correlation.contract.md --strict` → 18/18 PASS, `Fulfilled`.
- Focused post-fix verification: protocol/freeze/Pi/probe set → 82/82 PASS; installed Pi `0.84.1` packaging probe → 1/1 PASS.
- Independent Waza `$check`: frozen subject `sha256:822e1153ba84cd7346ad8cbf1ea8678e1ed3533c8e528b9b23159390817438a7` → PASS, no remaining product finding.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
