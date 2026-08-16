> **Archived**: 2026-08-17 02:31
> **Related Plan**: plans/archive/plan-20260817-0219-registry-readback-ui-runtime.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260817-0231

# Implementation Notes: registry-readback-ui-runtime

> **Status**: Active
> **Plan**: plans/plan-20260817-0219-registry-readback-ui-runtime.md
> **Contract**: tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md
> **Review**: tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md
> **Last Updated**: 2026-08-17 02:21
> **Lifecycle**: notes

## Design Decisions

- Keep the published `0.4.2` tarballs and source SHA immutable. Correct only
  the post-publication oracle's exact namespace list.
- Retain an independent literal expectation. The focused regression test pins
  `uiRuntime`; the live frozen-manifest readback remains the end-to-end proof.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Weaken or derive the export assertion | Reject | It would reduce the independent fail-closed release oracle. |
| Repack or republish | Reject | Registry bytes already match the frozen manifest. |
| Add `uiRuntime` to the exact list | Use | It matches source, pack smoke, and the published runtime namespace. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix regression: `tasks/notes/registry-readback-ui-runtime.pre-fix.log`
- Targeted regression: `bun test tests/unit/registry-readback-ui-runtime.test.ts` — 1 pass.
- Frozen registry readback: nine packages at one `0.4.2` version set, source
  SHA `de07001c85c274ce955d1f76181de143fee2cc80`.
- Repository gates: `bun run build`, `bun run typecheck`, `bun run test`, and
  `repo-harness run check-task-workflow --strict` passed after a frozen-lockfile
  install in the isolated worktree.
- Release terminal state: annotated tag `v0.4.2` peels to published source
  `de07001c85c274ce955d1f76181de143fee2cc80`; GitHub Release is public at
  `https://github.com/Ancienttwo/byok-sdk/releases/tag/v0.4.2`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
