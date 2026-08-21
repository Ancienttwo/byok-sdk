# Implementation Notes: macos-keychain-path

> **Status**: Active
> **Plan**: `plans/plan-20260822-0415-macos-keychain-path.md`
> **Contract**: `tasks/contracts/20260822-0415-macos-keychain-path.contract.md`
> **Review**: `tasks/reviews/20260822-0415-macos-keychain-path.review.md`
> **Last Updated**: 2026-08-22 04:15 +0800

## Root Cause Evidence

- Isolated launcher HOME has no user default keychain, so the current implicit
  `security` lookup reports the configured provider secret absent.
- The same service/account item metadata is found when the known login keychain
  file is passed explicitly. The proof did not request or print the secret.
- Forwarding the parent HOME is rejected because the Pi child environment
  deliberately carries ambient HOME; it would collapse the isolation boundary.

## Design Decisions

- One optional `macosKeychainPath` is projected unchanged through client ->
  launcher -> store.
- The selected path is one authority. There is no second lookup and no fallback.
- Availability probes the selected keychain itself; all CRUD calls bind the same
  path. `set` stays in `security -i` mode so encoded credential bytes remain out
  of argv and process listings.
- Supplying this macOS-only field on a non-darwin launcher is a configuration
  failure, not an ignored value.

## Verification

- Pre-fix regression artifact: 9 focused failures and `PRE_FIX_EXIT=1` in
  `tasks/notes/artifacts/20260822-0415-macos-keychain-path-pre-fix.txt`.
- Focused integration after the public-constructor gate repair: 4 files, 78
  tests passed.
- `bun run build` — pass.
- `bun run typecheck` — pass.
- `bun run test` — pass; package totals include client 1310, keys 373, and all
  remaining executed package suites green (cloud-dataplane opt-in suites remain skipped by their existing profile).
- `repo-harness run check-task-workflow --strict` — pass after creating this
  isolated worktree's ignored `.ai/harness/runs` and `.ai/harness/checks`
  runtime directories; no tracked harness authority was copied.
- `node scripts/release/check-package-graph.mjs` — pass at dispatch `0.6.1`,
  keys `0.2.2`.
- Acceptance round 1 found that direct public `new PiAdapter()` callers could
  bypass daemon-owned validation. Validation now has one authority in
  `pi-adapter.ts`; both the constructor and daemon composition call it, and a
  direct-constructor regression rejects malformed paths and reserved-flag
  injection before prepare/spawn.
- A non-canonical concurrent build+typecheck experiment briefly observed
  `dist` while the build was cleaning it. The required sequential post-build
  `bun run typecheck` passed; no source repair was made for that harness race.
- Pending: frozen clean-commit `pack-and-smoke`, publish and registry readback.
- Acceptance round 2 — PASS; prior public-constructor bypass confirmed closed.

## Release

- Current registry baseline verified before edits: aligned dispatch train
  `0.6.0`, `@byok-sdk/keys@0.2.1`, GitHub Release `v0.6.0`.
- Intended patch: aligned dispatch train `0.6.1`, keys `0.2.2`.
