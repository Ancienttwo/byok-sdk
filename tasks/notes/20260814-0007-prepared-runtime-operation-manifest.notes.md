# Implementation Notes: prepared-runtime-operation-manifest

> **Durable dispatch**: worker `/root/prepared_runtime_operation_manifest`; worktree `/Users/kito/Projects/byok-sdk-wt-prepared-runtime-operation-manifest`; branch `codex/prepared-runtime-operation-manifest`; base `98cea8c534f595314d4bbd67ea434da6feeb0e20`.

> **Status**: Code freeze pending rebase to `main@8e8d3a6`
> **Plan**: plans/plan-20260814-0007-prepared-runtime-operation-manifest.md
> **Contract**: tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md
> **Review**: tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md
> **Last Updated**: 2026-08-14 00:51
> **Lifecycle**: notes

## Design Decisions

- **P1 — authority map.** `packages/client/src/types.ts` is the public adapter
  boundary; `TaskRunner` owns offer admission/claim/start ordering; bundled
  Pi/Claude/Codex own runtime-specific policy and provider/model semantics;
  `create-daemon.ts` and `runtime-probe.ts` project discovery from the same
  descriptor. Protocol-v1, new runtime ids, failure taxonomy, and shutdown
  disposal remain outside this row.
- **P2 — traced offer.** A `task.offer` now passes raw-policy/toolset gates,
  one frozen descriptor snapshot, `detect()`, and pure `prepare()` before any
  workspace lease/mutation or `task.claim`. The daemon seals the
  credential-free manifest, sends claim capability/runtime from it, resolves
  post-claim instruction/workspace resources, and calls only the prepared
  operation. Pi/Claude/Codex read the manifest selection at start and verify
  it still matches their pre-claim pinned choice.
- **P3 — one authority cut.** The smallest coherent break replaces direct
  `RuntimeAdapter.start()` with required descriptor + prepare + operation;
  retaining an optional hook, overload, alias, or direct-start fallback would
  preserve duplicate authority. The descriptor and manifest are copied and
  frozen, including policy/tool arrays and environment-name declarations.
- **Purity boundary.** Pi rejects a BYOK selection with no custody launcher
  during `prepare()` before RPC spawn; Claude pins its CLI and optional
  approval-MCP binary during prepare; Codex pins its CLI and policy/model
  arguments during prepare. Temp config, workspace mutation, session creation,
  and CLI process creation remain operation-start work.

## Deviations From Plan Or Spec

- No product-scope deviation. Parent coordination requires a local checkpoint
  before rebasing this frozen row from `98cea8c534f595314d4bbd67ea434da6feeb0e20`
  to `main@8e8d3a6`; `create-daemon.ts` will be manually merged to preserve
  both descriptor authority and shutdown lease ordering, then every contract
  check will rerun on the new base.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Retain direct `start()` beside `prepare()` | Rejected | It leaves two public lifecycle authorities and violates the 0.4.0 breaking cut. |
| Give TaskRunner provider/model mapping | Rejected | Pi/Claude/Codex remain the provider/runtime semantic owners; TaskRunner carries only the sealed selection. |
| Put environment values in manifest | Rejected | The manifest is an identity/audit-safe authority; values stay only in the post-claim start input. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-rebase targeted type/test: `pnpm --filter @byok-sdk/client run typecheck`
  and five adapter/TaskRunner suites — 92 tests passed (2026-08-14).
- Pre-rebase release/build/smoke: `node scripts/release/check-package-graph.mjs`
  passed at dispatch train 0.4.0; `pnpm --filter @byok-sdk/client run build`
  passed; `pnpm --filter @byok-sdk/client run smoke:adapters` passed Pi missing
  launcher with no claim/start/spawn plus positive Pi/Claude/Codex runs.
- Falsifier source: `packages/client/src/__tests__/task-runner-runtime-selection.test.ts`
  instruments prepare, claim, started, RPC spawn, and workspace existence; the
  missing-launcher case is green with `{ prepares: 1, claimed: false, started:
  false, spawns: 0, workspaceExists: false }`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
