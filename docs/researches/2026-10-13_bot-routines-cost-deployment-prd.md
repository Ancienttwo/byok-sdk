# PRD：BYOK Bot routine、成本模型与部署目标

> 初版：2026-10-13。
> 状态：待 owner 批准。PR 合并即批准本文的需求、K2 契约草案和路线图。合并不授权实现、发布、issue 修改或下游迁移。每个切片单独开 issue 和 PR。
> 权威关系：[docs/spec.md](../spec.md) 是产品权威。本文只定义计划中的变化。每个切片落地时，在同一个 PR 中修改 spec。决策另记在 [ADR-038](../architecture/adr-2026-10-13-byok-cost-and-deployment.md)。
> 依据：byok-sdk `main@c3ca6a84`；首个下游 Aiphabee `main@31b7280e`；RAFT Computer 的 reminder 实现（`botiverse/raft-source`）。

## 1. 结论与问题

BYOK Host 需要定期运行的 Bot 工作，下文称 routine。例如每个交易日检查一次自选股，或每周整理一次研究笔记。

现状有四个问题：

- SDK 没有设备端定时能力。Host 只能自己写调度循环。Aiphabee 现在有两个：`LocalResearchMonitorScheduler` 和 `LocalWatchlistScheduler`。
- `@byok-sdk/cloud-do` 有 inbox 和 alarm，但只用平台 key（[ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md) D2）。BYOK routine 不能用它。
- 存储是收费单位。可是 mailbox 字节从不记账，mailbox 配额从不生效（[#411]）。
- 设备空闲时，hosted 真相层仍每 250 ms 读一次 mailbox（[#410]）。ADR-036 D7 还写着"Cloudflare 优先，Node + Postgres 仅预留"。

方向：执行在设备上，用用户自己的 key 或 runtime。时钟也放在设备上。云端只做真相层。SDK 不计量执行，收费单位是超额存储。部署以 VPS 为优化目标，Workers 继续可用。

| 判断 | 状态 |
|---|---|
| 方向成立 | 是。符合 ADR-036 D3：BYOK key 只在本地。 |
| 可以开始实现 | K1 和 K3 已有 issue，范围清楚。K2 要先按 §7 开新 issue。每个切片的实现仍由 owner 逐个放行。 |
| 可以上线 | 否。需要 K1–K3 落地，并且首个下游通过 §12 的验收。 |

## 2. Owner 决策

owner 已定（2026-10-13）：

| # | 决策 |
|---|---|
| O1 | BYOK routine 不需要官方 key。云端是真相层，保存定义、结果投影和可见性状态。执行和时钟在设备上，用用户自己的 key 或 runtime。 |
| O2 | 不按 token、流量或执行次数计费。收费单位是超出存储额度的部分。平台成本主要是存储和服务器。 |
| O3 | 先完成 byok-sdk 的改动，再由下游 Host 接入。Host 不重建 SDK 负责的层。 |
| O4 | 部署以 VPS 为优化目标，因为 Workers 在流量大时成本高。SDK 同时支持 VPS 和 Workers。 |

本 PRD 提出，合并即批准：

| # | 决策 |
|---|---|
| O5 | O4 的"同时支持"覆盖真相层：`@byok-sdk/cloud` 和 `@byok-sdk/cloud-dataplane`。`@byok-sdk/cloud-do` 保持只在 Cloudflare 上运行。它只用平台 key，BYOK 产品不走它。 |
| O6 | 设备端时钟由 embedded server 的 wake 队列提供（K2，§7）。队列只接收一次性的时间点。周期规则留在 Host。 |
| O7 | hosted 真相层不为 routine 计时：没有 cron，没有 DO alarm，没有服务端定时器。 |
| O8 | O1 的例外：设备上没有 Host 进程的 Host（§6 的 Topology H）可以用自己服务端的定时器提交 recurring 执行。执行仍在设备上，用用户的 key。理由：这类 Host 在设备上没有地方运行时钟。 |

## 3. 目标用户与成功标准

- Host 开发者：按一套规则实现 routine。定时、崩溃恢复和去重不需要自己写。
- 最终用户：Bot 按计划运行。设备休眠后只补跑一次。错过和离线状态可见。
- 平台运营者：成本主要随存储增长。空闲设备只产生低频的兜底读取。

成功标准：

1. 设备休眠三天后醒来，每个 routine 只补跑一次，错过的时点不补齐。
2. 一个 occurrence 只对应一个 execution identity。进程崩溃或响应丢失后，Host 读回同一个 offer，不启动第二次执行。
3. 用户 key 不离开设备。hosted API 不接受用户模型凭据。
4. Node + Postgres 部署中，空闲设备的 `GET /byok/events` hold 只按兜底间隔读取 mailbox，不再每 250 ms 读取。
5. mailbox 用量计入存储用量。超过 `mailboxLimitBytes` 的追加返回 `storage_quota_exceeded`。有流量的租户也能完成保留清理。
6. SDK 不新增按 token、流量或执行的计量 API。推理用量仍只是遥测。
7. 真相层的新端口都有 Node 实现和测试。Workers 入口继续通过 `worker-packaging` 测试。

## 4. 范围

### 纳入

- K1：存储记账与保留（[#411]、[#412]）。
- K2：embedded server 的设备端 wake 队列（新 issue，契约见 §7）。
- K3：空闲成本（[#410]、[#391]）。
- K4：routine 冒烟测试、Host 指南独立成文、设备端中间产物保留（扩展 [#418]、[#399]）。
- ADR-038：成本模型与部署目标。它部分取代 ADR-036 D7。

### 不纳入

- `cloud-do` 的 VPS 版本（O5）。
- hosted 真相层里的 routine 时钟（O7）。
- 任何执行计量，以及具体价格和额度。价格和额度是产品决定。
- 自由指令的 routine。routine 类型由 Host 定义。
- 消息和回调进入 wake 队列。ADR-036 研究稿 §8.2 的统一 inbox 收窄为只处理时间点。消息仍走现有 dispatch 路径。
- presence 规则统一（[#413]）和 SQLite 锁机制替换（[#414]）。[#403] 已经合并了另一种实现，剩余范围由 owner 另行决定。
- 下游 Host 的整体部署迁移，例如 Aiphabee 从 Workers 迁到 VPS。

## 5. 权责与不变量

| 对象 | 权威 | 说明 |
|---|---|---|
| Routine 定义、版本、lifecycle | Host 服务端 | 设备保存镜像。 |
| Occurrence 账本、重试、补跑策略 | 设备上的 Host 进程 | 见 §6 的 Topology L。 |
| 定时与崩溃后的重新投递 | SDK embedded server 的 wake 队列（K2） | 只知道时间点，不解释周期规则。 |
| Execution | SDK：`recurring.submit`、`dispatchFreshAgentEgress` | 每个 Agent home 同时只有一个 writer。 |
| 结果投影 | Host | 从设备上传到 Host 服务端，按投影 id 去重。 |
| 存储用量与额度 | SDK `QuotaStore` | 收费只读 entitlement 和用量。 |

不变量：

- I1：用户 key 只在设备上（ADR-036 D3）。
- I2：周期规则只在 Host。SDK 只接收时间点。spec 已经写明 "Recurring schedules remain Host-driven; the device does not interpret cron"（[Durable Pi lane](../spec.md#durable-pi-lane-experimental-flag-gated)）。
- I3：每个 occurrence 只有一个 execution identity。只在 §10.4 第 9 条列出的情况下换新一代 `taskId`。
- I4：唤醒只是提示，持久化的行才是事实。唤醒丢失只会推迟工作，不会丢失或重复工作。#410 用同一条规则。
- I5：mailbox 字节只有一个权威：保留的行（#411）。
- I6：推理用量只是遥测，不作为 billing、quota 或 entitlement 的依据（[Terminal inference usage observation](../spec.md#terminal-inference-usage-observation)）。
- I7：hosted 真相层不为 routine 计时（O7）。

## 6. 端到端流程

### Topology L：Host 在设备上有进程（主路径）

Aiphabee 属于这一类。它的 local agent 在同一个进程里运行 embedded server（SQLite）和 daemon（Aiphabee `apps/local-agent/src/research-pass-host.ts`）。

```text
Host 服务端（定义真相）             设备上的 Host 进程（embedded server + daemon）
  routine r1 定义 v3 ──设备拉取──▶ 镜像 ──▶ 计算下一个时点 t
                                           │
                                           ▼
                                server.wakes.schedule({ dedupKey: "r1:v3:t", availableAt: t })
                                           │   SQLite 持久化；只有一个定时器
                                           ▼   到期
                                wake hook ──▶ Host 账本事务：
                                                1. 插入 occurrence（key 唯一）
                                                2. 从当前时间计算下一个时点 t'
                                                3. wakes.schedule("r1:v3:t'")
                                           │
                                           ▼
                                server.recurring.submit(input)，taskId 由 occurrence 派生
                                           │
                                           ▼
                                daemon 用用户的 key 执行 ──▶ messageEgress ──▶ Host 结果 outbox
  结果投影 ◀──────────────上传（幂等）───────────────┘
```

步骤：

1. Host 从服务端拉取定义，保存镜像。
2. Host 计算下一个时点，调用 `wakes.schedule`。`dedupKey` 包含 routine、定义版本和时点。
3. 时点到期后，SDK 调用 Host 的 wake hook。
4. hook 在一个事务里写 occurrence 和下一个时点 t'。t' 从当前时间算起。事务提交后，hook 调度下一次 wake。
   - 重复投递时，occurrence 已经存在。hook 读取账本里的 t'，不重新计算，然后再次调度。`dedupKey` 相同，所以不会产生第二个待投递的 wake。
5. hook 用由 occurrence 派生的 `taskId` 调用 `recurring.submit`。提交前先持久化完整输入。
6. daemon 用用户自己的 key 执行。结果经 `messageEgress` 回到 Host。
7. Host 把结果写入 outbox，然后上传到服务端。

设备休眠时，wake 不会运行。设备醒来后，过期的 wake 立即投递一次。hook 比较 `availableAt` 和当前时间。延迟超过 Host 定义的阈值时，hook 把这次记为补跑（trigger 为 `catch_up`），并从当前时间计算下一个时点。每个 routine 只有一个待投递的 wake，所以补跑只发生一次。

### Topology H：Host 在设备上没有进程

例如 Host 服务端在云端，设备只运行 SDK daemon。这时 Host 用自己服务端的定时器，按时调用 `submitRecurringExecution(tenant, input)`。执行仍在设备上，用用户的 key。SDK 的 hosted 真相层不提供定时器（O7）。设备离线时，这次执行要等设备上线。

这是 O8 定义的例外。这种调度属于 Host 自己的业务：spec「Execution receipts, bounded startup and custom harness identity」一节写明 "Business scheduling and device choice stay with the host"。本 PRD 的主路径是 Topology L。

## 7. K2 契约草案：embedded server 的 wake 队列

### 7.1 位置

- 包：`@byok-sdk/server`。memory 和 SQLite 两种组合都提供。memory 组合重启后丢失 wake，不能用于需要 routine 的部署。
- 不进入 `@byok-sdk/cloud` 的 kernel 端口，所以 hosted 部署没有这个能力（O7）。
- SQLite 组合把 schema 从 4 升到 5，新增一张表（`packages/server/src/stores/sqlite/index.ts` 的 `SQLITE_SCHEMA_VERSION`）。升级沿用现有的显式 adoption 规则：先停止所有 writer，再备份。
- 单一 owner 由 [#403] 保证。同一个数据库文件第二次打开时抛出 `SqliteOwnershipError`，所以一个 wake 只由一个进程投递。

### 7.2 API

wake hook 是 `createByokServer` 的选项，形状和 `agentMessage` 一致：异步，至少投递一次，由产品持久去重。

```ts
interface CreateByokServerOptions {
  /** 至少投递一次。Host 必须按 dedupKey 或自己的 occurrence key 持久去重。 */
  wake?: (wake: DueWake) => Promise<void>;
}

interface ByokServer {
  readonly wakes: {
    /** 没有配置 wake hook 时抛出 WakeHookMissingError，不写任何行。 */
    schedule(input: WakeScheduleInput): Promise<WakeScheduleResult>;
    /** 删除 queued 状态的 wake。返回是否删除了一行。 */
    cancel(dedupKey: string): Promise<boolean>;
    /** queued 和 delivering 状态的 wake，按 availableAt 排序。 */
    pending(): Promise<readonly WakeRecord[]>;
  };
}

interface WakeScheduleInput {
  /** 1–256 个字符，由 Host 定义，例如 `routine:<id>:<version>:<slotMs>`。 */
  dedupKey: string;
  /** epoch 毫秒。最多比当前时间晚 366 天。 */
  availableAt: number;
  /** 不透明的 Host 关联数据，最多 4 KiB。 */
  payload?: string;
}

interface WakeScheduleResult {
  wakeId: string;
  /** 新建为 true；同一个 key 已经存在并且内容相同为 false。 */
  accepted: boolean;
}

interface DueWake {
  wakeId: string;
  dedupKey: string;
  availableAt: number;
  /** 本次投递时的墙钟时间。 */
  deliveredAt: number;
  /** 第几次投递，从 1 开始。 */
  delivery: number;
  payload?: string;
}

interface WakeRecord {
  wakeId: string;
  dedupKey: string;
  availableAt: number;
  state: 'queued' | 'delivering';
  deliveries: number;
  /** 上一次 hook 拒绝时的错误消息，最多 1 KiB。 */
  lastError?: string;
  /** hook 拒绝后的下一次投递时间。 */
  retryAt?: number;
  payload?: string;
}
```

### 7.3 语义

1. `schedule` 按 `dedupKey` 幂等：
   - 同一个 key，`availableAt` 和 `payload` 相同：返回原来的 `wakeId`，`accepted: false`。
   - 同一个 key，内容不同：抛出 `WakeConflictError`。
   - 投递完成的 wake 保留 7 天，用于去重。所以 Host 重新调度一个已经投递过的 key 时，不会再次触发。
2. 投递：
   - SDK 只用一个定时器，指向最早的投递时间。投递时间是 `availableAt`，被拒绝过的 wake 用 `retryAt`。队列为空时不设定时器。
   - 每次最多等待 60 秒，然后用墙钟和 `availableAt` 比较。理由：系统休眠时单调时钟可能不前进，一个长定时器会晚到。这个上限让设备醒来后最多晚 60 秒投递。
   - 到期的 wake 按 (投递时间, `wakeId`) 的顺序逐个投递给 hook。
   - hook resolve：wake 完成。
   - hook reject：wake 回到 `queued`。SDK 把 `retryAt` 设为 60 秒后，不修改 `availableAt`。其他到期的 wake 照常投递。SDK 不限制投递次数，只记录 `deliveries` 和 `lastError`。重试上限和放弃由 Host 的账本决定。
3. 崩溃恢复：启动时，`delivering` 状态的 wake 回到 `queued`，然后重新投递。投递语义是至少一次。hook 必须幂等：Host 用 occurrence key 去重；`recurring.submit` 遇到已经投递的重复输入时返回冲突，要求精确读回，不创建新的执行（[Host exact Agent message disposition readback](../spec.md#host-exact-agent-message-disposition-readback)）。
4. 过期的 wake：SDK 不丢弃过期的 wake。设备醒来后立即投递，`deliveredAt - availableAt` 就是延迟。是否补跑，是否记为 missed，都由 Host 决定。
5. 取消：`cancel(dedupKey)` 只删除 `queued` 的 wake。`delivering` 的 wake 不中断，所以 hook 要自己检查 routine 是否已经暂停。
6. hook 不能等待执行结束。它只写账本、调度下一次 wake、提交执行，然后返回。否则逐个投递会阻塞其他 routine。
7. 清理：wake 端口提供有界的 `collectExpired(now, limit)`，删除完成超过 7 天的记录。server 在启动时和每批投递后调用它。#412 的 `runMaintenance` 落地后，也调用同一个方法。

### 7.4 与研究稿 §8.2、cloud-do 的差异

| 项 | ADR-036 研究稿 §8.2 统一 inbox | cloud-do inbox | K2 wake 队列 |
|---|---|---|---|
| 来源 | message、schedule、callback | message、schedule、invocation | 只有时间点 |
| 周期规则 | `bot_schedule` 表，cron 或单次 | 无，单次 | 无，单次；规则在 Host |
| 过期 | 未定义 | `expiresAt`，默认 `availableAt` 加 1 天 | 无；过期的 wake 也投递 |
| 最远时间 | 未定义 | 30 天 | 366 天 |
| 合批 | 无 | 一次唤醒最多 16 项 | 无，逐个投递 |
| 执行 | daemon 直接启动 execution | DO 内执行，平台 key | 回调 Host，Host 用 `recurring.submit` 提交 |

两处差异的理由：

- 去掉 `expiresAt`：Host 只在 hook 里调度下一次 wake。如果 wake 在设备休眠时过期并被丢弃，下一次 wake 就不会产生，routine 会停止。
- 最远时间 366 天：每月和每年的 routine 超过 30 天。上限只用来发现时间单位错误。

### 7.5 K2 验收

- 同一个 key、同样的内容调度两次，只有一行；内容不同时抛出 `WakeConflictError`。
- 没有 wake hook 时，`schedule` 抛出 `WakeHookMissingError`，不写行。
- 到期的 wake 按顺序逐个投递。
- hook reject 后，60 秒后再次投递（假时钟）。
- 进程在 `delivering` 状态被 SIGKILL：重启后再投递一次；Host 按 occurrence key 去重，只有一个 execution。
- 墙钟前跳 3 天、单调时钟不动（注入时钟）：60 秒内投递一次，`availableAt` 保持原值。
- 队列为空时没有定时器，也没有周期唤醒。
- 第二个进程打开同一个数据库：`SqliteOwnershipError`。
- schema 4 的数据库没有显式 adoption 时，新版本拒绝启动；adoption 后保留已有数据。
- `collectExpired` 只删除完成超过 7 天的记录，每次不超过 `limit` 行。

## 8. 成本模型

### 8.1 收费单位

- 收费单位是超出 `TenantStorageEntitlement` 的存储。相关字段：`hardLimitBytes`、`mailboxLimitBytes`、`retentionPolicyId`、`downgradeGraceUntil`。
- 准入不变量：`committed + reserved + expected <= hardLimitBytes`（`packages/cloud-dataplane/src/stores/core/quota.ts`）。
- 价格和额度大小由产品决定。
- SDK 不计量 token、流量或执行（I6）。

### 8.2 服务器成本的设计规则

- R1：hosted 真相层不为 routine 计时（O7）。
- R2：空闲设备的数据库读取由唤醒驱动。兜底间隔只用来保证正确性，#410 建议默认 5 秒。
- R3：每个 Host 设计都要算出"每台空闲设备每分钟的服务器调用数"。目标是每 60 秒最多一次轻量调用。定义和命令用一个带版本的条件请求同步，不为每类数据各开一个轮询路由。
- R4：存储用量只有一个权威。有流量的租户也能完成保留清理（#411、#412）。

### 8.3 首个下游的现状

Aiphabee 现在和本节冲突（`main@31b7280e`）：

- `LOCAL_SUBSCRIPTION_OPERATION_POLICIES` 对 4 类设备端执行收 credits：`connector_test` 1、`mcp_tool_call` 5、`research_monitor_cycle` 20、`watchlist_check` 20（`packages/local-execution-protocol/src/index.ts:45-62`）。每次计费操作还会调用服务器：开始时 authorize，运行中每 60 秒一次 heartbeat，结束时 finish。
- 空闲设备每 60 秒至少调用 3 次 Worker，没有前置条件：`getBotBootstrap`、`getResearchMonitorBootstrap`、`registerResearchProjectionKey`（`apps/local-agent/src/connected.ts`）。最后一个每次都注册同一个 key。

调整见 §11.2 的 A1 和 A4。

## 9. 部署目标

### 9.1 现状

| 包 | Node / VPS | Workers |
|---|---|---|
| `@byok-sdk/cloud` | 支持（Hono） | 支持 |
| `@byok-sdk/cloud-dataplane` | 根入口：Postgres（`pg`）、R2/S3 对象存储、迁移、清理和维护 | `runtime` 入口：`nodejs_compat` + Hyperdrive + R2。每次测试都 dry-run `wrangler deploy`。迁移和维护不在这个入口里。 |
| `@byok-sdk/server` | 支持（`@hono/node-server`，memory 或 SQLite） | 不适用 |
| `@byok-sdk/cloud-do` | 不支持 | 只在 Cloudflare 上（Durable Objects） |

依据：[cloud-dataplane README「Deployment compositions」](../../packages/cloud-dataplane/README.md#deployment-compositions)、`packages/cloud-dataplane/src/runtime.ts`、[README「Choose a composition」](../../README.md#choose-a-composition)。

### 9.2 规则

1. VPS 是优化目标和主测试目标。参考组合：Node 24、`@byok-sdk/cloud`、`cloud-dataplane` 根入口、Postgres、S3 兼容对象存储。
2. Workers 继续支持。保留现有的 `worker-packaging` 和 `worker-e2e` 测试。
3. 新端口先有 Node 实现。Workers 实现可以晚一些，或者明确降级。例如 #410 的 `MailboxWake`：Node + Postgres 用 `LISTEN/NOTIFY`；Hyperdrive 不支持 `LISTEN/NOTIFY`，所以 Workers 按兜底间隔读取。
4. 维护任务（#412）只有一个入口。VPS 上由进程内计划或系统定时器调用；Workers 上由 Cron Trigger 调用。
5. `cloud-do` 保持只在 Cloudflare 上运行（O5）。

### 9.3 对 ADR-036 D7 的修订

D7 写在 cloud generic agent 的 ADR 里，原文是"Cloudflare 优先（DO / DO SQLite）；Node + Postgres 仅预留接口、不实现"。Postgres 真相层（`cloud-dataplane`）已经实现，和"仅预留"不一致。ADR-038 把 D7 限定为 `cloud-do` 的 backend，并把真相层的部署目标改为 §9.2。

## 10. 下游 Host 指南

本节是通用规则。K4 把它整理成独立的英文 Host 文档，并从 README 链接。

### 10.1 模型

| 对象 | 内容 | 权威 |
|---|---|---|
| Routine | 做什么、什么时候（规则和时区）、目标 Agent、结果去向、lifecycle、定义版本 | Host 服务端；设备保存镜像 |
| Occurrence | 一个计划时点：trigger、尝试次数、结算 | 设备上的 Host 账本 |
| Execution | 一个 SDK task：offer、attempt、terminal | SDK |

例子："每个交易日 09:00 检查自选股"是一个 routine。"2026-10-14 09:00 那次检查"是一个 occurrence。运行这次检查的 SDK task 是一个 execution。

### 10.2 时钟

- Topology L：用 K2 的 wake 队列。K2 之前，Host 自己的定时器要满足 §7.3 的同样语义。
- Topology H：用 Host 服务端的定时器调用 `submitRecurringExecution`（O8）。
- 在任何拓扑中，都不在云端执行 BYOK 工作，也不在服务端保存用户的模型 key。

### 10.3 定义与命令

1. 服务端保存不可变的定义版本。每次修改产生一条命令回执，用 state version 做 CAS。
2. 每个 routine 同时最多一条待应用命令。上一条没有确认之前，新命令返回 `409`。
3. 设备用设备凭据拉取命令。拉取并入已有的同步调用，并按版本做条件响应（R3）。
4. 设备先持久化回执，再应用命令，最后确认。同一个命令 id 返回同一个确认。过期的版本返回 `version_conflict`，设备不做合并。
5. 命令不经过浏览器。没有打开浏览器时，routine 也要能同步。
6. 定义版本变化后，先完成当前 occurrence，再切换到新版本。

### 10.4 Occurrence 与 execution

1. `occurrence_key = SHA-256(routine_id, definition_version, trigger)`。trigger 包含类型（`scheduled` 或 `catch_up`）和计划时间。这个 key 在账本中唯一。
2. 写 occurrence 和推进下一个时点在同一个事务中完成。下一个时点从当前时间算起。错过的时点跳过。休眠后只补跑一次。
3. quiet hours 内的时点推迟到 quiet hours 结束，不丢弃。
4. 尝试次数有上限，例如 3 次，间隔至少 5 分钟和 15 分钟。下一个时点到期时，旧的重试作废。
5. 每个 routine 最多一个执行中的 occurrence 和一个待执行的 occurrence。
6. 时区存在定义里。用一个纯函数计算时点，设备和服务端共用。这样两边算出同样的期望时间。
7. `taskId` 由 occurrence 和 pass 派生，不含尝试次数。提交前持久化完整输入。
8. 不确定提交是否成功时，用 `server.tasks.offer(taskId)` 读回，和持久化的输入比较，然后用同样的输入恢复。不生成新的 `taskId`。
9. 只在以下情况换新一代 `taskId`：
   - daemon 拒绝执行，原因以 `agent home busy:` 开头；
   - 取消超时，并且没有结果；
   - execution 以失败结束，并且尝试策略允许再试一次。

### 10.5 并发

- 每个 Agent home 同时只有一个 writer attempt（[Durable Agent homes](../spec.md#durable-agent-homes)）。第二个 writer 被拒绝，原因以 `agent home busy:` 开头，可以重试。
- Host 按 Agent 排队，FIFO，等待时间有上限。不要依赖 daemon 排队。

### 10.6 结果

- recurring 提交要求 payload 带 `runtime`、`messageEgress` 和 `terminalProjection`（`packages/cloud/src/recurring.ts`）。所以每次执行都会给 Host 的 message consumer 产生一条消息。"没有变化就不通知"是 Host 的投递过滤，Agent 本身不能保持沉默。
- 结果和待上传记录在一个事务里写入 outbox。上传可以重试，服务端按稳定的投影 id 去重。

### 10.7 Lifecycle

- 只存三个值：`active`、`paused`、`completed`。
- `paused` 阻止新的 occurrence，同时调用 `wakes.cancel`。正在执行的 occurrence 继续完成。要停止它，显式调用 `server.tasks.cancel(taskId, reason)`。
- `completed` 结束后续调度，保留历史。删除走单独的隐私流程。
- "已到期"在读取时由结束条件推导，不存储。

### 10.8 可见性

服务端在读取时推导两类状态，不运行 watchdog 或 cron。

同步状态：

| 状态 | 条件 |
|---|---|
| `synced` | 已应用版本等于当前版本，最后一次确认是 applied |
| `pending_sync` | 已应用版本为空或较旧，命令还没有确认 |
| `sync_failed` | 设备拒绝了命令。显示设备给出的错误码 |

运行健康只对 `active` 并且 `synced` 的 routine 计算：

| 状态 | 条件 |
|---|---|
| `device_offline` | 设备最后一次同步早于约 3 个同步间隔 |
| `missed` | 期望时间加宽限期已经过去，并且没有在期望时间之后完成的结果 |
| `on_schedule` | 其他情况 |

- 期望时间：取当前版本最后一个结果里的下一个时点。还没有结果时，用共享的时点函数从定义计算。
- 宽限期：至少是一个 occurrence 最长耗时的两倍。耗时包括同步间隔、排队等待和执行超时。
- 服务端只需要多存一个字段：设备最后一次同步的时间。这个字段的写入可以节流，例如距离上次写入超过一个同步间隔才写。

### 10.9 成本与凭据

- 不计量执行（O2）。
- 每台空闲设备每 60 秒最多一次轻量调用（R3）。
- 不用官方 key，不在服务端保存用户 key，不用 `cloud-do` 运行 BYOK 工作。

### 10.10 检查清单

- [ ] 定义和命令在服务端，有版本和 CAS。
- [ ] 设备拉取命令，同步不需要浏览器。
- [ ] 设备先持久化回执，再应用命令。确认是幂等的。
- [ ] occurrence key 唯一。下一个时点在同一个事务中推进。
- [ ] 错过的时点跳过，休眠后只补跑一次。
- [ ] 尝试次数有上限，旧的重试会作废。
- [ ] `taskId` 由 occurrence 和 pass 派生。提交前持久化完整输入。
- [ ] 不确定的提交用读回恢复，不生成新的 `taskId`。
- [ ] 每个 Agent 有 FIFO 队列，等待时间有上限。
- [ ] 暂停阻止新的 occurrence，取消正在执行的工作需要显式调用。
- [ ] 结果和上传在同一个 outbox 事务里。
- [ ] 同步、离线和错过状态在读取时推导。
- [ ] 每台空闲设备每 60 秒最多一次轻量服务器调用。
- [ ] 没有官方 key，没有服务端 key 托管，没有执行计量。

### 10.11 与 RAFT 的对照

RAFT 也把时钟放在执行端：服务端管理 reminder 的生命周期和周期规则，Computer 持有定时器和唤醒，服务端的 watchdog 从不触发 reminder。差异如下：

| RAFT | 本指南 |
|---|---|
| 服务端推送更新；`armState` 和 watchdog 补推设备没有确认的行 | 设备按版本拉取；服务端在读取时推导状态，没有 watchdog |
| 晚到的触发从 `max(slot, now)` 推进：补跑一次，然后跳过 | 相同 |
| provider key 存在服务端，启动 agent 时下发给 Computer | key 不离开设备 |
| 没有 Computer 的 agent 创建 reminder 时返回 409 | Topology H 用 Host 服务端的定时器 |

## 11. 路线图

### 11.1 SDK（先做）

K1、K2、K3 互不依赖，可以并行。每个阶段单独合并后，系统都处于可用状态。

| 阶段 | 范围 | 依赖 | 验收 |
|---|---|---|---|
| K1 存储记账与保留 | [#411]（P1）、[#412]（P2） | 无 | 成功标准 5 |
| K2 设备端 wake 队列 | 新 issue，正文取 §7 | [#403]（已合并） | §7.5 |
| K3 空闲成本 | [#410]（建议从 P3 提到 P1）、[#391] | 无 | 成功标准 4；空 mailbox 的设备能冷启动，不等待 long-poll |
| K4 收尾 | routine 冒烟测试（扩展 [#418]）、Host 指南独立成文、[#399] | K2 | 用默认配置跑通一个 routine 的调度、补跑和崩溃恢复；README 链接 Host 指南 |

每个阶段都运行：

```sh
bun run build
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

K1 和 K3 的 dataplane 测试还需要 `docker compose -f docker-compose.test.yml up -d --wait`。

每个阶段在同一个 PR 中修改 spec：

- K1：存储记账和维护契约。
- K2：新增 embedded wake 队列一节，并修改 [Embedded SQLite device and receipt authority](../spec.md#embedded-sqlite-device-and-receipt-authority) 的 schema 版本。
- K3：events hold 的唤醒规则。
- K4：README 链接 Host 指南。

回滚：

- K1、K3：按各自 issue 的迁移说明回滚。#410 写明部署顺序不影响正确性：没有 trigger 时，新代码退化为兜底间隔读取。
- K2：恢复 adoption 前的备份。旧版本拒绝 schema 5。
- K4：只有文档和测试，直接回退。

### 11.2 下游接入：Aiphabee（不在本仓库）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| A1 | 命令同步：命令并入现有的 research monitor bootstrap 响应，按版本做条件响应。删除浏览器投递。服务端记录设备最后同步时间。projection key 只在 fingerprint 变化时注册。 | 无 |
| A2 | 用 K2 的 wake 队列替换两个本地调度循环 | K2 |
| A3 | `watchlist_monitor` 作为 capability，运行在同一个 routine 核心上 | A2 |
| A4 | 删除 `LOCAL_SUBSCRIPTION_OPERATION_POLICIES` 的执行计费，改为存储超额解锁 | 无 |

A1 和 A4 不依赖 SDK，可以提前。

## 12. 端到端验收矩阵

Topology L，在 K2 和 A2 之后执行：

| 类型 | 场景 | 期望 |
|---|---|---|
| 正常 | 设备在线，时点到期 | 一个 occurrence，一个 execution，结果进入历史 |
| 正常 | 没有打开浏览器时创建 routine | 一个同步间隔内应用 |
| 错误 | 设备拒绝定义 | `sync_failed`，显示错误码 |
| 错误 | 两个客户端修改同一个版本 | 第一个成功，第二个返回 `409` |
| 错误 | 提交的响应丢失 | 读回同一个 offer，没有第二个 execution |
| 错误 | wake hook 抛错 | 60 秒后再次投递，最终只有一个 execution |
| 边界 | 进程在投递中被杀 | 重启后再次投递；occurrence 去重，只有一个 execution |
| 边界 | 设备休眠三天 | 醒来后 60 秒内只补跑一次 |
| 边界 | 时点落在 quiet hours 内 | quiet hours 结束时运行 |
| 边界 | Agent 正忙 | occurrence 在 Host 队列中等待，只保留一个待执行 |
| 边界 | 运行中暂停 | 当前 occurrence 完成，之后没有新的 occurrence |
| 边界 | Host 进程停止超过 3 个同步间隔 | `device_offline` |
| 边界 | 设备在线，但调度没有运行 | 宽限期后显示 `missed` |
| 安全 | 检查服务端存储和请求日志 | 没有用户模型 key |
| 成本 | 空闲设备运行 1 小时 | 设备每 60 秒最多调用一次 Host 服务端 |

## 13. 风险与最脆弱的假设

- 最脆弱的假设：需要 routine 的 BYOK Host 在设备上有进程（Topology L）。如果不成立，K2 帮不上忙，Host 改用 Topology H，在自己的服务端计时。SDK 不需要为此改动。
- 设备关机或休眠时，routine 不运行。这是 BYOK 的固有限制。用户通过 `missed` 和 `device_offline` 看到它。
- Workers 部署的空闲成本仍然高于 VPS，因为它按兜底间隔读取。O4 接受这一点。
- 只按存储收费时，服务器成本要靠 R1–R3 控制。下游不减少空闲调用，收入和成本就会脱节。
- schema 5 需要显式 adoption。已经部署的 embedded server 升级时，要停止 writer 并备份。
- 系统休眠会推迟定时器。K2 用 60 秒的等待上限加墙钟比较处理它，并用注入时钟的测试覆盖。

## 14. 实施与上线门槛

实施入口：

- 每个阶段先有 issue（K2 按 §7 开新 issue），再开 PR。
- 每个 PR 同时修改 spec，并通过 §11.1 的检查。

上线门槛：

- K1–K3 合并并发布。
- 首个下游完成 A1 和 A2，并通过 §12 的矩阵。
- 首个下游测量每台空闲设备每分钟的服务器调用数，记录部署前后的对比。

[#391]: https://github.com/Ancienttwo/byok-sdk/issues/391
[#399]: https://github.com/Ancienttwo/byok-sdk/issues/399
[#403]: https://github.com/Ancienttwo/byok-sdk/pull/403
[#410]: https://github.com/Ancienttwo/byok-sdk/issues/410
[#411]: https://github.com/Ancienttwo/byok-sdk/issues/411
[#412]: https://github.com/Ancienttwo/byok-sdk/issues/412
[#413]: https://github.com/Ancienttwo/byok-sdk/issues/413
[#414]: https://github.com/Ancienttwo/byok-sdk/issues/414
[#418]: https://github.com/Ancienttwo/byok-sdk/issues/418
