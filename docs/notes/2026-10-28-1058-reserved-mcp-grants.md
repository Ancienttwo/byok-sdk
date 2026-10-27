# #1058 SDK helper 的 Codex 工具授权

初次验证基线：`494e92217f518bf9e9455b5f31180a36433efa5c`。最终集成基线：`92be29d52`（已包含 OAR 0.75.0）。本切片不关闭完整 issue。

## P1/P2/P3

daemon 注入的保留 MCP servers 经 Codex adapter 和 OAR 转成 thread config；原配置没有工具级 approval，而默认 thread policy 为 `never`，因此 Codex 在调用 helper 之前直接拒绝工具。新增 adapter beforeOpen 投影，只为当前 operation 注入的 SDK 保留 server 的固定工具写 `approval_mode: approve`。start/resume 共用这一步，并与用户 MCP exclusion 合成。

工具名集中在轻量的 `sdk-reserved-mcp.ts`，memory/team 原有导出保持相同 literal 类型。宿主服务器、同名宿主工具、用户服务器均不新增授权；没有 wildcard 或全局默认批准。成本是创建 thread 时复制有限的 server/tool 配置，扩展到十倍仍随注入 server 数量增长，不增加每次工具调用的检查。

宿主 MCP 的显式授权 API 不在本切片；原有 nativeInteractions 仍按原契约工作。因此 helper 修复不能代表 #1058 所述宿主工具需求全部完成。

## 验证

- root build、typecheck、API surface、version authority：exit 0。
- 初次基线的 7 个针对性文件：首次修正旧 helper 配置期望后为 121 passed / 1 failed / 6 skipped。失败是未修改的 requestApproval 用例在启动时收到 `app-server exited (code=null)`；相同源码单独重跑整个 `codex-adapter.test.ts` 为 67 passed / exit 0。其他 6 文件已通过。属于分段覆盖，不宣称原组合命令成功，也未确认失败根因。
- 真实 Codex 0.164.0：`BYOK_CODEX_LOOPBACK=1 bun packages/client/scripts/codex-reserved-mcp-loopback.mjs`，exit 0。隔离 HOME/CODEX_HOME、dummy API key、loopback Responses、拒绝外部连接的 proxy；SDK submit_result 实际 receipt 一次，宿主同名工具零次且返回 approval-never 拒绝。每个 case 两次本地 provider 请求，无付费调用。该证据不替代完整 daemon result-document 闭环或其他 Codex 版本的资格验证。
- 初次 native gatekeeper 未发现源码或测试断言缺陷；其当时待补的测试证据已通过后续完整定向复跑补齐。2026-10-28 在 Herdr default session 的 Claude Opus 席位 byok-s1-review 完成新 main 集成与测试/实现一致性审查，A verdict 为 PASS，无阻断缺陷；没有再次转派 reviewer。

## 测试与 golden 变化理由

`codex-adapter.test.ts` 原断言完整比较 SDK message helper 配置；新增固定 `send_agent_message` grant 是目标行为，因此只增补该字段。原 command/args/env/进程参数保密断言全部保留。新增测试覆盖四种 start/resume × exclusion 组合、部分 helper、宿主同名工具、配置保留、缺少已注入 helper 时拒绝。

Owner 已明确批准按实际变化更新 golden：`client.d.ts` 增加内部工具名/registry 声明；`entries.json` 仅更新 sealed Pi bundle 中 opaque import 的行号（95763 → 95765）。公开包导出名和类型不变，未调整任何 closure budget。

## 未完成

宿主工具 opt-in 授权接口、最终 PR CI、合并及发布分别待完成。#1051/#1059 的已有修复不包含在此 worktree。


## main 集成复验（2026-10-28）

两份上游提交无冲突合入；生产补丁语义保持原样。新基线 build/typecheck/API surface/version authority 均 exit 0，日志前缀 `/tmp/byok-1058-main-`。七文件完整定向命令为 122 passed / 6 skipped，exit 0；本次没有复现上轮审批启动退出。真实 Codex 0.164.0 loopback 再次通过：SDK helper 一次实际调用、host 零次调用并明确 approval denial。该结果仅覆盖本次运行，不把前一轮未诊断的进程退出宣称为已修复。


## CI scope mapping 签字

PR #1066 首轮 CI run `40578376946` 在 scope selection 拒绝新增 `packages/client/scripts/codex-reserved-mcp-loopback.mjs`，尚未执行下游测试。精确补入该文件，沿用现有 `codex-app-server-real.mjs` 的 client owner 映射；既有依赖图会继续展开其消费者与 dataplane，没有新增 wildcard 或修改未知脚本拒绝规则。

签字依据：2026-10-28，协调席位 **wB:p4** 按 **#1008 已有协调代签授权** 选择「批准该精确映射」。这是该映射的协调代签，不是新的 owner 产品决定。

新增回归验证两条 Codex probe 路径选择完全相同的范围，未知脚本仍被拒绝。`node --test scripts/ci/select-impact.test.mjs scripts/ci/plan-ci.test.mjs`：50 passed、exit 0，日志 `/tmp/byok-1058-ci-mapping.log`。生产源码保持冻结，最终 CI 绑定后续 head 单独核对。


## 收紧预算后的整合签字（2026-10-28）

主线审批清理收紧预算后，整合已冻结前置修复并按实际构建重新计量。协调席位 wB:p4 按 #1008 代签批准以下精确上限，无额外余量；不涉及 lane M/#1012，不放宽其他 policy。

| Entry | Budget bytes |
| --- | ---: |
| `@byok-sdk/client` | 1846427 |
| `@byok-sdk/client/adapters` | 329980 |
| `@byok-sdk/client/testing` | 315466 |
| `bin:byok-agent` | 1791069 |

entry facts 和 README 表从该组合构建再生，未手工保留 opaque import 旧行号。签字证据：`_ops/issue-lanes/1066-1067-budget-signoff.md`。


恢复 main `4159f13a1` 后重新构建：本候选 client = 1846447 B，byok-agent = 1791089 B，均只叠加 #1071 已代签的 20 B；adapters/testing 保持前表值。该组合不增加已签增量之外的余量，README/facts 再次从构建生成。
