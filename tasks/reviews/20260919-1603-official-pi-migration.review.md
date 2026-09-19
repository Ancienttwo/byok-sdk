# Task Review: official-pi-migration

> **Status**: Open
> **Plan**: plans/plan-20260919-1603-official-pi-migration.md
> **Contract**: tasks/contracts/20260919-1603-official-pi-migration.contract.md
> **Notes File**: tasks/notes/20260919-1603-official-pi-migration.notes.md
> **Checks File**: `.ai/harness/checks/latest.json`
> **Last Updated**: 2026-09-19 17:05
> **Recommendation**: pass（OP0 证据面 + OP1 探针面；G1 已裁定为第二档）
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending（切分支入库时记录）
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## 交付状态（2026-09-20 更新）

四个模块 PR 已从 draft 转为 **ready for review**，供独立判断使用：

| PR | 模块 | head → base | 合并性 | CI |
|---|---|---|---|---|
| [#210](https://github.com/Ancienttwo/byok-sdk/pull/210) | OP0 发行基线 + fork delta 分类 | `codex/official-pi-migration` → `main` | MERGEABLE | 92 checks / **0 failing** |
| [#211](https://github.com/Ancienttwo/byok-sdk/pull/211) | OP1 探针与 G1 裁定 | `codex/official-pi-op1-probes` → #210 | MERGEABLE | 92 / **0 failing** |
| [#212](https://github.com/Ancienttwo/byok-sdk/pull/212) | 架构 ADR-036 | `codex/official-pi-arch-docs` → #211 | MERGEABLE | 46 / **0 failing** |
| [#213](https://github.com/Ancienttwo/byok-sdk/pull/213) | OP2-U 定界 + OP2 核心 | `codex/official-pi-op2u` → #212 | MERGEABLE | 46 / **0 failing** |

（#211 的链接同上仓库路径 `/pull/211`。）

**CI 波动说明（避免误判）**：#210 的同一 commit `ae13c637` 曾出现**两次绿、两次红**——红的是两个 Windows 作业（`Windows Git workspace, store, and security tests (fixed Node)`、`npm release pack/install (windows-latest, fixed Node)`）。对失败作业执行 `gh run rerun --failed` 后恢复为通过，**并且同一 SHA 的更早两次运行本来就是 success**，故判定为**既有 flake**，不是本次改动引入。`main@79f6a0d3`（本分支基线）的 CI 为 success。

**未向上游提交**：owner 明确指示不向 `earendil-works/pi` 提交请求；`docs/researches/2026-09-19-official-pi-upstream-request.md` 已标记 `DO NOT FILE`。

## Human Review Card

- Verdict: pass（OP0 = 发行基线冻结 + fork delta map + 隔离安装验证；OP1 = 五项 probe + G1 裁定；本切片不切产品依赖）
- Change type: migration（OP0 证据面 + OP1 probe 面；本切片不切产品依赖）
- Intended files changed: plan（规范化登记）、contract/review/notes 三件套、`docs/researches/` OP0 两份证据产物
- Actual files changed: `plans/plan-20260919-1603-official-pi-migration.md`、`tasks/contracts|reviews|notes/20260919-1603-official-pi-migration.*`、`docs/researches/2026-09-19-official-pi-baseline.json`、`docs/researches/2026-09-19-official-pi-fork-delta-map.md`；`tasks/current.md` 为 harness 本地 read model（gitignored 内容变更）

## Findings

- F1 官方候选身份可独立复算：tarball sha512 与 registry integrity 逐字符一致，sha256 另记；SLSA v1 subject digest 与 tarball 逐字节一致；`gitHead=d981de12…`；无生命周期脚本；自带 `npm-shrinkwrap.json`（165 条目）。
- F2 fork 身份链不完整但来源可解释：三个 `@byok-sdk/pi-*` 包无 `gitHead`、attestations 404；`byokFork` 块声明的 `upstreamCommit` 等于官方 `gitHead`，文件级比对（1041 共同路径中 965 逐字节相同）证实增量有界。
- F3 fork 增量可完整枚举，20 条 delta 全部落入四种允许类别，无「复制进 vendor 算无 fork」条目。
- F4 方案 §7.1 的两处预警被实测证实：官方 `CreateAgentSessionOptions` 不声明 `fetch`；provider 层虽有 `fetch`/`onPayload`/`onResponse`，高层会话并不透传。
- F5 新增可证伪的 G1 候选路径：官方公开 `registerProvider` + `ProviderConfig.streamSimple`，且 `pi-ai` 公开导出 `./api/*`；OP1 P04 应验证「BYOK 拥有的 provider 仅包装官方 adapter 并注入 fetch」能否在发送前拒绝。
- F6 OP0 未越界：`bun.lock`、根 manifest、`packages/client/package.json` 一字未改；官方包只装到 `/tmp/pi-official-install`。
- F7 OP1 探针形态可信：现场安装官方 tarball、复制探针源码到该树、空 `HOME`、独立子进程、本地合成端点；三次运行 verdict 一致。
- F8 P04-A 证伪方案 §18 的对应风险：公开 `ModelRuntime.registerProvider` + 官方 adapter 子路径让调用方拥有 transport，且发送前观察到的 2083 字节与端点收到的字节逐字节相同。
- F9 P04-B/C 给出两个硬缺口：拒发不可传播（`prompt()` 不抛错，触发 3 次隐式 auto_retry）；`before_provider_request` 抛错拦不住发送（证实方案 §7.1）。
- F10 P02 是比预期更坏的失败模式：host 断言历史让 session 静默不发请求（0 请求、无异常），而不是报错。

## Acceptance Surface

- OP0：官方正式发行候选身份可独立复算（tarball integrity/字节 sha256）、fork 增量清单完整且分类只落在方案 §6.2 的四种类别、根依赖与 lock 未被改动。
- OP1：五项 probe 在真实官方 tarball + 独立子进程上可运行；G1 裁定有证据支撑；无实现证据处不得声明 `official_supported=true`。
- 已满足：`docs/researches/2026-09-19-official-pi-op1-probe-report.md` 记录 G1 = 第二档，五条 verdict 各有原始数字支撑，探针可一键复现。

## Residual Risk

- R1 已收窄：G1 裁定为第二档。剩余未知 = OP2-U 的上游接口能否被接受并进入可验证发行包；在此之前相关生产能力保持禁用。
- R2 官方 provider 目录数据与 fork 双向不同（openrouter 官方 366 / fork 379），切换后模型可用性会变化；首验目标 `z-ai/glm-5.3-flash` 两边都有，但需在 OP3/OP7 单独验证与披露。
- R3 `pi-agent-core`/`pi-tui`/`chord`/`pi-telemetry` 的 tarball 未下载复算 sha256（仅 registry 元数据）。
- R4 多 agent fan-out 在本环境不可用（fleet `explorer` 角色模型不在可用列表），OP0/OP1 由 main agent 内联完成；后续大范围研究需先解决该阻塞。
- R5 本轮未做平台矩阵（Windows/Linux）与 S2 新布局重验——属 OP5/OP7。
- R6 OP4 未覆盖：递归 spawn 面未验证；`registerProvider` 路径在子进程/print 模式下是否同样成立仍是未知。
