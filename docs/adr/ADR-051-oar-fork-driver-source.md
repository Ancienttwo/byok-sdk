---
schemaVersion: archcontext.adr/v1
title: runtime 协议驱动来自 OAR fork，BYOK 改动是 fork 分支上的 commit 序列
status: accepted
decidedAt: 2026-11-11
appliesTo:
  - sdk-root
---

# ADR-051：OAR fork 作为 runtime 协议驱动的来源

> **来源**：parent issue [#1851](https://github.com/Ancienttwo/byok-sdk/issues/1851)（owner 2026-11-11 的决定和批准）；做法见 [#1852](https://github.com/Ancienttwo/byok-sdk/issues/1852) 和其上的 planner `decision` 评论。
> **例外的依据**：Pi 见 [#1855 的 decision 评论](https://github.com/Ancienttwo/byok-sdk/issues/1855#issuecomment-6799690796)；Hermes 见 [#1854](https://github.com/Ancienttwo/byok-sdk/issues/1854) 的第一条评论和 body。
> **关联**：`packages/client/vendor/oar/45488e7/PROVENANCE.md`（改动清单、bump 流程）、`scripts/ci/oar-sync.mjs`。

状态：已决定。本 ADR 随 #1852 合入；Claude 驱动的迁移（#1853）和 Hermes adapter 的封存（#1854）各自落地。

## 1. 背景

SDK 的 runtime 驱动有两种来源：Codex、Grok、OpenCode、Antigravity、dsh 取自 `packages/client/vendor/oar/` 里的 OAR 拷贝；Claude、Hermes、Pi 由 SDK 自己写。OAR 的拷贝是一份文件快照，22 个文件带 BYOK 改动，每次换上游版本都要从上游新字节开始把改动手工重套一遍。上游走得快（2026-10-01 是 0.10.2，钉住的 `45488e7` 是 0.94.0），而 owner 只能以 fork 的方式维护 OAR：上游不一定收 PR，但会修 issue。

## 2. 决定

### D1. 驱动来源

每个 runtime 的协议驱动（起进程、读写协议、把原生事件折成 session 记录）来自 OAR fork `Ancienttwo/oar`。SDK 的 adapter 只留 SDK 自己的东西：能力声明、到 SDK 记录的投影、凭证保管、隔离、工具授权。例外只有 D4 列出的两项。

### D2. fork 的形状

- BYOK 改动写在 fork 的分支 `byok/<上游版本>` 上，分支从上游的 release commit 切出。一条不变量一个 commit，commit message 第一行写不变量，最后一行写上游去向。
- `packages/client/vendor/oar/<上游短 sha>/` 是这个分支的投影：清单里的文件和 manifest 的 hash、`commit`、`fork` 字段只由 `scripts/ci/oar-sync.mjs` 写。manifest 同时记上游 commit 和产出这些字节的 fork commit。
- 必需 CI 不联网：它按 manifest 的 hash 检查 vendor 字节。脚本输出等于 vendor 目录，是 bump 时由操作者跑的检查。
- 换上游版本时复制分支再 rebase，得到下一个 `byok/*` 分支；已发布的 `byok/*` 分支不 force-push。流程写在 `PROVENANCE.md` 的「Authoring path and bump procedure」。

### D3. 改动的五类不变量和减少改动的路

fork 上的改动都归在下面五类不变量之下：

1. 进程由调用方持有：spawn 由 SDK 注入，进程树归 SDK 的 process-tree authority。
2. 环境变量只用显式传入的，不合并宿主环境。
3. 权限请求没有放行的默认值。
4. 每条 record 都交给 SDK 的 consumer。
5. 由文本规则选出的 failure class 要标记（`fromText`），SDK 把它当 `unknown` 发出。

减少改动靠向上游提 issue，不靠 PR 合入。每处改动标明上游去向：上游提供一个注入点或选项后可以去掉的，对应一份上游 issue 草稿（由 owner 或 owner 授权的 seat 提交）；BYOK 自己的策略标 `Upstream: none`，留在 fork。上游修了，下一次 bump 丢掉对应的 commit。

### D4. 例外

- **Pi 和 pi-durable 留在 SDK**，没有退出条件。SDK 自己就是 Pi 的 host：把 Pi 当库嵌进自己的进程，在 `packages/client/src/bin/pi-rpc-host.ts` 装 extension；上游 OAR 的 pi 做的是同一层的事，没有调用方注入 extension 的口子，凭证从 Pi 的 agent dir 读，子进程环境从 `process.env` 起算，也没有 prepared lane。这个例外保护的不变量：provider key 只经一次性私有 IPC 进 host 的内存，子进程只看到显式环境；每次工具调用过 SDK 的授权 hook，文件范围和 subagent 闸门作为 SDK extension 装入；prepared 和 durable 两条 lane（按 execution 的副本、和 lease 绑定的写锁、重启预算）。
- **Hermes 不搬到 fork，runtime adapter 封存**（#1854）。删除前在 `train/next-minor` 最后一个带 adapter 的 commit 上打 tag `archive/hermes-runtime-adapter`。重启条件：上游 OAR 提供 hermes runtime，或者有产品要用 Hermes runtime。恢复时从 tag 取代码，按本 ADR 的规则走 fork。

## 3. 对下游的约束

| 约束 | 保护的不变量 | 下游怎么在约束内做同一件事 |
|---|---|---|
| vendor 目录里清单列出的文件和 manifest 的 hash 不手改 | 一个改动只有一个编写处，vendor 字节能追到 fork 上的某个 commit | 在 fork 的 `byok/*` 分支上加或改 commit，再跑 `oar-sync.mjs` |
| fork 里新增的代码放新文件；上游文件只为 `PROVENANCE.md` 列出的不变量而改 | 每处改动能单独 rebase、单独丢掉，bump 的冲突落在一条具体的不变量上 | 新行为写成新文件，由 SDK adapter 或 fork 的新文件组合上游的函数；确需改上游文件时，先在「Maintained deltas」加一条不变量 |
| 已发布的 `byok/*` 分支不 force-push | 旧的 pin 仍能复现 | 修正写成新 commit，或在下一个 `byok/*` 分支里改 |
| 新 runtime 的驱动不在 SDK 里另写 | 驱动只有一个来源，换上游版本时一起 bump | 把上游的 runtime 选进 fork；上游没有的，先向上游提 issue，或者按 D4 的写法由 owner 定一个带不变量的例外 |
| 搬驱动不放宽凭证隔离和 approval 完整性，不改 `*_RUNTIME_CAPABILITIES` 的值和 runtime-contract 的断言 | 现有 Host 看到的行为和能力不变 | 保不住的能力作为 boundary question 回到 #1851 |

## 4. 不在本 ADR 内

- 把线上协议统一成 ACP：owner 放弃了这个方向，上游 OAR 自己对 Claude、Codex、Pi 也用原生通道。
- 能力声明里的「保证等级」：owner 还没有决定。
