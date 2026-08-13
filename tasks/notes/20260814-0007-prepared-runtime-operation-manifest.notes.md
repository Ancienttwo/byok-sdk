# Implementation Notes: prepared-runtime-operation-manifest

> **Durable dispatch**: worker `/root/prepared_runtime_operation_manifest`; worktree `/Users/kito/Projects/byok-sdk-wt-prepared-runtime-operation-manifest`; branch `codex/prepared-runtime-operation-manifest`; base `98cea8c534f595314d4bbd67ea434da6feeb0e20`.

> **Status**: Code verification passed (including blobRef P1 fix); ship blocked pending fresh acceptance receipt
> **Plan**: plans/plan-20260814-0007-prepared-runtime-operation-manifest.md
> **Contract**: tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md
> **Review**: tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md
> **Last Updated**: 2026-08-14 02:00
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

- No product-scope deviation. The frozen row checkpoint
  `4972dc62e86876e35dd97f45ccd7dddcb35f8a15` was rebased from
  `98cea8c534f595314d4bbd67ea434da6feeb0e20` to
  `main@8e8d3a601d2c64eece83eb6d9da9f8fbe17549ac`, producing
  `aaedc384e992aaf5ed80d0ccde93d68f187ee244` with no conflicts. Manual
  inspection of `packages/client/src/daemon/create-daemon.ts` confirmed both
  Row 1 descriptor authority and main's shutdown ordering (stop serving
  control RPCs → release daemon-owner lease → remove control socket/token
  signal) survived. Main's newly-added hosted child fixture still encoded the
  removed adapter shape; it was atomically moved to descriptor + prepare as
  part of the required all-fixture migration.

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
- Post-rebase client verification: source dependency builds (`core`, `protocol`,
  `cloud`) followed by client typecheck passed; full client Vitest passed
  114 files / 1180 tests; rebuilt entry smoke passed all three positive adapters
  plus the zero-side-effect Pi missing-launcher case; release package graph
  passed at 0.4.0.
- Post-rebase workspace verification: `pnpm -r run typecheck`, `pnpm -r run
  test`, and `pnpm -r run build` all passed after rebuilding the stale local
  dependency artifacts required by main's toolset-discovery changes. The
  contract no longer lists `verify-contract` inside its own `commands_succeed`
  list: invoking that outer gate from within the list is self-recursive.
- Final gate: one outer `repo-harness run verify-contract --contract
  tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md
  --strict` passed, including client typecheck/test/build/smoke, release graph,
  workspace typecheck/test/build, and strict workflow validation. The verifier
  set the contract status to `Fulfilled`.
- Gatekeeper verdict: P1/P2/P3 code surfaces passed. This task remains
  `Executing`, not review-complete: a fresh acceptance receipt is still needed
  before ship authorization. No review artifact or acceptance receipt was
  fabricated by this implementation worker.
- Claude P1 fix: Pi, Claude, and Codex now accept the protocol-valid raw
  instruction `blobRef` during pure `prepare()` while pinning their normal
  policy/selection/launcher decisions; only prepared-operation `start()`
  accepts the resolved string. The real daemon regression uses the bundled
  fake Claude adapter: it observes `task.claim`, no pre-claim decline, the
  blob GET, and `reply-1:<resolved blob text>` after `task.started`.
- P1 verification: targeted daemon-blob plus Pi/Claude/Codex adapter suites
  passed 4 files / 91 tests; client typecheck, full client test (114 files /
  1181 tests), build, adapter smoke, strict workflow, and one outer strict
  contract verification all passed after this fix. Acceptance remains fresh
  receipt-dependent because this source SHA changed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
