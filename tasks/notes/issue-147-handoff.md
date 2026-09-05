# BYOK #147 — single integration-ready handoff

Status: SOURCE GATE PASS; LOCAL COMMIT ONLY. Typed merge/release acceptance remains pending.

## Exact subject

- Source commit: `fc404d7ce0599d6ab0e396af39e89a3c8b11ae0c`.
- Base: `440907ee2c44051b427d9ed4fe1431d93ffff72d` (origin/main read back unchanged at handoff).
- Branch: `codex/issue-147-task-offer-journal`.
- Worktree: `/Users/kito/Projects/byok-sdk-wt-issue-147`.
- Source/test/API fingerprint: `d74ab4420d6b970e4c3844c8ce266cf68b154fd72d2772445103875b304dcec2`; per-file hashes in `issue-147-source-evidence.json`.
- Plan/contract/review/notes: matching `20260906-0350-issue-147-task-offer-journal` artifacts.

## Result and evidence

P1: protocol owns task-offer classification, client projects it, SQLite owns rows, connection owns cursor after append/handler.
P2: the previous three-type predicate omitted two egress offers, producing no task row, unknown-task terminal errors and no recovery scan result.
P3: share protocol payload registry entries with MESSAGE_PAYLOAD_SCHEMAS and derive TASK_OFFER_TYPES/isTaskOfferType; remove the client duplicate list. No new dependency, fallback, wire shape, database schema or cursor-order change.

- Red: `issue-147-pre-fix.log`, four failures specifically for both egress variants' missing rows; PRE_FIX_EXIT=1.
- Green: protocol family2/2, client family9/9; complete five-offer row/dedup matrix; actual terminal and snapshot-based acknowledged-interrupted recovery for four executable variants including both egress types.
- Full source suite Node22.22.0 (Bun1.4.0 launcher):3660 passed/133 skipped, exit0. Existing journal-before-ack, SQLite, crash, pressure, unavailable-mode and long-poll/dedup suites included.
- build, typecheck, API surface (9 package goldens), version authority, strict workflow, diff check:PASS. Strict contract:21/21 (`issue-147-contract-check.json`). Architecture and security specialist reviews:PASS.
- Existing skips stay classified as platform/external-provider skips. New regressions do not skip. Recovery snapshot is not a process-kill or released compiled artifact claim.

## Reproduce

Use Node22.22.0 on PATH and Bun1.4.0 in the isolated worktree:

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd packages/protocol test -- src/__tests__/task-offer-family.test.ts
bun run --cwd packages/client test -- src/__tests__/journal-offer-family.test.ts
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
repo-harness run check-task-workflow --strict
```

Full contract check: `repo-harness run verify-contract --contract tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md --strict`.

## Integration and release boundary

1. Coordinate with current release train before any release action. At final readback PR149 is OPEN at `4342a237f5b97bcb2d7c70900a342bdd8ab55793`; primary worktree ownership has moved during this task. Never treat a WIP checkout or PR head as main/release truth.
2. Integrate this exact source commit in an isolated integration checkout against the frozen accepted successor. Watch `create-daemon.ts` imports/projection, `protocol/index.ts` exports and regenerate `api-surface/protocol.d.ts` from the combined source. Other branches/worktrees, provider catalog and runtime spill WIP were not changed here.
3. Obtain contract-required typed Claude AcceptanceReceipt for the actual integrated subject; no receipt or waiver is fabricated by these source reviews. Run affected source gates on that integration subject before merge. This handoff does not authorize merge/push/publication.
4. No version bump, push, merge, release upload, registry publish, tag or deployment occurred. GitHub latest release was v0.13.0; tag ref readback `04bee83baa04e00e054fc90a7db4a622ae819137` is a tag-ref identity, not assumed source commit. #147 remains OPEN. No new registry artifact exists for this fix.
5. Only after a separately coordinated actual release: downstream exact-pin is a new slice. Salesko then reruns the acknowledged-interrupted row with a positive recovery_marker assertion; other WP1 PARTIAL/external gates remain. WP3 remains deferred. Cloud settlement, doctor and Salesko workaround are out of scope.

Next bounded slice: integrate the frozen #147 commit with the accepted release-train subject and obtain its typed acceptance; sufficient to turn the source-ready candidate into a mergeable release input without starting downstream work.
