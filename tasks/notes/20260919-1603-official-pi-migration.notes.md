# Implementation Notes: official-pi-migration

> **Status**: Active
> **Plan**: plans/plan-20260919-1603-official-pi-migration.md
> **Contract**: tasks/contracts/20260919-1603-official-pi-migration.contract.md
> **Review**: tasks/reviews/20260919-1603-official-pi-migration.review.md
> **Last Updated**: 2026-09-19 16:15
> **Lifecycle**: notes

## Design Decisions

- 执行隔离：OP0/OP1 在独立 worktree `byok-sdk-wt-official-pi`（branch `codex/official-pi-migration`，基线 `origin/main@79f6a0d`）执行，不接管 main checkout 的 recursive-s2 活动计划，也不触碰该 checkout 的用户 WIP。理由：方案 §6.1 要求独立 migration worktree；同时避免与 main checkout 的 active-plan marker 冲突。
- Plan 权威副本：owner 提供的 `plans/Official_Pi_Migration_Execution_Plan_2026-09-19.md` 在 main checkout 是未跟踪的历史输入；本 worktree 的 `plans/plan-20260919-1603-official-pi-migration.md` 是其规范化、已注册的执行权威副本（同一内容 + harness 头 + Task Breakdown/Evidence Contract/Promotion Gate/Rollback Surface）。
- 契约粒度：本契约为 OP0（证据面）切片；OP1 需要在仓库内新增 probe 实验目录与可执行脚本，属写范围扩大，按方案「OP1 单独建议 PR」另开 slice contract（或对本契约做一次显式 allowed_paths amendment），不在本切片悄悄放宽。
- 只读研究并行：OP0 的本仓消费面清点与官方 tarball 公共接口审计各派一个 fleet `explorer`（`fork_turns: none`，只读），写入仍由 main agent 串行执有。

## Deviations From Plan Or Spec

- 方案 §7 建议 OP1 紧跟 OP0；本次先把 OP0 的证据面（发行基线 + delta map）闭到可复核，再按 G1 裁定推进 OP1，因为 P01–P05 的 probe 设计依赖"官方实际 exports 面"这个 OP0 产物。
- 多 agent 并行研究未能成立：本环境的 fleet 角色（`explorer`）被钉在 `gpt-5.6-luna`，而当前 API 只接受 `deepseek-flash` / `deepseek-v4-pro`，两个 explorer 子代理都在启动时 `invalid_request_error` 退出。OP0 的本仓消费面清点与官方 tarball 审计改为 main agent 内联完成，未产生重复产物。若后续要用 fan-out，需要先解决角色模型可用性。

## OP0 事实摘要（2026-09-19）

- 官方候选 = `@earendil-works/pi-coding-agent@0.85.1`（2026-09-05 发布），GitHub main `36b60d2e` 不是发行物，未被采用。
- 官方链条完整：npm integrity、本机复算 sha512/sha256、`gitHead=d981de12…`、SLSA v1 provenance（`refs/tags/v0.85.1`，subject digest 与 tarball 一致）、无生命周期脚本、自带 shrinkwrap。
- fork 链条不完整：三个 `@byok-sdk/pi-*` 包均无 `gitHead`、provenance attestation 返回 404；但 `byokFork` 块声明的 `upstreamCommit` 与官方 `gitHead` 相同，且文件级比对（coding-agent：1041 共同路径中 965 逐字节相同）证实增量有界。
- fork 增量 = 4 个新模块（`input-preparation`、`prepared-session-input`、`provider-timeout`、`system-prompt-renderer`）+ 22 个模块改动 + 3 个新子路径导出 + LICENSE；pi-ai 侧 = `HostCanonicalAssistantMessage`/`origin` 判别位 + openai-completions 的 P(D) 结构投影 + provider 目录数据重生成。
- 20 条 delta 分类：上游缺口 14、官方替代 2、BYOK 自有职责 1、直接删除 3。
- G1 焦点收窄：**P03（纯编译）与 P04（发送 gate）**是主战场；官方 `CreateAgentSessionOptions` 无 `fetch`，但 provider 层有 `fetch`/`onPayload`/`onResponse`，且 `registerProvider` + `ProviderConfig.streamSimple` 是公开入口——OP1 要证的是这条路能否在发送前**拒绝**（而不是事后观察），且远端监听为 0。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| OP0/OP1 同一契约 | 拆两个切片 | OP1 需要在仓库内新增可执行实验目录，写范围与 OP0 证据面不同；混在一个契约会让 allowed_paths 含糊 |
| 直接在 main checkout 执行 | 独立 worktree | main checkout 有用户 WIP + 另一 active plan；契约并发规则要求不串行化无关计划 |
| 以 GitHub main@36b60d2e 作候选 | 以 npm 正式发行版为候选 | 方案 §6.1：GitHub main 的 manifest 不是已发布包证明 |
| 把官方包装进本仓 node_modules 做验证 | 只装到 `/tmp` 隔离目录 | OP0-d 要求官方安装隔离于当前根依赖；本 worktree 的 lock 与 manifest 保持未改 |

## Open Questions

- 官方正式发行版 `@earendil-works/pi-coding-agent@0.85.1`（2026-09-05 发布）与方案引用的 GitHub main `36b60d2e` 之间存在版本落差；OP0/OP1 必须回答「0.85.1 的公开接口是否已够用，还是必须等上游新发行」。未结论前不得把 main 的能力当成发行包能力。
- 官方 provider 目录数据与 fork 双向不同（openrouter：官方 366 vs fork 379）。首验目标 `z-ai/glm-5.3-flash` 两边都有，但迁移后模型可用性变化需要 OP3/OP7 单独确认与披露。

## Verification Log

- 官方 tarball identity 独立复算：`openssl dgst -sha512` 得到的 base64 与 registry `dist.integrity` 逐字符一致；sha512 hex 与 SLSA subject digest 一致。
- `git diff --check`：见收口记录。
- `repo-harness run check-task-workflow --strict`：见收口记录。
- `docs/researches/2026-09-19-official-pi-baseline.json`：`JSON.parse` 通过（见契约 Verification Plan 的 `baseline-json-parse`）。
