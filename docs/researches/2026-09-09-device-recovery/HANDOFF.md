# GPT Pro handoff：BYOK 0.16 接入与恢复审查

## 后续实测更新

用户批准的可归因 probe 已完成，先读
[八组对照与证据](attribution/README.md)。新实验明确证明 changed URL + 未 ACK +
无 journal 可导致旧 A 同 offer 重投；随后显式 façade dispatch B 得到 A=2/B=1。
固定 URL/journal 恢复对照均不增加 A 的 start，已 ACK 的变 URL 对照也不重投。
这不补足历史运行未记录的 URL 身份，也不表示任意 provider 副作用 exactly-once。
本 handoff 后文保留原审查时的事实与未决问题；以新报告区分已解答和仍待查项。

## 请先判断什么

请独立审查设备持久化补丁及重复执行实验，先给根因证据和最小下一刀，暂不修改或发布。
重点判断实验是否符合 SDK 已有持久恢复契约，不能从“3 次执行”直接断言 SDK Agent journal 有 bug。
请区分 host 重复 dispatch、旧 mailbox offer 重投、daemon 恢复、fixture 缺少配置这几个来源。

## 分支与当前交付

- SDK: https://github.com/Ancienttwo/byok-sdk/tree/codex/sqlite-device-persistence
- 起点 `0228973`：0.16.0 正式发布读回。
- `c83345d`：SQLite device directory + schema v2 / 显式 v1 adoption。
- `30f65c3`：仅 client maxWorkers=4 与测试验收记录。生产源码仍是 c83345d。
- AiphaBee: https://github.com/chenrenya/aip-main-open/tree/codex/byok-016
- AiphaBee `b4e77c9`：设备持久化本地测试 gate 关闭；产品 operator 接入尚未完成。
- 本 handoff 与证据随后追加在上述分支；以分支最新 commit 获取文件，不把正文 commit 当分支 tip。

没有发布新 SDK，没有为 0.16 创建本地 patch 来替换产品 pin，没有合并或生产部署。
用户已明确允许独立 SDK worktree 修改设备持久化，此前 AiphaBee AGENTS 禁令已就该范围获例外；发布及下一项业务/协议修改不由本 handoff 自动授权。

## 已完成的实现及约束

SQLite devices 与 pairing issuance/redemption 绑定同一 authority。持久化 device/proof key、capabilities/harnesses；tenant 隔离、same-machine supersession 和 revoke 删除记录。
Schema v2 防止旧 0.16 再次打开并忽略 device 表；v1 必须停止全部 writer、备份并显式设置 storage.migration='v1-to-v2'。建表与版本更新原子完成，旧任务保留，无历史身份重建。版本 fence 无法停止已经打开旧 DB 的进程，停机是 host 前提。

入口：
- packages/server/src/stores/sqlite/index.ts
- packages/server/src/stores/sqlite/device-directory.ts
- packages/server/src/stores.ts、types.ts
- packages/server/src/__tests__/sqlite-device-directory.test.ts
- packages/server/src/__tests__/sqlite-device-restart.test.ts
- packages/server/README.md、docs/spec.md
- plans/plan-20260909-sqlite-device-persistence.md
- tasks/notes/20260909-sqlite-device-persistence.notes.md

请检查 migration/schema validation 是否足够、同机器替换与 revoke 是否真正保持单一 authority、global deviceId 唯一约束与现有 driver 是否一致。不预设补丁正确，也不把 ephemeral presence 当持久授权。

## 实测事实与证据边界

1. npm 发布 0.16：真实 pair → dispatch Complete → SIGKILL → 同 SQLite/稳定 signer 重启；任务保留但 devices=[]，原 OS enrollment 被拒。见 published-016-crash-report.json。
2. candidate：原 enrollment 可重连且原 Complete task 保留；host 再次提交同一文本，得到第二个 taskId，累计执行 3 次。见 candidate-crash-report.json，原 exact-2 断言 exit 1 保留。
3. 跟踪实验：显式第二次 dispatch 前 audit count=1，之后两条 start 记录；两条都标记 explicit-dispatch phase。这个标记仅是采样时段，不能识别 task 归属。见 candidate-crash-trace-report.json。
4. 实验没有 caller request→SDK task 持久映射；SDK facade dispatch 每次创建新 taskId，所以重复 dispatch 风险与额外第三次执行须分别归因。
5. 重要 fixture 限制：config 没有显式 hostedJournal，dispatch 没有 AgentRef；fake adapter 的 sessionRef 每次 randomUUID，仅以 instruction 记录 start 副作用。没有真正 provider 执行，也没有 taskId-bound execution receipt。Complete 的服务器观察不证明 daemon 已持久记录/ACK 同一阶段。
6. 请优先审查第 5 点：先确认适用的 journal/offer family/启动契约，再决定是实验缺配置还是产品能力缺口。不要只改断言为 executions>=2，更不能自动 re-pair 或从文本猜 task identity。
7. candidate schema migration 实验使用真实发布 0.16 建立的 v1；普通 candidate open 拒绝，显式迁移成功，旧 0.16 随后拒开 v2。candidate-migration-report.json。
8. 三个 operator 在真实 public daemon/MCP 链路上 9 个行为组通过：health quarantine、脱敏/no-overwrite bundle、只归档 refused 并保留 held。它证明 SDK 基础可行性，不证明 AiphaBee 产品身份/consumer/UI 已接入。

实验创建随机 productId 和 OS 临时目录，使用真正 OS credential store 的测试 enrollment；最终均确认 unpair / 停止进程 / 删除测试状态。无 provider 调用。原 Local Agent 个人服务未替换。

## 可复现实验（从新 checkout）

先读根 AGENTS.md。需要 Node >=22.22.0、Bun、可用 OS credential store。

```sh
bun install --frozen-lockfile
bun run build
mkdir -p _ops/device-recovery-probe
cp docs/researches/2026-09-09-device-recovery/crash-dispatch.mjs _ops/device-recovery-probe/
cp docs/researches/2026-09-09-device-recovery/crash-trace.mjs _ops/device-recovery-probe/
node _ops/device-recovery-probe/crash-dispatch.mjs
```

脚本放到 _ops 执行，避免输出覆盖 tracked 证据。它通过 workspace public package exports 使用当前构建的 server/client，创建 disposable server/daemon、SIGKILL 子进程并清理。预期目前 exit 1（3 !== 2）；不是 green acceptance 脚本。crash-trace.mjs 可补 phase 观察，但仍不能归因 task。

上述复现使用 workspace build；历史报告使用 `bun pm pack` 的 server 经独立标准 npm install，client 0.16.0。不要将二者混标。历史最终 candidate server tar SHA-256：31b4256445916341bf921379aa35a0467f1f33ce0a93fb0355dfdbaafd37412b。Manifest 仍写 0.16.0 是未发布 source candidate，不是 npm 正式版本。

可从 packages/server 运行：

```sh
bunx vitest run src/__tests__/sqlite-device-directory.test.ts src/__tests__/sqlite-device-restart.test.ts src/__tests__/sqlite-composition.test.ts src/stores/sqlite/__tests__
```

## 最新验证

Server targeted 159 passed。旧失败两个 client 文件隔离 35 passed。未改配置的全测失败会转移到不同真实 I/O/daemon 用例；仅限制 client file workers 从本机默认 11 到 4 后，原始 bun run test 全部通过：3931 passed / 135 skipped。所有断言、超时、skip 规则保持不变。Build/typecheck/API-surface/version-authority/strict-workflow 通过。

并发竞争是获得支持的解释，不是对每个历史失败的完整根因证明。被跳过的环境相关测试、远程 CI、生产均不在本地证据内。不要用全量 green 覆盖仍失败的 standalone crash probe。

## AiphaBee 剩余工作

阅读 AiphaBee 分支：
- docs/researches/2026-09-09-byok-sqlite-device-persistence.md
- docs/researches/2026-09-09-byok-016-local-install-test.md
- docs/researches/2026-09-09-byok-016-operator-architecture.md
- plans/plan-20260909-0054-byok-016-operators.md

G0 仍需显式 message mode、真实 consumer、account/device/AgentRef 绑定与隐私边界。
G1c 需幂等 dispatch、恢复 handle/cancel、durable disposition。不能为了使用全部 API 自动启用原 readonly research 的消息工具，也不能构造假 device metadata 接 operator。

## 请返回

- 哪些结论已证实，哪些只是推断，哪些依赖缺失配置。
- 各次 start 的 task/offer/journal/ACK 身份链与精确失败窗口；fixture 应增加哪些证据。
- 最小的公开 SDK 组合是否已能解决；若需新 API，给出单一 authority 的契约与反例。
- 对 c83345d 补丁的具体问题（文件/位置/触发条件），及优先级。
- 一项有明确验收的下一刀。不要直接发版、合并、部署或扩大产品权限。
