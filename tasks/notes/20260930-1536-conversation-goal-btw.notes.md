# Implementation notes: Host goal / btw reference

Base ede2db31. Isolated worktree `/Users/chris/Projects/byok-sdk-goal-btw`, branch `codex/conversation-goal-btw`. Implementation owner Codex; independent reviewer/acceptance Claude w9:p1 explicitly selected by user.

## P1/P2/P3 and decision

Host SQLite records own objective, maxSteps/deadline, immutable reserved input, IDs, side destination and revision CAS. SDK public client/server own admission, authenticated device transport, canonical homes, cancellation and terminal receipts. Goal steps and btw use fresh result-document offers, not user message egress; no SDK public controller or Conversation store is added. Default home cap stays one. A distinct readonly agentId permits side work; a changed profileRevision does not.

Flow: atomic Host reserve -> durable sending intent -> exact public SDK offer/attempt readback or same-ID submission -> real daemon home admission -> stub native session -> device terminal -> cancellation-prioritized exact task read -> strict result/Host semantic acceptance -> Host state CAS. No background timer, per-step limit, token budget, steering, native follow-up, auto new task on failure or invented release receipt.

## Corrections from Claude

- Ordinary native in-Run goal is not inherently a second terminal authority. This portable first slice uses Host orchestration rather than default TUI installation.
- Fresh embedded dispatch does not expose/forward limits; per-step maxDurationMs was withdrawn. Goal deadline plus Host tick is the only wall-clock bound.
- Decline retains failed Attempt and a device terminal. It is blocked, not inferred from missing Attempt; real default-home tests verify zero adapter start.
- Pausing forbids further admission but preserves a completed/blocked verdict; continue/wait remain paused.
- Host cancellation in the sending-before-offer window is persisted; sender/recovery replays exact-task cancellation after admission. It does not promise zero possible native startup during the distributed in-flight race.
- Results are model claims. acceptGoalResult must be an idempotent product-specific evidence check. Native provider and semantic goal-quality acceptance are not established by the stub.

## Verification milestones

- Frozen dependency install passed; bun.lock changed only the basic workspace's client workspace dependency and existing vitest declaration. No package resolution/pin changes.
- Baseline root build/typecheck and 15 existing home/fresh-session tests passed before example code.
- First new example run: 21/22 passed, failure was a stub error observation that did not terminate its event stream. Corrected to an explicitly failing runtime stream.
- Expanded example coverage: 31 tests, all three consecutive runs exit 0 (12.60s, 12.39s, 12.40s). Example typecheck exit 0.
- Current root required command receipts/logs: `_ops/goal-btw/checks.json`, one log per command. Root build/typecheck/API surface/version authority/workflow all exit 0. Initial root aggregate test exit 1: official-pi-workflow could not resolve Bun, 3370 client tests passed / 32 skipped / 1 failed, and subsequent workspaces did not run.
- Root failure trace: `support/test-bun-bin.ts` deliberately excludes `~/.bun/bin`, where this machine's Bun is installed. Set the existing CI inputs `BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun` and `BYOK_REQUIRE_BUN=1`; the official workflow focused probe then passed (exit 0, 545ms). This focused result is not root acceptance. The canonical prepare-acceptance run will execute the complete root test with those declared inputs, including formerly skipped Bun suites.
- Frozen acceptance source will be `.ai/harness/checks/latest.json` and its immutable `.ai/harness/runs/` snapshot; raw `_ops` milestone logs are historical troubleshooting receipts, not a substitute for the typed acceptance packet. No test gate is skipped or suppressed.

## Limits

Copy-and-own private example, one Host scheduling worker, no quickstart route behavior change. Built-in node:sqlite only; test DBs and SDK homes are separate owned temp paths and cleaned. SQLite CAS is tested across connections, not as a production multi-worker scheduling/send-lease protocol. Host-only reopen proves neither full coordinator+daemon restart nor native Pi/Claude/Codex execution; durable SDK coordinator composition and downstream acceptance remain independent.

## User-authorized baseline architecture repair

Clean base ede2db31 reproduced the unresolved-major-change / verified-flow-proof-changed gate for capability.sdk.sdk-root. The missing local .codegraph had degraded P2 selector evidence. The user authorized the exact major repair, then the worktree-local ignored official CodeGraph 1.5.0 index. It restored the existing 3/3 selectors and exact original flowProofDigest c105ee1286780504c1041f4587ff6c06a1d292ff18d33aa3359e656950ce1214, with no model/semantic boundary change. Claude reviewed the 91-line two-file preview and explicitly OK'd apply (H10).

Only docs/architecture/modules/sdk/sdk-root.md and docs/architecture/.projection-manifest.json are added to allowed_paths. The metadata/provenance repair is independent of goal/btw and separately revertible. The manifest's branch/base commit/dirty worktree refer to local indexed evidence, not a committed release. The main and Pi-upgrade checkouts were untouched. All current_exact commands are to be rerun after applying the refreshed ChangeSet; pre-repair passes are historical only.

The final post-contract ChangeSet `changeset.goal-btw-root-proof-final-20260930` was compared against Claude's approved indexed preview: identical sdk-root content and semantic state, only rebased provenance/digests differed. Native archctx apply returned applied/exit 0. Native validate returned valid=true/errors=[]/exit 0 (one pre-existing ignored review.failOn warning retained as advice). Architecture projection check returned noop/exit 0. The actual tracked architecture diff is exactly the two allowed documentation paths (22 additions/18 deletions); model/flow/relations and artificial proof changes are absent. The final prepare-acceptance run forces fresh checks on this new subject rather than reusing pre-repair current_exact evidence.
