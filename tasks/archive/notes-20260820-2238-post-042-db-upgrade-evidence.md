> **Archived**: 2026-08-20 22:38
> **Related Plan**: plans/archive/plan-20260820-2055-post-042-db-upgrade-evidence.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260820-2238

# Implementation Notes: post-042-db-upgrade-evidence

> **Status**: Complete
> **Plan**: plans/plan-20260820-2055-post-042-db-upgrade-evidence.md
> **Contract**: tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md
> **Review**: tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md
> **Last Updated**: 2026-08-20 21:26
> **Lifecycle**: notes

## Design Decisions

- Preserve the empty-database tarball smoke on the deployment-default `public`
  schema and add one isolated `v0.4.2` upgrade schema; both consume the same
  exact installed candidate tarballs and the same migration runner.
- Read published migration bytes (`0001`-`0007`) directly from tag `v0.4.2`
  during every smoke run and require their SHA-256 values to match the frozen
  fixture before constructing the baseline database.
- Seed device stream, mailbox, task, truth, entitlement, and usage rows before
  candidate migration, then compare all of them after migration.
- Exercise the installed tarball's `PostgresDeviceAssertionReplayAuthority`
  with 64 concurrent consumes; exactly one must win.
- Set the aligned dispatch train to `0.5.0`; keep `@byok-sdk/keys` independent
  at `0.2.0`.

## Deviations From Plan Or Spec

- `repo-harness` promoted the slice from lite to strict because
  `scripts/release/` is a protected surface; implementation moved to linked
  worktree `/Users/kito/Projects/byok-sdk-wt-post-042-db-upgrade-evidence`.
- No production database readback was attempted; this remains an operator-owned
  release preflight rather than A2 evidence.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Database dump fixture | Rejected | It would become a second schema/data authority and hide which migration produced the shape. |
| Separate compatibility migrator | Rejected | The shipped forward-only runner must own both empty and prior-version paths. |
| Default schema plus one isolated upgrade schema | Selected | Exercises the real deployment-default path while keeping the seeded prior-version path isolated. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Exact packed candidate commit: `3e06eee76a1ab332219235a68cc23af83c96c0fa`
- Release pack: nine aligned `0.5.0` tarballs; installed graph closed to one
  version set; cloud-dataplane tarball SHA-256
  `30ffff6b69ebbe23f5338d68e9eeac9508300c6d180ab2b269a62e6d1a87d7dc`.
- Postgres smoke: the default `public` schema applied all eight migrations;
  tag-bound seeded `v0.4.2` schema retained stream/mailbox/task/truth/quota
  rows, applied only `0008_device_assertion_replay.sql`, admitted exactly one
  of 64 concurrent installed-package replay consumes, and produced a no-op
  final migration run.
- Fresh-database diagnostic: rerunning against the same database exited `1`
  with `DATABASE_URL must have no public tables and no byok_upgrade_v042 schema`.
- Required checks on candidate commit: `bun run build`, `bun run typecheck`,
  `bun run test`, `repo-harness run check-task-workflow --strict`,
  `bun run check:release-graph`, and `git diff --check` all passed.
- Advisory tooling: Codex Waza skills and CodeGraph ready; Claude host skill
  copies report staging drift and the external skills CLI timed out.

## Independent Review Remediation

- The first Claude disposition was `reject`: one P1 authority-state finding and
  five P2 evidence findings were recorded in the typed AcceptanceReceipt.
- The P2 evidence findings are addressed by the tag-bound baseline, expanded
  seed readback, installed-package concurrency, explicit rerun diagnostic, and
  default-schema path above.
- The old receipt remains rejected and must not be reused. A fresh independent
  disposition is required against the remediated subject before integration.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
