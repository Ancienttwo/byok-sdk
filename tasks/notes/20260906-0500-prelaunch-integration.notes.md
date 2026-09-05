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
