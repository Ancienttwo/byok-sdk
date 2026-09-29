# Implementation Notes: toolless-prepared-lane

> **Status**: Active
> **Plan**: plans/plan-20260929-1735-toolless-prepared-lane.md
> **Contract**: tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md
> **Review**: tasks/reviews/20260929-1735-toolless-prepared-lane.review.md
> **Last Updated**: 2026-09-29T17:50:00+0800
> **Lifecycle**: notes

## Design Decisions

- The launch attestation stays bound for a tool-less record; G3 (`preparation_launch_attestation_mismatch` for launcher-wrapped claude/codex) is unchanged.
- The offer omits `requiredToolsets`; `RequiredToolsetsSchema` (`.min(1)`) is not relaxed.
- G6: admission builds `toolsetDefinitionRevisions` from the toolsets the record names (the list the producer uses), not every configured toolset.

## Pre-fix evidence (unfixed code, base ede2db31)

Command (in `packages/client`): `npx vitest run src/__tests__/prepared-offer-lane.test.ts -t "<title>"`

- Tool-less repro (`toollessRecord()`, offer omits `requiredToolsets`): 1 failed | 57 skipped.
  `preparation_launch_attestation_mismatch: this task proved no trusted MCP launch boundary, and a preparation is counted under one` (G2 is the first gate).
- G6 regression (`binds only the toolsets the record names ...`, registry {team, unrelated}, record names team): 1 failed | 58 skipped.
  `preparation_tool_binding_digest_mismatch: the launch directory, toolset definition revisions, server argv or implementation identities this task resolved are not the ones the named preparation bound`. G6 reproduces and is a bug, not intended behavior.

## Post-fix evidence

- Registry probe on official Pi 0.87.1 (temporary write in `prepared-session.ts`, run through the real host child process, removed afterwards): tool-bearing path `getActiveToolNames()` = `getAllTools()` names = `["mcp__teamserver__echo","mcp__teamserver__find_leads"]`; tool-less path both `[]`. `createAgentSession({ tools: [] })` therefore means no tools (`allowedToolNames` is an empty set, not `undefined`), and `getAllTools()` does not list non-active built-ins here, so the set-equality hardening does not false-positive.
- Mutation check: with the five source files reverted to base and every new test kept, 25 tests fail (G1, G2, G4, G5, G6 and the hardening); with the fix all pass. Negative controls (N1, N2, N3, N6, N8, N11) pass on both, by design.
- `getActiveToolNames()` on the tool-less real-host path is `[]` and the first provider body equals D with no `tools` key (`pi-prepared-launcher.test.ts`, "launches a tool-less record with zero tools").
- Gates beyond the six: none found. The real host, `PiAdapter.prepare`, the producer and replay (`resolvePreparedToolBinding`, `input-preparation-service`), `buildToolExecutorsFromObservation` and `createPreparedPiSession` all accepted the empty surface unchanged. One pre-existing behavior is now visible and kept: an offer naming a toolset that the lane registry has no revision for declines `preparation_tool_surface_unfingerprintable`.

## Verification (this turn, worktree, base ede2db31 plus the change)

- `bun run build`: exit 0.
- `bun run typecheck`: exit 0 (one type error in the new launcher test helper found and fixed on the first run).
- `bun run test`: first run failed one test, `official-pi-workflow.test.ts`, "Bun is required for the vendored TS workflow probe": `resolveBunBin` scans `BYOK_TEST_BUN_BIN` and four fixed paths and does not include `~/.bun/bin/bun`, which is where Bun lives on this machine. That is an environment precondition raised before any repo code runs. With `BYOK_TEST_BUN_BIN=$(which bun)` the whole suite passes: client 266 files / 3411 tests passed (27 skipped), cloud 452, cloud-dataplane 73, conformance 161, core 373, keys 620, protocol 497, server 373, implementation-identity 115, others green.
- `bun run check:api-surface`: 9 package goldens match; `git diff -- api-surface` empty.
- `bun run check:version-authority`: OK (0.24.0-rc.1 / keys 0.8.1-rc.1).
- `bun run test:scripts`: 51 pass, 0 fail.
- `node scripts/release/check-package-graph.mjs`: OK.
- `repo-harness run check-task-workflow --strict`: OK.

## Deviations From Plan Or Spec

- None recorded. The protocol test title fix at `packages/protocol/src/__tests__/input-preparation.test.ts:197` (pre-existing in the worktree) ships in the code commit.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
