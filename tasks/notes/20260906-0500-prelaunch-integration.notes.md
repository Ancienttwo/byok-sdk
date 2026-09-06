# Prelaunch SDK integration evidence

## Boundary

Executing under autonomous overnight commit/push/PR authorization. No registry publication, tags, production deployment or live SQL migration.

## Integrated checkpoints

- Base `21adf71`: locally accepted #147 and prior relay changes. Preserve their earlier source acceptance; still distinct from remote delivery and package publication.
- Version/graph checkpoint `02325f9` (metadata commit `0e3dd3b`): SDK 0.14.0 / keys 0.4.0 prepared, not published. Prior source checks at that checkpoint passed; final pack was intentionally not run.
- Audit PR151 source `90832f5` and origin merge `6e6a9ca` integrated; live GitHub showed PR151 merged and passing checks before integration.
- Program decisions committed in `69ca7cd`: immutable taskId execution identity, cancellation outcome separate from immutable terminal bytes, cloud-owned Agent inventory and private-repo candidate CI.

## Active workers

- %8 / `byok-sdk-wt-execution-recovery`: terminal bytes, durable admission and transport confirmation, startup recovery, exact device/Agent fencing, cancellation convergence, real compiled SIGKILL fixtures. Final handoff expected at `/tmp/byok-execution-recovery-handoff.md`.
- %16 / `salesko-new-wt-multi-agent-cutover`: Agent-scoped Profile/Placement, explicit consumers, one-shot SQL migration and UI. Final handoff expected at `/tmp/salesko-multi-agent-handoff.md`.
- Root / `salesko-new-wt-prelaunch-integration`: candidate preparation and native compiled assertions, Local Agent inventory/reconciliation. Product root remains registry-pinned until an authorized published version exists.

## Harness contract naming

Confirmed installed parser requires `plan-YYYYMMDD-HHMM-...md`; missing time field causes `contract=null` despite a header. Renamed root plan/contract and activated with `switch-plan`. `state resolve --target-path packages/client/src/daemon/create-daemon.ts --operation edit` now has the exact contract, `phase=executing`, `allowedToEdit=allow`. Workers were sent the same proven correction. No global guard/policy change.

## Pending acceptance

Worker source freeze and handoffs, combined source/API/version/workflow checks, independent final review, canonical SDK pack, exact downstream installed graph and native compiled results, coherent pushed PRs with CI readback. Do not conflate worker progress, prepared metadata or test syntax with completed runtime acceptance.

## Recovery integration readback

- Merged worker `adfc85a0956aae1ac2518bec22acb096fcf7be91` as `f838a0f54624f5d2b9cc46e6ff4e766b3abaa1c3` without source conflict. Worker self-review is not the final independent integration acceptance.
- Node 22.22 source build, typecheck, all 9 API goldens and version authority passed on the integrated source.
- Re-ran the reported Wrangler packaging timeout under the Node 22.22 host after building the required dist: 6/6 tests passed in 2.23 seconds (2.07 seconds test body). No test timeout or source change was needed. A prior root invocation before dist existed refused at the documented build prerequisite and ran zero tests; it is not counted as a code failure or pass.
- Strict workflow identified the integration plan's `program` level as incompatible with an active implementation contract. This bounded SDK PR is an integration work-package; corrected that classification, leaving the product child separate and all acceptance requirements intact.
- Integrated full suite exited zero under Node 22.22 (`/tmp/astra-sdk-integration-tests.log`): client 1720, cloud 341, cloud-dataplane 74, conformance 160, core 252, example-live 21, example-connector 25, keys 427, protocol 358, server 348, testkit 4, UI 20, SDK 1 passed tests. Environment/platform skips remain separate; local Docker/Postgres/MinIO integration was not claimed.
- Independent native Claude review of `c678548` completed, retained at `/tmp/astra-sdk-integration-claude-review.md`. It accepted the recovery invariants but identified an oversized-terminal liveness defect and missing predecessor-format oracle. Final gate remains open: %8 owns a bounded explicit failure outcome for oversized results and the missing refusal test. No generic fallback, truncation, fabricated success, or durability bypass is permitted. Darwin-only SIGKILL evidence must not be inferred from green Linux CI.
- Closed the native-CI wiring gap with a dedicated macOS job using source `.node-version` and Bun 1.4.0, running the actual compiled SIGKILL suite plus SQLite tests and retaining source/runtime/log artifacts. Linux skips remain honest; this adds no product behavior or publication authority.
- Merged final bounded fix `a7915262129d933036c0ee5c01024b977b40a0a6` as `c3a7dcd102c66002dbc06df688b4867e1fb924fb`. Root caught and rejected an intermediate detached async catch: final overflow settlement is part of the assigned terminal tail. Genuine Agent-offer test proves exact identity, local confirmed bytes matching cloud receipt, immutable restart bytes and one runtime invocation. Worker targeted 14 SIGKILL + 36 SQLite tests and client typecheck passed. The predecessor refusal oracle snapshots before first refusal and proves schema/data/path preservation; only SQLite volatile header counters are normalized, so literal whole-file byte equality is not claimed. Targeted independent Claude recheck is pending.
- Targeted independent Claude recheck returned PASS. Its remaining SQLite skip gap was closed by required-mode native CI plus a fail-closed test module guard; root required-mode SQLite passed 36/36. Reviewer semantic note for oversized non-complete terminals is explicit in the contract. Root final typecheck/version/strict/diff checks passed. Local source execution used Node 22.22.0; canonical `.node-version` pins CI to 22.22.3 within the approved 22.22 lane.
- Post-review hooks produced unrelated unstaged architecture/context projections in this integration worktree. Preserve them outside the source commit. Canonical packing will use a new clean worktree at the frozen commit, not reset/stash those generated files or pretend a dirty directory is a clean subject.

## Final delivery — 2026-09-06

Source review follow-up, canonical CI pack/install, exact arm64/x64 consumer CI and PR 152 merge are complete. Current exact identities, residual matrix limitations and remaining operator gates are in `tasks/notes/20260906-pr152-closeout.md`; earlier pending-stage entries above are historical.
