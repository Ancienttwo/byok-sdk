# Task Contract: wp4-five-edge-enablement

> **Status**: Partial
> **Plan**: plans/plan-20260917-2155-wp4-five-edge-enablement.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-18 04:1x
> **Review File**: `tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md`
> **Notes File**: `tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why
Owner dispatch 2026-09-17 (WP4 五边一次启用). Plan 1459 WP4: the vendored runtime's two real spawn sites (runs/foreground/execution.ts:588, runs/background/async-execution.ts:564 jiti) still spawn through legacy discovery (pi-spawn.ts:139-163) with no custody chain; Map B ①②④⑤ primitives exist but are unwired (admission→permit→spawn→charge never串成一条链). WP4 groundwork (decd2841) preset entries behind the helper argv shape without enabling production edges.

## Goal
One cut: (1) both vendor spawn sites rerouted to the `__byok_sdk_helper` shape with sdk-reserved-helper-host as the only legal entry and NO remaining production path to legacy pi-spawn discovery; (2) all five delegation edges (rpc→runner, rpc→print, runner→print, print→runner, print→print) production-enabled simultaneously under the frozen charge table (rpc→runner=1, rpc→print=1, runner→print=0, print→runner=1, print→print=1; no maxDepth raise, no root reset, no assertion loosening); (3) custody chain ①②④⑤ wired on the single rerouted path: ① atomic fanout with SDK verified-parent binding, ② cross-process parallel/session cap execution (not numeric-only validation), ④ createWorkflowChildPermit real issuer→consumer before spawn, ⑤ root-parent + crash four-stage semantics via existing primitives (no second scheduler); (4) win32 helper direct-connect / charge-once spawn coverage where the helper shape allows it.

## Scope

- In scope: packages/client/src/** (custody/, sdk-reserved-helper-host, adapters/pi/, daemon/, bin/), packages/implementation-identity/**, client __tests__, vendor reroute files (below), packaging/provision surface the reroute requires (pinned by explorer findings before edit; amend this contract first if it widens), plan/contract/review/notes trio, tasks/todos.md.
- Vendor byte changes EXPLICITLY AUTHORIZED (this contract, widened 2026-09-17 23:5x after explorer findings + design freeze in notes) for the whole vendored source tree + manifest:
  - packages/client/vendor/pi-subagents/0.60.0/src/** (reroute edits, un-pruned child payload closure per design freeze D5, dispatcher bridge imports)
  - packages/client/vendor/pi-subagents/0.60.0/source-manifest.json (per-file sha256 accounting, same-slice)
  Accounting is machine-enforced by pi-sealed-factory-closure.test.ts (delta must equal hash divergence; every changed/new file must be in the manifest). The vendored diff outside pi-subagents/0.60.0/ remains zero.
- Out of scope: .github/workflows (WP1 face), Codex w2:pB / codex/c07-pi-runtime-launch branches, WP5 S2 gate, WP6, native1006, #193 merge, product semantics beyond the custody chain, push (Owner-only).

## Stop Conditions
- Stop and BLOCKED-report (with minimal counterexample) if ①②④⑤ has a mechanism conflict with existing primitives — never silent skip, never half-enablement.
- Stop if a green suite requires weakening any custody assertion, raising maxDepth, or resetting root depth.
- Stop if the reroute would require a steady-state dual spawn authority (legacy + helper both reachable in production).

## Falsifier
- After this cut, any production code path that still reaches pi-spawn legacy discovery (env-override/package-root/PATH fallback) or spawns a subagent outside the attested exec points = FAIL.
- Any edge charging ≠ frozen table (e.g., rpc→runner→print summing to 2) = FAIL. The double-charge regression family stays red on unrerouted bypass shapes and green on rerouted paths.
- Any of ①②④⑤ claimed "wired" without a test exercising the real primitive (lock, permit consume, cap enforcement across processes) = FAIL.

## Workflow Inventory

- Source plan: `plans/plan-20260917-2155-wp4-five-edge-enablement.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md`
- Notes file: `tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md`
- Scope gate: edit only paths listed under `allowed_paths`; amend this contract before widening.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260917-2155-wp4-five-edge-enablement.md
  - tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md
  - tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md
  - tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md
  - packages/implementation-identity/
  - packages/client/src/
  - packages/client/vendor/pi-subagents/0.60.0/src/
  - packages/client/vendor/pi-subagents/0.60.0/source-manifest.json
  - tasks/todos.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260917-2155-wp4-five-edge-enablement.md
  artifacts_exist:
    - tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "identity-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/implementation-identity test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "identity 包全绿（descendant-launch/expectation 原语不动摇）。",
      "inputs": {"env": []}
    },
    {
      "id": "client-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/client test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "client 全量（含五边启用证据、charge-once 回归、win32 direct-connect、legacy-gone pin）。",
      "inputs": {"env": []}
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "全仓类型绿。",
      "inputs": {"env": []}
    },
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "构建绿（含 vendored 改动的消费面）。",
      "inputs": {"env": []}
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "公共 API 面 golden 一致（如面变则 --update 且 delta 仅本刀语义）。",
      "inputs": {"env": []}
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "版本权威未触碰。",
      "inputs": {"env": []}
    },
    {
      "id": "vendored-diff-scoped",
      "kind": "command",
      "command": "git diff --name-only 07b8798d -- packages/client/vendor/ | grep -vE 'pi-subagents/0.60.0/(src/|source-manifest.json)' && echo VENDORED_SCOPE_VIOLATION || echo VENDORED_SCOPE_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "vendored 改动仅限契约显式批准的改道文件与 runs/shared/byok- 桥接新文件。",
      "inputs": {"env": []}
    },
    {
      "id": "legacy-discovery-gone",
      "kind": "command",
      "command": "! grep -nE 'command: \"pi\"' packages/client/vendor/pi-subagents/0.60.0/src/runs/shared/pi-spawn.ts && ! grep -q 'resolvePiCliScript(deps)' packages/client/vendor/pi-subagents/0.60.0/src/runs/shared/pi-spawn.ts && echo LEGACY_GONE",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "pi-spawn 旧发现链（standalone/包根上溯/裸 pi PATH 回落）不再存在。",
      "inputs": {"env": []}
    },
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": {"env": []}
    }
  ]
}
```

## Acceptance Notes (Human Review)

- 半启用=FAIL：五边必须同刀可证。①②④⑤ 要么接线有测试证据，要么 BLOCKED+最小反例（notes 落盘）。
- charge-once 冻结表与 maxDepth/root 断言不动；双扣回归在未改道旁路保持红、在改道路径绿。
- Windows：helper direct-connect 覆盖优先；确需 skip 须显式原因 + todos。
- gatekeeper 独立验收后回报 Owner；push 等 Owner 明示。

## Rollback Point

- Commit / checkpoint: 07b8798d (groundwork + trio). Revert this slice's commits restores the pre-enablement bytes.
