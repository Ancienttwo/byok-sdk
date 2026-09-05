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
