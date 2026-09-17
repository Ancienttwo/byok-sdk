# Plan: WP3 custody 第一刀 — charge-once 双扣 RED 测试

> **Status**: Executing
> **Created**: 20260917-1545
> **Slug**: wp3-charge-once-red
> **Planning Source**: owner_ruling_2026-09-17（边界 2→B + charge-once 冻结表）；父计划 plans/plan-20260917-1459-byok-next-stage-recursive-s2.md（主 checkout）
> **Orchestration Kind**: host-plan
> **Source Ref**: 基线 d4dcf961；证据图 docs/researches/20260917-wp2n1-native-custody-evidence-map.md（主 checkout）
> **Artifact Level**: work-package
> **Promotion Reason**: owner_ruling_2026-09-17 执行顺序：①冻结表（父计划）→ ②双扣 RED 测试（本切片）→ ③修 vendor 接线（后续切片）
> **Verification Boundary**: 测试层；不改 vendor 源码
> **Rollback Surface**: 契约 Rollback Point（删除新增测试文件即可回滚）
> **Task Profile**: code-change（测试编写）

## Goal

可复现的双扣失败测试：在未修复的 vendor 接线上，一次逻辑委派 rpc→runner→print 物理计 depth 2，冻结表契约计 1；测试须红（RED），修接线后转绿。Owner 裁定的 WP3 执行顺序第②步，先于任何 vendor 接线修改。

## 冻结表（Owner 裁定 2026-09-17，引用父计划）

唯一规则：一次逻辑委派扣 1 层。rpc→runner=1、rpc→print=1、runner→print=0（bootstrap）、print→runner=1、print→print=1。

## Non-Goals

- 不修 vendor 接线（后续切片）；不改 maxDepth/root 语义；不放宽任何既有断言；不动 sdk-reserved-helper-host dispatcher 关闭状态。

## Task Breakdown

- [x] 在 packages/client/src/__tests__/ 新增双扣 RED 测试：驱动真实 vendor spawn 链（execution.ts:588 前台 / async-execution.ts:564 jiti 后台），断言 print 子代观察到的深度投影（PI_SUBAGENT_DEPTH 或等价）等于契约值 1；现状物理 2，测试红。
- [x] 捕获 RED 运行产物（含退出码），按契约 Root Cause Evidence 语义登记。（red-run.txt，RED_EXIT=1）
- [x] bun run typecheck 通过；除新测试红外无其他回归。（16 包全绿）

## Stop rules

- fail→fix ≤3 轮；本刀就是证明冲突，vendor 行为修不了属预期，不允许为转绿改断言。
- 范围外发现 report-only。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown；tasks/contracts/20260917-1545-wp3-charge-once-red.contract.md 三件套
- **Verification evidence**: 契约 Verification Plan（聚焦 bun test、typecheck）；RED 产物路径
- **Evaluator rubric**: review 文件记录 RED 成立（未修接线上红、非 trivially-failing）+ 无断言弱化
- **Stop condition**: Breakdown 全勾 + RED 产物在
- **Rollback surface**: 删除新增测试文件

## Promotion Gate

- **Merge/PR unit**: 单测试文件切片，分支 claude/wp3-custody-wiring 本地 commit，不 push（gate 后由 orchestrator 决定）
- **Rollback surface**: 同上
- **Verification boundary**: 测试运行时行为；无产品语义变更
- **Review/acceptance boundary**: gatekeeper 验 RED 真实性
- **High-risk surface**: 无产品代码改动
- **Why not checklist row**: owner_ruling 执行顺序明定先测试后修
