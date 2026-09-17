# Plan: wp4-five-edge-enablement (WP4 second cut — five edges in one enablement)

> **Status**: Executing
> **Created**: 20260917-2155
> **Slug**: wp4-five-edge-enablement
> **Planning Source**: fable-main-loop-freeze
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: `repo-harness run verify-contract --contract tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md --strict`.
> **Rollback Surface**: Before execution remove this plan; after execution revert slice commits on branch `claude/wp3-custody-wiring` back to `07b8798d`.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md`
> **Task Review**: `tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md`
> **Implementation Notes**: `tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md`

## Why
Owner dispatch 2026-09-17 (WP4 五边一次启用): plan 1459 WP4 + Map B (docs/researches/20260917-wp2n1-native-custody-evidence-map.md). Groundwork (decd2841) landed the runner preset entry behind the helper argv shape with no vendor reroute. This cut turns the five delegation edges on in ONE change and wires the custody chain; half-enablement is forbidden.

## Frozen decisions (Owner rulings in force)
- Charge-once frozen table: rpc→runner=1, rpc→print=1, runner→print=0 (bootstrap), print→runner=1, print→print=1. No maxDepth raise, no root reset, no assertion loosening.
- sdk-reserved-helper-host `__byok_sdk_helper` shape is the ONLY legal production entry; after this cut no production path may reach legacy pi-spawn discovery (env/argv/package-root/PATH fallback).
- Vendor byte changes ARE authorized for exactly this cut, scoped to the reroute (see contract allowed_paths); every other vendored byte stays frozen.
- Crash semantics four stages (未准入/已准入未spawn/已spawn/终止待确认) wire to existing primitives — fanout admission lock, permit, launch record, charge — no second scheduler.

## Task Breakdown

- [x] P1 架构事实核实（explorer FINDINGS：bundle 内联工厂加载、snapshot 剪枝、无生产 minter、manifest golden 机制）
- [x] P2 真实路径 trace（execution.ts:566-593 前台 spawn / async-execution.ts:522-572 jiti 后台 spawn / pi-spawn.ts:139-163 旧发现链）
- [x] P3 设计冻结 D1–D7（notes "Design freeze" 节；契约 vendor 面同步放宽至 0.60.0/src/** + manifest）
- [x] 契约 id 已报 Owner：20260917-2155-wp4-five-edge-enablement（strict Partial，实现落地后转 Fulfilled）
- [x] 实施刀完成：4de4dcb0（D1–D7 全量落地 + gate r1 自修 thin-bin 内联缺陷）
- [x] 主循环验证 + strict 复核：13 检查 12 绿，唯一红 = 预声明本地 registry tripwire（两次运行同项）
- [x] gatekeeper r1 FAIL（F1/F2 测试缺口）→ fast-worker 补刀 67afe3b3 → r2 PASS
- [ ] 回报 Owner（push 等明示）——本条为回报后终态
1. [ ] P1 finish: explorer map of pi-subagents runtime loading + packed provision + env seam + mint sites (in flight).
2. [ ] Design freeze (Fable main loop, after findings): bridge shape for vendored-side mint/dispatch; reroute argv shapes for foreground (print) + background (runner) spawns; legacy discovery replacement semantics (fail-closed without SDK custody env).
3. [ ] Reroute: execution.ts foreground spawn + async-execution.ts jiti spawn → `__byok_sdk_helper` shape; pi-spawn.ts:139-163 legacy chain replaced (no production bypass left).
4. [ ] Five edges enabled at once: rpc→runner, rpc→print, runner→print, print→runner, print→print; charge table enforced at every edge (print bootstrap = 0, runner bootstrap = +1).
5. [ ] Custody chain ①②④⑤ on the single rerouted path: ① atomic fanout with SDK verified-parent binding; ② cross-process parallel/session cap enforcement (not numeric-only); ④ createWorkflowChildPermit gains a real issuer→consumer wired before spawn; ⑤ root-parent + crash four-stage semantics via existing primitives. Mechanism conflict → minimal counterexample + BLOCKED, never silent skip.
6. [ ] Windows: win32 charge-once / helper direct-connect spawn coverage (todos trigger condition met); any skip needs explicit reason + todos entry; POSIX green not weakened.
7. [ ] Tests: five-edge enablement evidence per edge; double-charge regression stays red on unrerouted bypasses and green on rerouted paths; legacy-discovery-gone pin.
8. [ ] gatekeeper (independent) → report; push waits for Owner.

## Non-Goals
WP5 S2 gate, WP6 composition acceptance, native 1006, #193 merge, CI/workflow changes, product semantics beyond the custody chain.

## Stop rules
fail→fix→re-gate ≤3 rounds per issue; ①②④⑤ conflict → BLOCKED with minimal counterexample; no half-enablement under any schedule pressure.

## Rollback
Single slice commit(s) on claude/wp3-custody-wiring; revert restores 07b8798d bytes (groundwork state).

## Promotion Gate

- **Merge/PR unit**: This plan is the proposed mergeable execution unit (commit `4de4dcb0` on `claude/wp3-custody-wiring`); revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove this plan; after execution revert branch `claude/wp3-custody-wiring` to `07b8798d`.
- **Verification boundary**: Contract checks in `tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md` plus `repo-harness run verify-contract --contract tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md` must record pass against the frozen success criteria (five edges live, legacy discovery unreachable, charge table intact, ①②④⑤ wired, no cross-face writes, no AI attribution).
- **High-risk surface**: vendored tree reroute (3 files) + 7 un-pruned payload closure files + dispatcher mint authority; manifest accounting enforced by pi-sealed-factory-closure.test.ts.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: this plan's `## Task Breakdown`, `tasks/todos.md`, `tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md`, `tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md`, `tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, five-edge test file `packages/client/src/__tests__/custody-five-edge-dispatch.test.ts` (8/8), and the contract's check commands
- **Evaluator rubric**: gatekeeper (independent, read-only) must return PASS against the acceptance contract
- **Stop condition**: all task breakdown items complete, contract strict Fulfilled (local-env trap `pi-s2-bundle-resolution` documented, CI authoritative after authorized push), gatekeeper PASS
- **Rollback surface**: revert slice commits to `07b8798d`.
