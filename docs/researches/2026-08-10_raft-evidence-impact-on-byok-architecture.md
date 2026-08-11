# RAFT 新证据对 BYOK 架构的影响报告

> 日期：2026-08-10
> 输入：[RAFT static reference](./raft-architecture-reference.md) + [RAFT Computer CLI dynamic research](./2026-08-10_research-raft-cli-dynamic-report.md)
> 结论：**文档 authority 需校正，BYOK product truth、runtime contract 与实现无需改变。**

## 1. 执行摘要

hash-matched RAFT 1.0.15 bundle 推翻了四个旧归因：`5s/120s/3s/limit 50` 属于 agent bridge wake-hint defaults，不是 board production tuning；`task create` 实有 `--assignee`；五个 activity 值确实存在于 RAFT；`status` 在 stale-upgrade 收敛条件下可能写 marker。

这些校正降低的是外部证据强度，不是 BYOK 已交付能力的正确性。S5 的 current-row board authority、CAS、explicit capability、SSE/poll parity、reconciliation、presence TTL 与 activity dropped 均由 BYOK 自己的 contract、实现和 tests 证明。因此本轮只修正文档 provenance，不改代码、schema、route 或 wire protocol。

## 2. P1：影响地图

| 层 | Authority | 影响 | 裁定 |
| --- | --- | --- | --- |
| 产品真相 | `docs/spec.md` | 无 RAFT 依赖 | 不改 |
| canonical 架构 | `docs/architecture/sdk-architecture.md` | presence 来源、board 证据强度、timing provenance | 修正 |
| final proposal | `ARCHITECTURE-PROPOSAL-byok-platform.md` | timing 与 probe 方法写得过强 | 修正 |
| source research | `proposal-byok-platform-v2-opus.md`、`raft-architecture-reference.md` | 静态事实错误 | 修正并保留 evidence boundary |
| execution record | S5 sprint / contract / review / notes | 已交付行为不依赖 RAFT 归因 | 只补 provenance 注记 |
| runtime | `@byok-sdk/core`、`cloud`、`cloud-postgres` | 自有 contracts/tests 已成立 | 不改 |

本轮 out of scope：真实 RAFT login/attach/start、远端 server enforcement、board transport、升级 swap/rollback，以及任何 BYOK 新产品能力。

## 3. P2：一条真实 BYOK 路径

1. authenticated device 调用 board claim handler；holder identity 来自认证 device context，不接受任意 assignee 输入。
2. handler 调用 `BoardStore.claim`；InMemory 与 Postgres 实现以 CAS 产生单一 winner，loser 获得 current holder snapshot。
3. runtime terminal receipt 只能把 board item 单向投影到 `in_review`。
4. host 通过 `acceptBoardItem` 才能把 `in_review` 推到 `done`。
5. feed transport 只根据显式 `board.sse` capability 选择 SSE 或 poll；两者共享 `BoardStore.list`。
6. SSE 的 heartbeat/reconcile 是 bounded hint；120s default 可注入，reconcile 通过 full poll 修复 current-row 增量压缩。

输入 authority、CAS、review authority 与 transport selection 全在 BYOK 边界内。RAFT `task create --assignee` 不穿过这条路径；agent bridge tuple 也不参与 `ByokCloudOptions` 的默认值解析。因此新 RAFT 证据不会触发实现迁移。

对应的当前证据面：

- `packages/cloud/src/handlers/board.ts:13-16,72-88,201-233`：四个 stream defaults、authenticated device claim、query/reconcile/heartbeat loop。
- `packages/cloud/src/cloud.ts:257-285,452-469`：defaults 可注入、host create 与 host-only acceptance。
- `packages/core/src/board.ts:14-17,100-138`：assignee/status 分离、claim/status CAS contracts。
- `packages/cloud/src/__tests__/board-streams.test.ts:52-72,242-299,354-424`：tenant isolation、100-way claim、SSE/poll parity、reconcile repair、capability-only selection 与 no-downgrade。
- `packages/cloud-postgres/src/__tests__/board-concurrency.test.ts:20-38`：real Postgres 100-way single winner。
- `docs/researches/s5-board-streams-design.md:7-44` 与 `tasks/contracts/20260809-0148-s5-board-streams.contract.md:14-37`：S5 的 P1/P2/P3 authority 与 acceptance contract。

## 4. P3：决策

### D1 — 保留现有 board assignment 语义

不因 RAFT 支持 create-time assignment 而给 device route 新增任意 assignee。BYOK 当前 invariant 是 authenticated device self-claim + host-only review acceptance，避免 device 伪装他人占有工作。未来若产品需要 human/admin pre-assignment，应以独立 host capability、authorization 与 concurrency contract 落地，而不是兼容 RAFT CLI shape。

### D2 — 保留五值 vocabulary，修正 provenance

`online/thinking/working/error/offline` 同时存在于 RAFT bundle 与 BYOK。RAFT 只提供外部词汇参考；BYOK 拥有 `presence` 抽象、TTL、non-authoritative 语义及其与 execution/truth 的隔离。无需 rename 或数据迁移。

### D3 — 保留 timing defaults，撤销 production-tuned claim

5s query、120s reconcile、15s heartbeat、limit 50 保持为可注入的 BYOK 初始运营默认值。理由是现有 tests 与 failure-repair contract 已围绕这些 seams 建立，不是因为 RAFT 已在生产调优。10x 下最先承压的是每连接周期查询带来的 DB QPS；调参 authority 应来自 BYOK 的 stream count、query latency、reconcile repair rate 与 disconnect metrics。

### D4 — client evidence 不升级成 server proof

RAFT 的 server-side transition、claim winner/CAS、conflict payload、board SSE/poll 与 task truth ownership继续标 `[unverified]`。BYOK 的相应语义只引用自己的 contract/conformance tests，不再写成“沿用探针结论”。

## 5. 更新结果

- 修正 RAFT static reference 的 lock/read-write 分类与 assignee surface。
- 修正 final/source proposal 的 timing 与 probe-method provenance。
- 修正 canonical architecture 的 presence、board 与 assignment authority。
- 将历史 rewrite decision 的 E4 标成已 supersede，而不抹除历史裁定。
- 在 S5 record 中把 120s 写成 configurable BYOK default。

最终 verdict：**PASS — 架构行为保持，evidence honesty 收口；没有 schema/code migration。**
