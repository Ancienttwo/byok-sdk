# Plan: BYOK SDK 下一阶段 — Recursive Runtime & S2 Completion（WP0–WP6）

> **Status**: Executing
> **Created**: 20260917-1459
> **Slug**: byok-next-stage-recursive-s2
> **Planning Source**: owner-review-execution（外部复核 `docs/researches/BYOK_SDK_next_stage_review_2026-09-17.md` + origin/handoff 状态修正）
> **Orchestration Kind**: host-plan
> **Source Ref**: PR #193 @ `d4dcf961`；handoff-260915-c07-g3b-design-decision.md §145–§150；CI run 35177371443
> **Artifact Level**: work-package
> **Promotion Reason**: owner_ruling_2026-09-17（边界 1→A / 边界 2→B / charge-once 裁定）
> **Verification Boundary**: 文档/计划/契约层；WP1/WP3 产品实施刀在各自 worktree 独立验证
> **Rollback Surface**: 契约 20260917-1459-byok-next-stage-recursive-s2 Rollback Point 一节
> **Task Profile**: docs-only（program 登记）；输入：外部复核文档（Owner 保存）

## 状态修正（相对外部复核，2026-09-17 14:59 核验）

1. 复核基线 main=`601a1991` 已过时：601a1991 是 PR #187 merge，取数时的旧 tip；现 origin/main=`c93ecdc3`（#188/#189/#190 已合）。
2. 复核称「detection 独立验收仍 PENDING」已过时：handoff §150 记录独立 gate **PASS 7/7**（subject `d4dcf961`，gate-verdict `/private/tmp/api-d-api-r-gate/gate-verdict.md` 已被 supervisor 接受，含 build/typecheck/focused/10 goldens/physical parity 28/28/real release-pack），授权 staged push 已完成，PR #193 head=`d4dcf961` OPEN/Draft。
3. supervisor raw-log audit：run 35177371443 仅两项失败，均为**既有** Windows 问题（lifecycle `platform_default_is_writable`；release-pack keys `pi-projection-windows.test.ts` 入口解析 `@byok-sdk/implementation-identity`），detection 切片零新增失败。
4. PR #193 正文仍引用 `7ae976ad` 旧验收（文档滞后；不追改冻结产物，merge 决策时用新前向 receipt 收口）。
5. custody 未启用坐实：`packages/client/src/sdk-reserved-helper-host.ts:92` 抛 `custody execution gates pending`（runner/print 共用该 dispatcher）。

## Goal

真实递归可运行、所有后代受 custody 约束、完整 S2 通过、正式 SDK/Host/native 组合可验证。

## Non-Goals（已决事项不重开）

- sealed structured-output = alpha 显式拒绝；scripted workflow 保留于首个 sealed release（执行+装载闭包完成后启用）；salesko P4 仅本地实施直至正式组合发布。
- #194/#195 产品层（输入计量、Main/Summary 预算、Host CAS、ContextPack、Summary 链路）按各自验收关闭，本 plan 的运行时切片通过不替代这些产品事实。
- 不为过 S2 删 workflow；不把动态执行挪到 scanner 不看的 worker/VM（`node:vm` 非安全机制）。

## Task Breakdown

- [x] WP0 detection 独立 gate：§150 PASS 7/7 @ `d4dcf961`，push 完成，CI audit 完成。剩余收口 = merge 决策时新前向 receipt + PR 正文刷新（Owner 门，不重跑 gate、不追改冻结产物）。
- [x] WP1 Windows 两失败有界修复：已由 #198 合入 main（branch `claude/wp1-windows-ci-on-193`，merge `49ec7477`，2026-09-18 stage-2 CI receipt；实现取代了此处原记的 bounded-fix 分支）：
  - lifecycle：Pi 正向用例改到真实非管理员 token + 经不可写负控验证的启动目录；管理员/可写目录拒绝测试保留。不得删除或放宽 `platform_default_is_writable` 检查。
  - release-pack：干净 checkout 中先构建 workspace 产物再跑 keys 前置测试（修构建顺序，不改产品入口语义）；测试 cleanup 不得沿 junction/symlink 递归操作临时树外目标，加树外 canary。
  - 验证：mac 本地只能做 yaml/脚本级 sanity；Windows 断言由 CI run 确认。不弱化断言换绿灯。
- [x] WP2-N1 SDK→native 消费面证据图（explorer，2026-09-17 完成，见文末附录）：export 消费点、themes/locales/skills 资源定位、print 入口与输出路径策略、RPC schema 生成点、jiti/隐式发现/自动安装/clipboard tripwire 站点。
- [ ] WP2 N2（静态装载与构建图）/ N3（scripted workflow 等价实现）：待 N1 证据图出实施刀；机制冲突时交最小反例，不重开功能取舍。
- [x] WP3 custody 五项跨进程实现（已由 #199 合入，merge `e0423d84`，2026-09-18，含 stage-3 all-green receipt）：原子 fanout / session 排他 / charge-once / 取消重试 permit / root-parent custody；复用现有锁、lease、permit 机制，不引第二 scheduler。崩溃语义按四阶段划分（未准入/已准入未 spawn/已 spawn/终止待确认）。证据图见附录 Map B——原语已存在且 fail-closed，缺的是 admission→permit→spawn→charge 链条串联与 vendor spawn 点接线；charge-once 存在具名冲突（逻辑委派 depth 1 vs vendor 物理计 2，rpc→runner→print）。
- [x] WP4 print/runner 五边接线（已随 #199 合入，五边闭合刀 `4de4dcb0`/`67afe3b3`，2026-09-18；收尾遗留见 todos 已消费行）：先 print 独立入口 → same-bundle runner → 一次性接齐五边（rpc→runner、rpc→print、runner→print、print→runner、print→print）统一启用。实质 = 把 vendor 两个真实 spawn 点（`execution.ts:588` 前台、`async-execution.ts:564` jiti 后台）改道 `__byok_sdk_helper` 形状（`sdk-reserved-helper-host.ts:91-92` 即唯一合法入口），替换 `pi-spawn.ts:139-163` 的 env/argv/PATH 旧发现。禁止半启用产品，禁止 maxDepth 降 0 绕过。
- [x] WP5 S2 强制 gate：CI flip 刀完成 @ 分支 `claude/wp5-s2-ci-flip`（实现 `9fd4ad28`，base a6c5a297=origin/main，2026-09-19；契约 `tasks/contracts/20260919-0244-wp5-s2-ci-flip.contract.md`）。四条款 receipt：① Bun 路径/版本/hash = build-test resolve step（`command -v bun` 空即 fail，打印 path/`bun --version`/`shasum -a 256`，`BYOK_TEST_BUN_BIN` 写入 GITHUB_ENV）；② 缺工具/skip 不产生成功结论 = job env `BYOK_REQUIRE_BUN=1` + 共享 helper（`packages/client/src/__tests__/support/test-bun-bin.ts`）module-scope throw，RED 证据 `tasks/runs/20260919-0244-wp5-s2-ci-flip.red-evidence.log`，无 flag 时 skip 路径保留（skip-path.log）；③ registry 零尝试断言原样保留（s2 :321/:327 零改动）；④ 监视器主动负控 = s2 新增不依赖 bun 的真实请求捕获测试（registryAttempts length 1）。候选并集核验：三文件 a6c5a297 候选列表同集同序，无本地发现路径回归。已知本地项：s2 :327 clipboard tripwire 在 darwin（hasDisplay）本机红、基线同现，归口 PR #202（`origin/claude/wp5-s2-tripwire-zero`，fork pin 0.85.1006）；headless ubuntu CI 恒零。行为 gate = 分支 CI 全绿；24 次归零仍为 PR #202 归口的必要条件，非本刀完成标准。
- [ ] WP6 正式组合验收：冻结 SDK/native/Host/安装/执行/结果一组版本清单；从 Host sealed 工厂→真实安装记录→SDK observation→launch admission→五边递归与恢复全链路；故意替换 artifact/interpreter/policy/parent 的反例。

## 三条并行线（依赖为开发依赖，非时间承诺）

- 验收与 Windows：WP0、WP1 均已闭合。
- SDK runtime：WP3 custody → WP4 五边（print/runner 接线可在 custody 前预置，生产启用必须一次闭合五边）。
- native/Host 集成准备：WP2-N1 证据图 → N2/N3 → WP6 前置（不猜 native1006 已发布，不用 synthetic owner 顶替真实安装）。

## Stop rules

- fail→fix→re-gate 每问题 ≤3 轮，仍失败停止并上报。
- 范围外发现（含 ArchitectureProjection dead-letter `job-5ff5a0c2…`、既有 flake 提案 P1–P4）report-only。
- 未推送的本地验收、未跑的 Windows/付费模型矩阵不得被描述为已验证。

## 附录：证据图与裁定指针

- WP2-N1 + WP3 证据图已正式落位 `docs/researches/20260917-wp2n1-native-custody-evidence-map.md`（subject `d4dcf961`，2026-09-17 explorer 只读核查；契约 `tasks/contracts/20260917-1459-byok-next-stage-recursive-s2.contract.md`）。

## 写入面互斥矩阵（Owner 裁定 2026-09-17 边界 2→B）

基线一律 `d4dcf961`，不等 #193 合并；同一实现不允许两个工作流同时主导。

| 写入方 | 载体 | 独占写入面 | 禁触 |
|---|---|---|---|
| WP1（fast-worker，已派） | worktree `byok-sdk-wt-wp1-win-fix`，分支 `claude/wp1-windows-ci-on-193` | `.github/workflows/ci.yml`、`packages/client/scripts/adapter-task-smoke.mjs`、`packages/keys/**`（仅测试与 cleanup）、`scripts/pack-and-smoke.mjs` 调用顺序 | 产品源码与断言 |
| WP3/WP4（Claude supervisor 主导） | worktree `byok-sdk-wt-wp3-wiring`，分支 `claude/wp3-custody-wiring` | `packages/implementation-identity/**`、`packages/client/src/**`（sdk-reserved-helper-host、daemon/、adapters/pi/、vendor spawn 接线点） | CI/workflow 层（WP1 面） |
| Codex w2:pB | worktree `byok-sdk-wt-c07-pi-launch`，分支 `codex/c07-pi-runtime-launch` | 该分支本身及其 worktree | 上述两个 claude/* 分支 |
| 主 checkout（本 plan） | main | plans/、tasks/、docs/researches/（契约 20260917-1459-byok-next-stage-recursive-s2） | 产品代码 |

## WP3 charge-once 冻结表（Owner 裁定 2026-09-17，动手前生效）

唯一规则：**一次逻辑委派扣 1 层**。五边计数：

| 边 | 计数 | 说明 |
|---|---|---|
| rpc→runner | 1 | |
| rpc→print | 1 | |
| runner→print | 0 | bootstrap 零计费（`descendant-launch.ts:139-147` 已有此语义，expectedDepth = parent.depth + 0） |
| print→runner | 1 | |
| print→print | 1 | |

执行顺序（裁定）：①冻结本表 → ②建立可复现的双扣失败测试（vendor 现状 rpc→runner→print 物理计 2，契约计 1，测试须在未修接线上红）→ ③修 vendor 接线。禁止：提高 maxDepth、重置 root、放宽断言掩盖冲突。

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-1459-byok-next-stage-recursive-s2.md` Task Breakdown；`tasks/todos.md` deferred ledger；`tasks/contracts/20260917-1459-byok-next-stage-recursive-s2.contract.md`；`tasks/reviews/20260917-1459-byok-next-stage-recursive-s2.review.md`；`tasks/notes/20260917-1459-byok-next-stage-recursive-s2.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`、`.ai/harness/runs/`、契约 Verification Plan 内命令（git diff --check、repo-harness run check-task-workflow --strict）
- **Evaluator rubric**: review 文件记录换契验收面通过（旧契 Superseded、marker 切换、证据图迁移、strict 绿）
- **Stop condition**: Task Breakdown 全勾 + strict 通过 + review 推荐 pass
- **Rollback surface**: 契约 Rollback Point（回滚 active-plan marker 与两份契约 Status）

## Promotion Gate

- **Merge/PR unit**: docs-only transition 切片（契约换手 + 证据图落位），无产品代码
- **Rollback surface**: 同上
- **Verification boundary**: 文档/契约结构 + strict 工作流检查；无运行时变更
- **Review/acceptance boundary**: review 文件按验收面记录 pass
- **High-risk surface**: 无（docs-only）
- **Why not checklist row**: owner_ruling_2026-09-17（边界 1→A 正式换契要求 contract 通道）
