# Plan: WP3 custody 第三刀 — charge-once 接线修复（print 预置入口）

> **Status**: Executing
> **Created**: 20260917-1628
> **Slug**: wp3-charge-once-wiring
> **Planning Source**: owner_ruling_2026-09-17（charge-once 执行顺序 ③「修 vendor 接线」）+ deep-reasoner 咨询（Option A，HIGH，2026-09-17）+ Fable 主循环裁决
> **Orchestration Kind**: host-plan
> **Source Ref**: 基线 d4dcf961 + RED 测试 daf46c47；前切片 plans/plan-20260917-1545-wp3-charge-once-red.md
> **Artifact Level**: work-package
> **Promotion Reason**: RED 测试转绿 = 本切片唯一产品判据（:200 print 观测 PI_SUBAGENT_DEPTH === '1'）
> **Verification Boundary**: client/implementation-identity 产品面 + 测试；vendored 树零字节改动
> **Rollback Surface**: 契约 Rollback Point（revert 本切片 commits 回 daf46c47）
> **Task Profile**: code-change

## Goal

按已裁定架构（WP4 helper 改道、print 独立入口预置）消除双扣：vendor 字节不动，通过 `PI_SUBAGENT_PI_BINARY` 接缝把 vendor 前台 spawn 指向 SDK 拥有的 print 预置入口；入口内 argv 模板门 + bootstrap 深度 re-stamp（parent + 0）+ validateDescendantSpawn/assertDescendantSpawn（首个真实调用者）+ 单一 attested exec 点；dispatcher print 分支预置、runner 分支保持 pending。RED 测试转绿。

## 设计裁决（Fable，基于咨询 Option A）

1. 深度权威唯一 = SDK 契约（冻结表）。vendor 自算深度值不是权威，入口丢弃之。
2. 父深度经 env commitment `BYOK_SDK_CUSTODY_PARENT_DEPTH` 传输；必须注册进 BYOK_* 精确枚举（未知 BYOK_* 到 attested spawn 维持 fail-closed，既有裁定）。缺 commitment/非整数 → 拒，禁止 fallback 到 vendor 值。
3. 双传输形状（本切片 env-seam pi-style argv；WP4 五边闭合后 fixedArgv 直连）汇入同一 attested exec 点（helper host print handler），不建第二 scheduler。WP4 闭合时 env-seam 传输退役，该义务记入 1459 父 plan WP4 条目。
4. dispatcher 既有 pin 测试（sdk-reserved-helper-host.test.ts:263-266 等）按新裁定行为更新（print 分支预置、runner 分支 pending 不变）——这是行为 pin 更新，不是断言弱化。

## 前置必查（deep-reasoner 实施确认点，开工第一步，结果回填 notes）

- ① assertDescendantSpawn（identity.ts:1730-1747）复验的 expectation 字段建模：fixedArgv 作 launch record 键 vs exec payload 逐位比对，以函数体为准。
- ② getPiSpawnCommand（pi-spawn.ts:139-163）对 PI_SUBAGENT_PI_BINARY 的消费形态（单命令串直接 spawn？node 前缀？）→ 决定入口 bin 形态（shebang/win32）。
- ③ vendor :553 深度注入是否剥离其余 env（父深度 commitment 能否穿透）——RED 转绿即运行时证明；若被剥离 → BLOCKED 上报，不得走私道。

## Non-Goals

- 不改 vendored 树任何字节；不动 node_modules；不启用 runner 边；不做五边闭合；不提 maxDepth；不重置 root；不删链健康断言。

## Task Breakdown

- [x] 确认点 ①②③ 现场核实并回填 notes（tasks/notes/20260917-1628-wp3-charge-once-wiring.notes.md「三个实施确认点」；③ 未触发 BLOCKED）
- [x] Step 1 print 预置入口 packages/client/src/custody/（argv 模板门 + re-stamp + attested 启动，三段全 fail-closed）
- [x] Step 2 helper host 单一 attested exec 点 launchAttestedPiSubagentPrint（落在 custody/pi-subagent-print-entry.ts，host 值导入路由——api-surface golden 字节冻结 + allowed_paths 硬边界，见 notes Deviations #1；机制不变）
- [x] Step 3 dispatcher print 分支预置（runner 分支零改动；更新既有 pin 测试为行为 pin：print 分支路由到 attested exec 点且无承诺即拒）
- [ ] Step 4 runner env commitments（PI_SUBAGENT_PI_BINARY 绝对路径 + BYOK_SDK_CUSTODY_PARENT_DEPTH + BYOK_* 枚举注册）——**部分完成，枚举注册未执行（本切片唯一缺口，PARTIAL）**：PI_SUBAGENT_PI_BINARY 与 BYOK_SDK_CUSTODY_PARENT_DEPTH（及机制必要的 BYOK_SDK_CUSTODY_LAUNCH_RECORD，Deviations #2）已在 runner env 构造点注入；`TOOL_IMPLEMENTATION_LIFECYCLE_NAMES`（identity.ts:663）注册会打红 packages/client/src/__tests__/tool-implementation-identity.test.ts:810-814 行为 pin，该文件不在 allowed_paths（硬边界）。已登记 tasks/todos.md（WP4 首刀：枚举加键 + 同刀更新 :810 pin）。运行时本切片无 attested spawn 边界消费这两键，不构成行为缺口。
- [x] Step 5 探针重定位（stub 移到 attested exec 目标位）+ RED 转绿（4 pass / 0 fail / 17 expect，:200 depth === '1'）+ 三条负路径断言（父深度缺失拒 / argv 模板 mismatch 拒 / runner 分支仍 pending）
- [x] 全量门禁：typecheck 绿 / client 套件 2805 pass + 1 fail = 既有 S2 tripwire（7ae976ad 豁免口径）/ check:api-surface 10 goldens match / check:version-authority pass / vendored 零字节（git diff daf46c47 空）/ assertDescendantSpawn 调用者 = 1（pi-subagent-print-entry.ts:236）；build 绿（import.meta.main 守卫修复所需）；check-task-workflow --strict 见 notes Evidence

## Stop rules

- fail→fix ≤3 轮。确认点 ③ 被证不可行即 BLOCKED 停止上报，不得改 vendor 或走私道。
- 范围外发现 report-only。
- Windows 上 seam spawn 形态若不可行：本切片 POSIX 绿 + win32 显式 skip（注明原因），Windows 覆盖登记 todos，不算弱化。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown；tasks/contracts/20260917-1628-wp3-charge-once-wiring.contract.md 三件套
- **Verification evidence**: 契约 Verification Plan + red→green 前后对照（1545 切片 red-run.txt 为 before）
- **Evaluator rubric**: review 记录转绿 + 三负路径 + 零 vendored 字节 + assertDescendantSpawn 首调用
- **Stop condition**: Breakdown 全勾 + 门禁全绿
- **Rollback surface**: revert 本切片 commits 回 daf46c47

## Promotion Gate

- **Merge/PR unit**: 分支 claude/wp3-custody-wiring 本地 commits，不 push（gate 后 orchestrator 决定）
- **Rollback surface**: 同上
- **Verification boundary**: 产品运行时行为 + attested 记录；vendored 零字节
- **Review/acceptance boundary**: gatekeeper 验转绿真实性 + fail-closed 守护
- **High-risk surface**: implementation-identity 共享包（其既有测试必须全绿）
- **Why not checklist row**: owner_ruling 顺序 ③ 独立切片
