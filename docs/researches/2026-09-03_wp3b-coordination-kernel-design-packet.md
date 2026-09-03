# WP3B 实施包：`@byok-sdk/server` 收敛为 `@byok-sdk/cloud` domain kernel façade

> 基线 `main@4cc765f`。上游裁决见 `docs/researches/2026-09-03_architecture-review.md` §6（WS 行）/§7 V4/§8 WP3B/§12/§13，本包不重开这些结论。
> 事实等级：无标注 = 本轮读源码复核；`[inferred]` = 由代码推断未跑；`[unverified]` = 需要一次本包未做的检查。
> 本包推翻 `ARCHITECTURE-PROPOSAL-byok-platform.md` §3.3（`TaskStore` 不做 async 迁移，:143-153）。

---

## 1. 现有 server 公开面清单与处置

`packages/server/src/index.ts` 全部导出，逐项处置。

### 1.1 `ByokServer` 成员

| 成员 | file:line | 处置 | 理由 |
|---|---|---|---|
| `hono` | `index.ts:119-120` | **reimplement-over-cloud** | 换成 `cloud.fetch`；`http.ts` 12 条路由（`http.ts:125,132,193,214,262,290,308,319,342,368,424,451`）与 cloud registry 同名同契约，保留双份即 V4 |
| `attachWebSocket()` | `index.ts:122` | **delete** | §6 裁决 + §13 已回证无消费者；`ws-server.ts`（236 行）与 `heartbeat.ts`（69 行）随之删除 |
| `pairing.createPairingCode()` | `index.ts:130` | **keep-as-façade（改 async）** | 直接转 `cloud.createPairingCode(tenant, {productId, ttlMs})`（`cloud.ts:351`）；`pairing.ts`（214 行）删，权威是 `PairingCodeStore`+`PairingEnrollment` |
| `dispatch()` → `TaskHandle` | `index.ts:132`，实现 `hub.ts:1900,1920` | **reimplement-over-cloud** | 按 `agentRef`/`egressPolicy` 分派到 `enqueueOffer`/`enqueueToolsetOffer`/`enqueueAgentOffer`/`enqueueAgentEgressOffer`（`cloud.ts:353,355,361,366`），返回值改为 §3 的 façade handle |
| `dispatchFreshAgentEgress()` | `index.ts:134`，`hub.ts:1907` | 同上 | `cloud.enqueueFreshAgentEgressOffer`（`cloud.ts:376`） |
| `requestAgentContentRead()` | `index.ts:136`，`hub.ts:2139` | keep-as-façade | `cloud.enqueueAgentContentRead`（`cloud.ts:382`） |
| `enqueueAgentHomeProjection()` | `index.ts:138`，`hub.ts:2161` | keep-as-façade | `cloud.enqueueAgentHomeProjection`（`cloud.ts:388`） |
| `readAgentHomeProjection()` | `index.ts:140`（同步） | keep-as-façade（改 async） | `cloud.getAgentHomeProjectionStatus`（`cloud.ts:394`）；注释里「production durability belongs to @byok-sdk/cloud stores」正是本刀兑现的那句 |
| `tasks.get/list()` | `index.ts:141-144`（同步） | **reimplement-over-cloud（breaking，见 §6）** | 权威改 `TaskAttemptStore`；`list()` 是 GAP |
| `egress.get()` | `index.ts:146-148` | keep-as-façade（改 async） | `cloud.readAgentEgress`（`cloud.ts:416`） |
| `machines.list()` | `index.ts:149-151` | **reimplement-over-cloud（语义变）** | `listDevices`+`listPresence`（`cloud.ts:433,440`）join；`connected` 从「活 socket」变「presence hint 未过期」 |
| `events.subscribe()` | `index.ts:152-154`，`hub.ts:596` | **reimplement-over-cloud** | 由 §3 的 relay 提供，非第二状态机 |
| `devices.revoke()` | `index.ts:168-170` | keep-as-façade（改 async） | `cloud.revokeDevice`（`cloud.ts:434`） |
| `stop()` | `index.ts:177,294-296` | keep（语义收窄） | 现在只停 lease reaper（`hub.ts:591`）；lease reaper 删除后改停 relay/清理订阅 |
| `stats()` → `HubStats` | `index.ts:188`，`hub.ts` 计数器 `:543-557` | **reimplement（形状 breaking）** | cloud 无对应物。保留 uptime/envelopesIn/dedupDrops/rateLimitEvents/task counts；`connectedDevices` 改 `presence` 计数 |

### 1.2 类型与类导出

| 导出 | file:line | 处置 |
|---|---|---|
| `CreateByokServerOptions`,`DispatchInput`,`FreshAgentEgressDispatchInput`,`AgentContentReadRequest`,`AgentHomeProjectionRequest` | `index.ts:27-42`，`types.ts:100-176` | keep（`DispatchInput.deviceId` **保持 optional**，`types.ts:131`；把它改必填 = 提前执行 ADR-034 的五项删除之一，移到 WP4——理由见下） |
| `TaskHandle`,`ServerTaskEvent`,`TaskResult` | `types.ts:240-258,232-237,188-215` | keep（形状不变，来源换成 kernel，见 §3） |
| `TaskSnapshot` | `types.ts:275-310` | **reimplement（字段裁剪，见 §6）** |
| `MachineInfo` | `types.ts:261-272` | keep（`connected` 语义变） |
| `AgentEgressReceipt` | `types.ts:180-185` | keep-as-façade（投影自 `AgentEgressRecord`） |
| `HubStats` | `types.ts` | reimplement（字段裁剪） |
| `ByokServerEvent` | `types.ts:365+`，联合成员 `:368-` | keep，但 `device.connected`/`device.disconnected` 两支需裁（**owner 可见决定**，见下） |
| `TaskStore`,`TaskRecord`,`CreateTaskInput`,`InMemoryTaskStore`,`IllegalTaskTransitionError` | `index.ts:43-44`，`task-store.ts:5,16,28,48,111` | **delete** | 这是第二个 task 权威本体 |
| `SqliteTaskStore`,`SqliteTaskStoreOptions` | `index.ts:91-92`，`sqlite-task-store.ts:1` | **delete**（能力以 4 个 cloud port adapter 重建，见 §7 Step 3） |
| `BlobStore`,`LocalDiskBlobStore`,`SqliteBlobStore` 及其 option/result 类型 | `index.ts:83-94`，`blob-store.ts:50-65` | **delete**（形状与 `CloudBlobStore`+`BlobContentProxy` 不同：`ports.ts:514-521,549-554`；不做双形状） |
| `SqliteUnavailableError` | `index.ts:95`，`sqlite-support.ts` | keep（`sqlite-support.ts` 220 行留作 SQLite adapter 基础设施） |
| `RateLimiterOptions` | `index.ts:96`，`rate-limiter.ts:38` | keep；`RateLimiter`（`rate-limiter.ts:81`）改造为 `InboundRateLimiter` 实现（见 §2 GAP-5） |
| `StaleApprovalError`,`SteerRejectedError`,`SteerRejectionCode`,`AgentHomeProjectionCompletionError(+Code)` | `index.ts:53,61-64`，`hub.ts:380,413,470,484-486` | **移到 cloud**（随 §2 GAP-1/2 的 kernel 函数一起），server 只 re-export |
| `PairingAttemptConflictError`,`PairingCodeInvalidError` 及 pairing 类型 | `index.ts:65-66`，`pairing.ts` | reimplement over `ByokCloudError`（`errors.ts`）；不保留第二套错误分类 |
| `AccessTokenClaims`,`AuthenticatedDevice`,`DeviceRecord`,`TenantId`,`TokenSigner`,`createHmacTokenSigner` | `index.ts:67-82`，`auth.ts` | **delete 本地实现，改 re-export cloud**（`cloud/src/index.ts:20-21,102-103`）；`auth.ts` 407 行删。注意 `DeviceRecord` 字段不同（`ports.ts:52-82` 多 `proofKeyId/proofKeyEpoch/capabilities/machineId`）——breaking，一次切 |
| `event-queue.ts`（`AsyncEventQueue`，59 行，非导出） | `event-queue.ts:10` | keep，成为 §3 relay 的实现件（须加界，见 §3 10x） |
| `ids.ts`（21 行） | — | delete（`CloudCrypto.randomPairingCode` 已有：`auth/plane.ts:83`） |

**`ByokServerEvent` 的 `device.connected` / `device.disconnected` —— owner 可见决定。** 这两支（`packages/server/src/types.ts:369-370`）的**全部生产者都在 `hub.ts` 里**，且都读活 socket 连接态：`device.connected` 在 `hub.ts:637`（WS 握手）与 `hub.ts:821`（长轮询首次出现），`device.disconnected` 在 `hub.ts:714`（verified：`grep -rn 'device\.\(dis\)\?connected' packages/server/src` 只有这三处生产 + `types.ts` 声明 + `__tests__/integration.test.ts:312` 消费）。Step 2 删掉 `hub.ts` 后，这两支**再无任何生产者**，留着就是永远不触发的死联合分支。两条路：

- **(A) 删掉这两支联合分支**（breaking：`ByokServerEvent` 的形状变窄，消费者的 `switch` 需要改；`integration.test.ts:312` 的等待逻辑同刀删）。
- **(B) 从 presence 边沿派生，明确标为非权威提示**：relay 轮询/对比 `cloud.listPresence`（`cloud.ts:440`），在"未过期 → 过期"与"过期 → 未过期"的跃迁上补发这两支，文档写明它是 TTL presence hint 的边沿，不是连接事实。

**推荐 (A)。** 理由：`connected` 在本刀里已经从"活 socket"降级成"presence hint 未过期"（见上表 `machines.list()` 一行），(B) 会把一个已经降级的观测再包装成一个**看起来像连接事件**的推送，且 presence 的 TTL 抖动会产生真实设备没有任何变化时的假边沿——这正是铁律里"不为了让旧形状继续存在而合成权威"的那类路径。删掉之后，需要"设备在不在"的消费者读 `machines.list()` 的 presence 投影，一个事实一个读法。**这条要 owner 点头**：它是 `ByokServerEvent` 公开面的 breaking 收窄，和 §6 的 `TaskSnapshot` 字段裁剪同一性质。

**`DispatchInput.deviceId` 与 ADR-034 —— 从本包移出。** 把 `deviceId` 由 optional 改 required，等于删除 ambient device selection（`packages/server/src/types.ts:131`，实现 `hub.ts:2399` `pickFirstConnectedDevice`）。ADR-034（`docs/architecture/adr-2026-09-03-domain-model-and-authority.md`，Decision 第一条）把它列为**必须在同一次 v2 cutover release 中删除、不得分批保留**的五项之一（另四项：legacy `task.offer` / `task.offer_with_toolsets`、`strictAgentOnly`、task-scoped `gitWorkspace` authority + `SessionWorkspaceStore` schema、fresh/resume 两种 offer 的分裂）。在 Step 2 里删它就是**提前拆散那个批次**。

fold 本身**不需要**它：cloud 的 `enqueueOffer`/`enqueueToolsetOffer`/`enqueueAgentOffer`/`enqueueAgentEgressOffer`/`enqueueFreshAgentEgressOffer`（`cloud.ts:353,355,361,366,376`）都以 `deviceId: string` 为**显式第二参数**，façade 只要在 `deviceId` 省略时先选一台再调用即可——选择逻辑留在 façade 侧，不进 kernel。所以：

**裁定：`deviceId` 保持 optional，删除动作移到 WP4 的 v2 cutover。** Step 2 里 façade 的 ambient 分支用 `cloud.listPresence`（`cloud.ts:440`）+ 持久化 device row 的 capability 重建 `pickFirstConnectedDevice` 的等价筛选（未过期 presence、非 strict-agent-only、toolset 齐备），并在 `docs/` 里标为 legacy-pending-WP4。若 owner 反过来要求在 Step 2 就改必填，那是**对 ADR-034 批次条款的一次有意偏离，需要 owner 单独签字**，并在 ADR 里补一条 Supersedes/例外说明——不能由本包自行决定。

**删除总量**：`hub.ts` 2639 + `http.ts` 496 + `auth.ts` 407 + `sqlite-task-store.ts` 402 + `sqlite-blob-store.ts` 277 + `blob-store.ts` 251 + `ws-server.ts` 236 + `pairing.ts` 214 + `task-store.ts` 184 + `heartbeat.ts` 69 + `ids.ts` 21 ≈ **5,196 行**，留 `types.ts`/`index.ts`/`sqlite-support.ts`/`rate-limiter.ts`/`event-queue.ts` ≈ 1,275 行 + 新增 façade。

---

## 2. 职责 → kernel 映射

| server 职责 | cloud 权威（file:line） | 判定 |
|---|---|---|
| pairing code 铸造/兑换 | `auth/plane.ts:49,56`，`ports.ts` `PairingCodeStore`/`PairingEnrollment` | 已有，直接用 |
| challenge / nonce / token | `auth/plane.ts:59-64`，`packages/cloud/src/auth/verify.ts:28`（`verifyNonceSignature`），`packages/cloud/src/auth/tokens.ts:34`（`TokenSigner` 接口）/ `:58`（`createHmacTokenSigner`） | 已有 |
| bearer 鉴权 | `packages/cloud/src/auth/bearer.ts:32`（`authenticateBearer`） | 已有，**但存在 §7 V4 的安全漂移**（`tasks/todos.md:17`：cloud 只做 row==claims 的 `device.productId === claims.productId` 等值检查（`bearer.ts:47`），缺 instance-product 检查；server `index.ts:234-238` 有）。本刀是那条 todo 的「下一把 cloud auth 刀」触发点 → 见 GAP-6 |
| capability 准入（Agent / toolset / fresh-session / strict-agent-only） | `cloud.ts:814-836`（durable device row 读，mailbox append 之前） | 已有，且比 server 严格（server 在 `hub.ts` 里读连接态） |
| dispatch / offer 预留 | `cloud.ts:353,355,361,366,376`；`TaskAttemptStore.open/reserveAgentOffer`（`ports.ts:273,285`） | 已有 |
| claim / decline / started | `inbound.ts` `'task.claim'`（`inbound.ts:459`）/`'task.started'`（`:462`）/`'task.decline'`（`:469`），ownership 由 `TaskAttempt.ownerDeviceId`（`ports.ts:259`） | 已有 |
| progress / activity | `inbound.ts` `'task.progress'` → `ActivityStore`（`activity.ts`，`coordination.ts`） | 已有（**有损、TTL 界内**，与 server 无损 outbox 不同——见 §3） |
| await_approval / approval_resolved 观测 | `inbound.ts` `'task.await_approval'`/`'task.approval_resolved'` → `ApprovalTimelineStore`（`packages/cloud/src/approval-timeline.ts:57-58`，`append`/`read`） | 已有 |
| **`task.approve` / `task.reject` 下发** | 无。cloud 只有私有 `enqueueAgentControlEnvelope`（`cloud.ts:849`）服务 `agent.content.read`/`agent.home.projection` | **GAP-1** |
| **`task.steer` 下发 + runtime 能力门** | 完全缺失（`grep 'steer' packages/cloud/src` 零命中；wire 侧存在：`protocol/src/envelope.ts:76`、`messages.ts:1144`） | **GAP-2** |
| cancellation（tombstone + 投递原子） | `cloud.cancelTask`（`cloud.ts:411`）+ `TaskCancellationStore.request`（`ports.ts:363-364`，明文 commit-both-or-neither）；`events.ts:106-126` 过滤已取消 offer | 已有，**强于 server** |
| first-terminal-wins | `inbound.ts:498-504,559-567` `recordTerminal` + `RequestReceiptStore.record`（`ports.ts:386-389`，first-write-wins）；`terminal-result.ts` 投影；cancel tombstone 压过后到的 device receipt（`cloud.ts:421-431`） | 已有 |
| agent egress（reliable ack / latest-value） | `AgentEgressStore`（`ports.ts:594`），`cloud.ts:983` `enqueueReliableEgressAck`，`readAgentEgress`（`cloud.ts:416`） | 已有 |
| agent-home projection（下发 / 状态 / 完成） | `cloud.ts:388,394,400` | 已有 |
| message 副作用准入 | `inbound.ts:67-90` `handleAgentMessagePublish` + `TaskAttemptStore.reserveAgentMessage`（`ports.ts:299-307`，`reserved|pending|rejected`）+ `ByokCloudOptions.agentMessage`（`cloud.ts:230-238`，async） | 已有；server 版是同步 hook（`types.ts:113-119`）→ 签名 breaking |
| blobs | `CloudBlobStore`（`ports.ts:514-521`）+ `BlobContentProxy`（`ports.ts:549-554`）+ core `ObjectStore`/`QuotaStore` 预留（`handlers/blobs.ts:65-262`） | 已有，形状不同（server 无 quota/reservation） |
| presence | core `PresenceStore` + `handlers/presence.ts:21`，`cloud.listPresence`（`cloud.ts:440`） | 已有 |
| **inbound rate limiting** | port 有（`ports.ts:569-571`），**参考实现是 allow-all**（`stores/in-memory/rate-limiter.ts:12-15`） | **GAP-5**：语义不在 kernel 里，在部署边缘 |
| outbox + cursor 重放 | core `MailboxStore`（`mailbox.ts:140-160`）；`handlers/events.ts:70-137` 三性质（读不 ack / ack 单调 / hold）；`recordDelivery` 水位 | 已有，**语义更强** |
| **`cursor_too_old`（409）** | cloud 无此路径。server 有（`http.ts:386`，`hub.ts:497-506`）；client 长轮询仍在判它（`long-poll-transport.ts:578`） | **GAP-3**（见下） |
| **server 侧 task 读模型（list）** | `TaskAttemptStore` 只有 `get`/`getMany`（`handlers/events.ts:104`），无 tenant 级列举 | **GAP-4** |
| lease reaper（暗设备 30min → `Failed(retryable:true)`） | 无。cloud 刻意不持有执行态 | **删除**（见 §8 风险 R2） |
| `stats()` | 无 | 在 façade 侧由 relay 计数重建（不进 cloud） |

### 需要的最小 kernel 增量（全部落在 `@byok-sdk/cloud`，共 5 项）

- **GAP-1 `approveTask` / `rejectTask`**：新增两个 host control-plane 函数，形如 `approveTask(tenant, taskId, opts?: {approvalId?})`。实现 = 读 `ApprovalTimelineStore` tail 取当前 pending `approvalId` 做 staleness 判定（不新增 store），复用 `enqueueAgentControlEnvelope`（`cloud.ts:849`）投递 `task.approve`/`task.reject`。`StaleApprovalError` 语义搬 `hub.ts:380` 与 `hub.ts:2315,2337` 的门序。
- **GAP-2 `steerTask` + `TaskAttempt.claimedRuntime`**：steer 的正确门是「claim 时快照的 runtime 是否声明 `steer`」（`steer-runtime-capability-gate.test.ts:129,304`：连接期声明**不**参与判定）。`TaskAttempt` 无此字段 → 加 `readonly claimedRuntime?: RuntimeId`，由 `inbound.ts` 的 `task.claim` 分支写入。牵连：`stores/in-memory/task-attempts.ts`、`cloud-dataplane/src/stores/task-attempts.ts` + 仓库根 `deploy/sql/0018_*.sql`（migration 目录在 **repo root `deploy/sql/`**，不在 `packages/cloud-dataplane/` 下；今天存在 `0001`–`0017`，最新 `0017_agent_message_admission.sql`，故下一号是 0018——verified）、`conformance/src/cloud/task-attempts.ts` 一条用例。
  **为什么 `claimedRuntime` 不违反 ADR-028**：它是 **claim 时刻的一次性快照**，与 server 侧同名字段语义逐字相同（`packages/server/src/types.ts:327`：在 `Offered -> Claimed` 转换的那一刻记下 claim 设备自报的 runtime，重投的幂等 claim 不会覆盖它）；ADR-028 禁的是云端持有**运行中中间态**（`running`/`thinking`/`awaiting_approval`/live turn/PID/当前工具调用），即随 Attempt 执行过程持续变化的量。`claimedRuntime` 写入一次、此后不变，是 Attempt 的归属事实而非执行态，落在 ADR-028 允许的范围内。
- **GAP-3 `cursor_too_old`**：`MailboxStore.collectRetired` 会把未 ack 行标 `expired`（**`packages/core/src/mailbox.ts`**，port 在 core 不在 cloud；in-memory 实现 `packages/core/src/in-memory/mailbox.ts`，dataplane 实现 `packages/cloud-dataplane/src/stores/core/mailbox.ts`——Step 1c 已按此落地），但 `handlers/events.ts` 不区分「cursor 落在已回收区」与「空页」，返回 200 空。client 有该分支（`long-poll-transport.ts:578`）却永远收不到 → **今天就是 embedded/hosted 的行为分叉**。最小补法：`readAfter` 返回 `recoverableFrom`（页里最早可恢复 seq），`events.ts` 在 `cursor < recoverableFrom` 时返 409 `{error:'cursor_too_old', recoverableFrom}`，与 `http.ts:386` 同形。
- **GAP-4 `TaskAttemptStore.list(tenant, {limit, cursor})`**：有界游标分页。三处实现 + conformance 一条。
- **GAP-5 真实 `InboundRateLimiter`**：把 `rate-limiter.ts:81` 的 token bucket 改造成 `InboundRateLimiter` 实现，**放在 `@byok-sdk/server`**（它是自托管部署的策略选择；hosted 的预算在边缘，`stores/in-memory/rate-limiter.ts:4-7` 已说明）。cloud 不动。
- **GAP-6（安全，必须同刀）** `auth/bearer.ts` 的 instance-product 检查：本刀让 embedded 部署走 cloud 的 bearer 路径，`tasks/todos.md:17` 记录的「两侧安全姿态不对齐」会从「文档已知」变成「embedded 实际降级」。裁法：给 `createByokCloud` 增一个 **可选** `instanceProductId`；给定时 bearer 强制 `claims.productId === instanceProductId`，不给定时维持 row==claims。`createByokServer({productId})` 永远传它 → embedded 侧行为等价保持。不是 fallback：两种部署形态各有一个显式权威值。

### 需要的 kernel 观测点（1 项，非 store）

- **`ByokCloudOptions.observer?: { onInboundCommitted(input): void }`**：post-commit 通知，只读、不返回值、不影响 outcome，在 `inbound.ts` 每条 envelope 的写入提交后触发一次。这是 §3 的唯一依赖，也是本刀在 cloud 上加的唯一非领域 API。`ByokCloudOptions` 现有 hook 只有 `agentMessage`（`cloud.ts:230`），它是 **admission** 语义（能改结果），不能复用。

**验证**：`packages/cloud/src/__tests__/constraints.test.ts:64-68` 只断言 **cloud 不含 `@byok-sdk/server`**，方向单一——`server → cloud` 不触发它，无需改这条断言。

---

## 3. `TaskHandle` façade 设计

### 不变量

> **一个 task 只有一个权威：`TaskAttemptStore`（终态事实在 `RequestReceiptStore`）。`TaskHandle` 持有的一切都是通知，不是状态。**

### 构造

```
createByokServer()
  ├─ createInMemoryByokCloud({ ..., observer: relay })      // composition/in-memory.ts:97
  └─ TaskEventRelay                                          // 进程内，无持久化
       onInboundCommitted(envelope) →  push 到 per-task AsyncEventQueue
```

`TaskEventRelay` 只做三件事：

1. **折叠**：把 `inbound.ts` 已提交的 envelope 映射成 `ServerTaskEvent`（`types.ts:232-237`）——`task.progress` → `{kind:'agent'}`、`task.artifact` → `{kind:'artifact'}`、`task.await_approval` → `{kind:'await_approval'}`、终态 → `{kind:'state'}`。映射是纯函数，不判定合法性（合法性 `inbound.ts` 已判过）。
2. **唤醒**：终态 envelope 提交后 resolve 该 task 的 terminal promise。
3. **计数**：`stats()` 的 envelopesIn / dedupDrops / rateLimitEvents。

`TaskHandle` 各成员：

| 成员 | 实现 |
|---|---|
| `taskId` | `EnqueuedOffer` 返回的 id |
| `events()` | relay 队列的 `subscribe()`（`event-queue.ts:38`），从 0 重放 |
| `approve/reject` | `cloud.approveTask/rejectTask`（GAP-1）——**不经 relay**，走 kernel |
| `cancel` | `cloud.cancelTask`（`cloud.ts:411`） |
| `steer` | `cloud.steerTask`（GAP-2） |
| `result()` | `await` terminal promise（relay 唤醒）→ **再 `cloud.readTaskResult(tenant, taskId)` 读回**（`cloud.ts:432`），返回读回的值，不返回 relay 缓存 |

**「读回」是不变量的执行方式**：relay 可以丢事件、可以乱序、可以在多进程部署里完全失灵；`result()` 与 `tasks.get()` 的返回值永远来自 store，所以 relay 失灵只降级为「等不到唤醒」，永不产出与 store 不一致的答案。这条让 relay 不构成第二权威，可机检：一条断言 `result()` 的值与 `readTaskResult` 逐字段相等的 characterization test。

### 与今天的行为差

- `events()` 的 `agent` 事件在 hosted 部署是**有损**的（`ActivityStore` TTL/容量界，`coordination.ts` `DEFAULT_ACTIVITY_*`）。embedded + relay 路径下不落 activity 也能推送，所以 embedded 不退化。差异只在「跨进程读历史」——文档必须写明 `events()` 是 in-process live 流，不是可回放审计流。
- 没有 lease reaper 后，暗设备的 task 永远停在 `pending`，`result()` 永不 resolve。消费者必须自己超时 + `cancel()`。这与 cloud 今天的生产语义一致（Salesko 即此形态，§13）。

### 10x 失效点

`AsyncEventQueue.subscribe()` 从 index 0 重放（`event-queue.ts:45-47`），buffer 只增不减、`close()` 也不释放。10k 并发 task × 每 task 数百条 progress = 进程 OOM，**今天的 `hub.ts` 是同一形状**（`hub.ts:515` 的 `serverEvents` + per-task 队列）。同刀修：relay 的每 task 环形缓冲设上限（drop-oldest 并插一条 `{kind:'error', reason:'events_truncated'}` 标记，绝不静默丢），终态后加 TTL 回收队列，`stop()` 清空。上限值走 `CreateByokServerOptions`，默认取一个显式常量而非无穷。

---

## 4. 消费者影响矩阵

| 消费者 | file:line | 用什么 | WS? | 处置 |
|---|---|---|---|---|
| `examples/basic/server.ts` | `:16-25` import；`:98,103,106,113,117,120,161-163,186,213,246,263,271` | 全公开面 + `SqliteTaskStore`/`SqliteBlobStore` + `attachWebSocket` | 是（`:271`） | **改写**：删 `attachWebSocket`；`tasks.get/list` 改 await；自持 `Map<taskId,{instruction,runtime,policy}>`；`BYOK_STORE=sqlite` 改指向新 SQLite adapter（Step 3 后） |
| `packages/sdk/src/index.ts` | `:10` `export * as server` | 全量 re-export | 否 | 无代码改动，surface 随之 breaking；`packages/sdk/package.json:52` 保留 |
| `packages/client/scripts/control-socket-check.mjs` | `:74,84,96` | `createByokServer` + `attachWebSocket` + `pairing.createPairingCode` | **是** | 改写为长轮询；这是 templates 的真实被调方 |
| `packages/client/scripts/ipc-smoke.mjs` | `:71,81,137` | 同上 | **是** | 同上 |
| `packages/client/scripts/adapter-task-smoke.mjs` | `:163,170,173,245,276,326` | + `dispatch()` | **是** | 同上 + `dispatch` 加 `deviceId` |
| `templates/service/launchd/smoke-test.sh` | `:149-154` | spawn `control-socket-check.mjs` | 间接 | 无改动（随上游修好） |
| `templates/service/winsw/smoke-test.mjs` | `:206-211` | 同上 | 间接 | 无改动 |
| `scripts/release/check-package-graph.mjs` | `:10` | 包名列表 | 否 | 不动 |
| `scripts/release/pack-and-smoke.mjs` | `:32,411,449` | 包名 + 动态 import 冒烟 | 否 | 不动 |
| `scripts/release/registry-readback.mjs` | `:30` | 包名 | 否 | 不动 |
| `packages/client/src/__tests__/fixtures/real-server.ts` | `:3-10,78,100,141,154` | 三种启动形态 | **是（10 处）** | **删除**，全部改用已存在的 `fixtures/real-cloud.ts`（156 行，`:50-72` 已提供 pairing/enqueue/cancel/readAttempt/readTerminal/readActivity/listPresence） |
| `real-server-approval-resolved-e2e.test.ts` | `:5,10,18` | `ByokServerEvent` + WS 全链路 approve | **是** | 改写为长轮询 + `real-cloud` |
| `real-server-cancel-redelivery.test.ts` | `:7` | 断连期 `task.cancel` 重投 | **是** | 改写为长轮询 |
| `real-server-redelivery.test.ts` | `:7` | 真实重连重投（F2） | **是** | 改写为长轮询 |
| `real-server-repair-cursor.test.ts` | `:7` | 重新配对不继承旧 cursor（F5） | **是** | 改写为长轮询 |
| `real-server-longpoll-only.test.ts` | `:7,38,99` | 纯长轮询全生命周期（F6） | 长轮询 | **保留语义**，fixture 换 `real-cloud`；`real-cloud-longpoll.test.ts`（212 行）已是模板 |
| `real-server-longpoll-redelivery.test.ts` | `:9,49,143` | 处理成功前不推 cursor（Design A） | 长轮询 | 同上 |
| `real-server-longpoll-retry-idempotent.test.ts` | `:7,50` | 失败 POST 同批重试恰一次（Design B） | 长轮询 | 同上 |
| `real-server-longpoll-stall-dedup.test.ts` | `:7,54,107,181` | 停滞 cursor 回补 backoff + dedup（P2） | 长轮询 | 同上 |
| `real-server-longpoll-steer.test.ts` | `:7,47,113` | 纯长轮询下 `task.steer`（S0/H-010） | 长轮询 | 同上，**依赖 GAP-2** |
| `real-server-outbox-chunking.test.ts` | `:10,55` | outbound 分块到 batch cap（P1） | 长轮询 | 同上 |
| `real-server-outbox-switch.test.ts` | `:7,111` | 长轮询→WS 切换不丢队列（N4） | **是（WS 切换本体）** | **删除**：被测行为随 WS 消失 |
| `task-runner-approval-resolved.test.ts` | 不 import server（`:32` 仅注释） | stub 驱动的 daemon 侧决策 | 否 | **不动** |
| `journal-sqlite.test.ts` | 不 import server（`:10` 仅注释） | 本地 journal 单测 | 否 | **不动** |

---

## 5. Characterization test 计划

`packages/server/src/__tests__/` 共 36 个 `.test.ts` + `test-support.ts`（418 行）。分类依据是 describe/it 与 import，不是文件名。

**删除（transport-only，被测物随 WS 消失）**：`heartbeat.test.ts`（96，ping/pong 调度）、`version-negotiation.test.ts`（126，真 WS 握手协商）、`port-shadowing.test.ts`（32，fixture 绑定地址族）、`integration.test.ts:347` 的 WS 握手 1002 子套、`issues-112-120-security-reliability.test.ts` 中 hello timeout / pending-hello / oversized-frame 子套。

**随实现删除（被测类不存在了）**：`task-store.test.ts`（141）、`sqlite-task-store.test.ts`（453）、`sqlite-blob-store.test.ts`（288）、`pairing.test.ts`（89）、`nonce-store.test.ts`（53）。其语义已由 `packages/conformance` 的 `cloud/task-attempts.ts`、`cloud/blobs.ts`、`cloud/pairing.ts`、`cloud/nonces.ts` 覆盖——**Step 1 必须先确认这四条 conformance 覆盖不弱于被删单测，弱的部分补进 conformance 而不是留在 server**。

**保留为 kernel 行为测试（改 transport 后必须继续绿）**：`auth.test.ts`(167)、`bearer-instance-product.test.ts`(197，直接锁 GAP-6)、`tenant-pairing-isolation.test.ts`(407)、`authenticated-enrollment-tenant-projection.test.ts`(80)、`blob.test.ts`(263)、`dispatch-routing.test.ts`(32)、`dispatch-selection.test.ts`(124)、`toolset-dispatch.test.ts`(136)、`strict-agent-only.test.ts`(65)、`task-claim-runtime.test.ts`(112)、`steer-runtime-capability-gate.test.ts`(471)、`hub-approve-reject.test.ts`(514)、`hub-approval-resolved.test.ts`(462)、`hub-implicit-approval-resume.test.ts`(172)、`inbound-gate.test.ts`(345)、`long-poll.test.ts`(225)、`rate-limit.test.ts`(510)、`rate-limit-episode.test.ts`(79)、`result-document-projection.test.ts`(183)、`agent-egress-contract.test.ts`、`agent-home-contract.test.ts`(214)、`agent-home-projection.test.ts`(159)、`observability.test.ts`(129)。

**待裁**：`task-lease.test.ts`(289) — lease reaper 若删则整文件删（见 §8 R2）。

### Step 0 要先写的 10 条新 characterization test

全部打在 **公开面**（`createByokServer` 进、HTTP + `TaskHandle` 出），今天对 `hub.ts` 绿，重构后必须原样绿。前置：给 `test-support.ts` 加 `connectFakeDaemonLongPoll()`（对照现有 `connectFakeDaemonWs` `:251` 与 `connectFakeDaemon` `:298`）。

1. **配对→challenge→token→长轮询首次 offer 送达**：一条无 WS 的端到端。
2. **`dispatch()` → `TaskHandle.result()` 与 `tasks.get()` 逐字段一致**（锁 §3 不变量）。
3. **first-terminal-wins**：两条 `task.complete` 不同 summary，`result()` 取第一条；第二条不覆盖。
4. **cancel 压过后到终态**：`cancel()` 后 device 再发 `task.complete`，`result().state === 'Cancelled'`。
5. **approve 定向 + 陈旧拒绝**：两轮 `await_approval`，用第一轮的 `approvalId` 在第二轮 approve → `StaleApprovalError`。
6. **steer 的 runtime 门**：claim 声明不支持 steer 的 runtime → `SteerRejectedError('steer_unsupported_runtime')`；连接期声明 steer 不改变结论。
7. **cursor 语义（Step 2 重钉，见 §8）**：读不 ack——同一 cursor 连读两次返回同一页；ack 单调且不可逆——唯一的 ack 是 daemon 下一次轮询带回的 cursor，它退休该水位及以下的行，之后从更低 cursor 读只返回仍 pending 的行，既不 un-ack 也不重放已 ack 的行；floor 只由 expiry 移动——`recoverableFrom` 是保留清扫 dead-letter 的最高行 +1，所以 409 `cursor_too_old` 只能经 expiry 到达，追加再多行都不会触发（锁 GAP-3）。
   原稿写的是 `hub.ts` 的 500 条 in-process 重放环（重放已 ack 的行、按条数溢出移动 floor）。kernel 的 mailbox 语义更强（§2 表格同一行），且 hosted 生产已经跑在它上面，所以重放环随 `hub.ts` 一起删，不重建：在 mailbox 旁边再放一个按条数有界的保留窗口，等于对同一批行设第二个保留权威。
8. **inbound dedup + 跨设备 ownership 拒绝**：同 `message_id` 二次提交为 duplicate；非 owner 设备的 `task.complete` 被拒。
9. **capability 准入在 mailbox append 之前**：缺 Agent capability 的设备被拒时，`tasks.list()` 无该 task、mailbox 无行（锁 `cloud.ts:814-819` 的顺序）。
10. **rate limit episode**：超限 → 拒 + `stats().rateLimitEvents` **每个被拒 envelope +1**（episode 级合并只作用于 `device.rate_limited` 事件；Step 0 case 10 已钉实际行为，原稿「增 1」措辞有误）→ 恢复后放行（锁 GAP-5 不被 allow-all 悄悄吃掉）。

---

## 6. 异步切法（一次切，无双 API）

同步面共三处：`TaskStore` 接口全同步（`task-store.ts:48-63`）、`ByokServer.tasks.get/list`（`index.ts:141-144`）、`readAgentHomeProjection`（`index.ts:140`）。`hub.ts` 里 **30** 个 `this.taskStore.*` 调用点随 `hub.ts` 一起删（`ARCHITECTURE-PROPOSAL-byok-platform.md:145` 记的是 29；本轮实测 30——`grep -c 'this\.taskStore\.' packages/server/src/hub.ts` = 30，差 1 不改变结论），所以 §3.3 测算的「传染成本」在本刀里**不存在**——那笔成本是「保留 hub 再改 store」的成本，删 hub 后归零。这是推翻 §3.3 的关键事实。

**推荐形状（一次 breaking）**：

```ts
tasks: {
  get(taskId: string): Promise<TaskSnapshot | undefined>;
  list(query?: { limit?: number; cursor?: string }): Promise<{ tasks: TaskSnapshot[]; nextCursor?: string }>;
}
readAgentHomeProjection(deviceId, requestId): Promise<AgentHomeProjectionStatusReadback | undefined>;
```

`list()` 从无界变有界游标（`hub.listTasks()` 今天返回全表，`hub.ts:1888` 附近的 reap 是唯一收敛）——这本身就是 10x 修复。

**`TaskSnapshot` 字段裁剪（breaking）**：`TaskAttempt`（`ports.ts:251-269`）不存 `instruction`/`policy`/`runtime`/`requiredToolsets`。这些是 host 输入而非结果导向上下文，把它们塞进 cloud 行等于在协调面重建执行读模型（正是铁律 3 禁的）。**裁定：删这四个字段**，保留 `taskId/state/deviceId/sessionRef/agentRef/createdAt/updatedAt/result/pendingApprovalId/claimedRuntime`。

**`examples/basic` 迁移注记**：UI 需要 instruction 才能列表显示 → 在 `server.ts` 里加一个 `const dispatched = new Map<string, {instruction, runtime, policy}>()`，`dispatch()` 成功后写入，`/api/tasks` 用 `await byok.tasks.list()` 的 id 去 join。约 6 行。这是正确归属：发起方本来就拥有自己的输入。同时 `/api/tasks`、`/api/tasks/:id`、`/api/machines`（`server.ts:106,117,120`）三个 handler 加 `async/await`。

不做的事：不提供 `tasksSync` 之类的同步旁路，不保留 `TaskStore` 接口做适配层——那是稳态兼容路径。

---

## 7. 工作分解（每步 ≤ 1 天）

**Step 0 — characterization only**（允许路径：`packages/server/src/__tests__/**` 唯一）
写 §5 的 10 条 + `connectFakeDaemonLongPoll`。零生产改动。
出口：`bun run test`（全绿，含新用例对今天的 `hub.ts`）。回滚：`git revert`，无生产面。

**Step 1 — cloud kernel 增量**（共同允许路径：`packages/cloud/src/**`、`packages/cloud-dataplane/src/**`、仓库根 `deploy/sql/**`、`packages/conformance/src/**`）
原稿把 GAP-1/2/3/4/6 + `observer` hook 压成一步，实测超过 ≤1 天：其中 1b 单独就含一个 dataplane migration 与一条 conformance 用例。按 gap 拆成六个独立可 revert 的子步，**互不依赖，可并行也可任意顺序**（除 1b 内部的 migration 先于 store 实现）。每个子步末尾都跑 `bun run build && bun run typecheck && bun run test`，且 `packages/server` 零 diff。

- **Step 1a — `approveTask` / `rejectTask`（GAP-1）**
  改动：新增两个 host control-plane 函数，读 `ApprovalTimelineStore` tail（`packages/cloud/src/approval-timeline.ts:57-58`）取当前 pending `approvalId` 做 staleness 判定，复用 `enqueueAgentControlEnvelope`（`cloud.ts:849`）投递 `task.approve`/`task.reject`；`StaleApprovalError` 从 `hub.ts:380` 搬到 cloud。不新增 store。
  出口：`bun run build && bun run typecheck && bun run test`；新增 cloud 单测覆盖「陈旧 approvalId → `StaleApprovalError`」「无 pending approval → 拒绝」。
  回滚：单 commit revert（server 未依赖）。

- **Step 1b — `steerTask` + `TaskAttempt.claimedRuntime`（GAP-2，含 dataplane migration 与 conformance）**
  改动：`TaskAttempt` 加 `readonly claimedRuntime?: RuntimeId`，由 `inbound.ts` 的 `task.claim` 分支（`inbound.ts:459`）写入；三处 store 实现（`packages/cloud/src/stores/in-memory/task-attempts.ts`、`packages/cloud-dataplane/src/stores/task-attempts.ts`）+ **仓库根 `deploy/sql/0018_*.sql`**（现有 `0001`–`0017`）+ `packages/conformance/src/cloud/task-attempts.ts` 一条用例；`steerTask` 以 claim 时快照的 runtime 能力为门。
  顺序：先落 migration，再落 dataplane store 实现，最后 conformance。
  出口：`bun run build && bun run typecheck && bun run test`；`bun run check:deploy-sql`（migration 序号连续）；`packages/conformance` 全套绿，含新用例；单测锁住「连接期声明 steer 不参与判定，只看 claim 快照」。
  回滚：revert 三个 commit；migration 未在任何环境应用前可直接删文件，已应用则补 `0019` 反向 migration（本子步是唯一一处需要正向/反向两支的地方）。

- **Step 1c — `cursor_too_old`（GAP-3）**
  改动：`MailboxStore.readAfter` 返回 `recoverableFrom`（`packages/core/src/mailbox.ts` 的 `collectRetired` 已把未 ack 行标 `expired`；floor 只随 expiry 移动，ack 后 retire 不动——与 `hub.ts` ring eviction 语义一致）；`handlers/events.ts` 在 `cursor < recoverableFrom` 时返 409 `{error:'cursor_too_old', recoverableFrom}`，与 `http.ts:386` 同形。
  出口：`bun run build && bun run typecheck && bun run test`；conformance 新增「cursor 落在已回收区 → 409 而非 200 空页」；client 侧 `long-poll-transport.ts:578` 的分支从死码变为可达（本子步只证明 kernel 端会发，client 侧不改）。
  回滚：单 commit revert（回到今天的 200 空页行为）。

- **Step 1d — `TaskAttemptStore.list(tenant, {limit, cursor})`（GAP-4）**
  改动：三处 store 实现 + conformance 一条用例，有界游标分页。
  出口：`bun run build && bun run typecheck && bun run test`；conformance 覆盖「limit 生效」「cursor 单调、无重复无漏」「空租户返回空页无 cursor」。
  回滚：单 commit revert。

- **Step 1e — instance-product bearer（GAP-6，安全）**
  改动：`createByokCloud` 增可选 `instanceProductId`；给定时 `authenticateBearer`（`packages/cloud/src/auth/bearer.ts:32`）强制 `claims.productId === instanceProductId`，不给定时维持今天的 row==claims 等值检查（`bearer.ts:47`）。
  出口：`bun run build && bun run typecheck && bun run test`；新增 cloud 单测：给定 `instanceProductId` 时跨 product 的合法 token 被拒；不给定时行为与今天逐字相同。
  回滚：单 commit revert。**注意**：本子步必须先于 Step 2 落地，否则 Step 2 会让 embedded 部署的 bearer 姿态实际降级（§8 R4）。

- **Step 1f — `observer` post-commit hook**
  改动：`ByokCloudOptions.observer?: { onInboundCommitted(input): void }`，在 `inbound.ts` 每条 envelope 写入提交后触发一次；只读、无返回值、不影响 outcome。
  出口：`bun run build && bun run typecheck && bun run test`；单测锁「observer 抛错不改变 inbound 的 outcome」「每条已提交 envelope 恰好一次」「被拒 envelope 不触发」。
  回滚：单 commit revert。

**Step 2 — server 重实现 + 删 hub/WS**（共同允许路径：`packages/server/**`、`packages/client/scripts/*.mjs`）
原稿一步内含"重写 + 删 5,196 行 + 迁 3 个冒烟脚本 + 迁 36 个测试"，远超 ≤1 天。拆成四个**严格顺序**的子步（2a → 2b → 2c → 2d），前三步之后 `bun run test` 都必须绿。

- **Step 2a — façade 重实现，旧实现暂不删**（允许路径：`packages/server/src/**`，不含删文件）
  改动：`createByokServer` 改为 `createInMemoryByokCloud`（`composition/in-memory.ts:97`）组合 + `TaskEventRelay`（挂 Step 1f 的 `observer`）+ §3 的 `TaskHandle`（`result()` 走 `cloud.readTaskResult` 读回）；`RateLimiter`（`rate-limiter.ts:81`）改造为 `InboundRateLimiter`（GAP-5）；`tasks.get/list`、`readAgentHomeProjection`、`pairing.createPairingCode`、`egress.get`、`devices.revoke` 转 async（§6 的一次性 breaking）；`machines.list()` 改 `listDevices`+`listPresence` join；`dispatch` 的 `deviceId` **保持 optional**，ambient 分支在 façade 侧用 presence + device row capability 重建（§1.2 的 ADR-034 说明）。`hub.ts`/`ws-server.ts` 等旧文件此刻仍在树上但不再被 `createByokServer` 引用。
  出口：`bun run build && bun run typecheck && bun run test`；Step 0 的 10 条全绿且**未改一行**。
  回滚：单 commit revert，回到 hub 实现。

- **Step 2b — 删除 §1.2 列出的 11 个文件**（允许路径：`packages/server/src/**`）
  改动：删 `hub.ts`(2639)、`http.ts`(496)、`auth.ts`(407)、`sqlite-task-store.ts`(402)、`sqlite-blob-store.ts`(277)、`blob-store.ts`(251)、`ws-server.ts`(236)、`pairing.ts`(214)、`task-store.ts`(184)、`heartbeat.ts`(69)、`ids.ts`(21) ≈ 5,196 行；`index.ts` 的对应导出改为 re-export cloud（`auth` 一组）或删除；`attachWebSocket` 从公开面消失。
  出口：`bun run build && bun run typecheck`；`bun run test` 中 §5「删除」「随实现删除」两类测试同刀删（否则本子步 build 必红——这是本子步与 2d 的边界：这里删的是**被删类的单测**，2d 迁的是**保留语义的测试**）；Step 0 的 10 条仍未改一行且全绿。
  回滚：单 commit revert（文件整体回来）。

- **Step 2c — 三个 `.mjs` 冒烟脚本改长轮询**（允许路径：`packages/client/scripts/*.mjs`）
  改动：`control-socket-check.mjs`（`:74,84,96`）、`ipc-smoke.mjs`（`:71,81,137`）、`adapter-task-smoke.mjs`（`:163,170,173,245,276,326`）去掉 `attachWebSocket`，改长轮询；`adapter-task-smoke.mjs` 的 `dispatch` 显式传 `deviceId`（不是因为它变必填，而是冒烟脚本本就该显式指定目标）。
  出口：`node packages/client/scripts/control-socket-check.mjs`、`node packages/client/scripts/ipc-smoke.mjs`、`node packages/client/scripts/adapter-task-smoke.mjs` 三条各自通过；`templates/service/launchd/smoke-test.sh`、`templates/service/winsw/smoke-test.mjs` 随之绿（它们 spawn 前者，本子步不改它们）。
  回滚：单 commit revert。**这是 §8 R1 的兑现子步，不可与 2b 合并延后。**

- **Step 2d — 迁移/删除 36 个 server 测试**（允许路径：`packages/server/src/__tests__/**`）
  改动：按 §5 分类处理剩余测试——「删除（transport-only）」类整文件或子套删除（`heartbeat.test.ts`、`version-negotiation.test.ts`、`port-shadowing.test.ts`、`integration.test.ts:347` 的 WS 握手子套、`issues-112-120-security-reliability.test.ts` 的 hello timeout / pending-hello / oversized-frame 子套、`integration.test.ts:312` 的 `device.disconnected` 等待逻辑随 §1.2 (A) 一并删）；「保留为 kernel 行为测试」的 23 个文件把 fixture 从 WS 换长轮询，断言**不放宽**；`task-lease.test.ts`(289) 按 §8 R2 的 owner 裁定处理。
  出口：`bun run build && bun run typecheck && bun run test` 全绿；`packages/server/src/__tests__` 中不再有任何 `attachWebSocket` / WS fixture 引用（`grep` 零命中）；`bearer-instance-product.test.ts`(197) 绿（它是 GAP-6 的哨兵，靠 Step 1e 而非放宽断言变绿）。
  回滚：单 commit revert。

**Step 3 — SQLite adapter + examples**（允许路径：`packages/server/src/stores/sqlite/**`、`examples/basic/**`）
只做今天已有的持久化范围：`TaskAttemptStore`、`CloudBlobStore`、`BlobContentProxy`、core `ObjectStore` 四个 port 的 `node:sqlite` 实现，其余保持 in-memory（与今天「task 记录 + blob 字节持久，outbox 不持久」完全等价，`examples/basic/server.ts:59-67` 已如此声明）。用 `runCloudConformance`/`runCoreConformance`（`conformance/src/index.ts:16-19`）验收。`examples/basic` 按 §6 迁移。
出口：conformance 绿；`BYOK_STORE=sqlite` 重启后 task 记录与 blob 字节可读回。回滚：删目录 + examples 退回 in-memory-only。

**Step 4 — 删 daemon WS transport**（允许路径：`packages/client/src/daemon/**`、`packages/client/src/index.ts`、`packages/protocol/src/*`）
删 `ws-transport.ts`(341)；`connection-manager.ts`(982) 去掉 WS 分支与 `degraded` 态（`:228,296,348,442,462,518,898-965`）；`url.ts` 去 `toWsUrl`；`BYOK_WS_PATH` 常量删；`ConnectionState` 联合收窄（`client/src/index.ts:347` 导出形状 breaking）。
出口：`packages/client` 全测绿；`real-cloud-longpoll.test.ts` 绿。回滚：单 commit revert。

**Step 5 — 文档与发布面**（允许路径：`docs/**`、`README.md`、`CHANGELOG.md`、`api-surface/**`）
`docs/architecture/sdk-architecture.md:53,121,316,1033,2078-2085,2102`（ADR-004 措辞改为「server = kernel 的自托管 façade」，不是撤销）、`docs/protocol.md` WS 章节、`examples/basic/README.md:4,105`。更新 WP1 的 `.d.ts` golden：`api-surface/` **已在 main**（10 个 `.d.ts` + `README.md`，由 `2e01c9a` "chore(ci): gate the public type surface and version strings (#123)" 带入；`4cc765f` 上尚不存在——verified 2026-09-03），本步必须同刀重生成 `api-surface/server.d.ts`（`attachWebSocket` 消失、`tasks.get/list` 转 async、`TaskSnapshot` 字段裁剪、`ByokServerEvent` 收窄）与 `api-surface/client.d.ts`（Step 4 的 `ConnectionState` 收窄）。`CHANGELOG.md` 记一次有意 breaking。
出口：`bun run build && bun run typecheck && bun run test`；`bun run check:api-surface`（golden 与实际导出一致）；`bun run check:version-authority`；`bun run check:architecture-sync`；`repo-harness run check-task-workflow --strict`；`node scripts/release/check-package-graph.mjs`；`grep -rn 'attachWebSocket\|BYOK_WS_PATH' docs/ README.md examples/` 零命中。
回滚：单 commit revert（纯文档与 golden，无运行时面）；golden 回滚后 `bun run check:api-surface` 会红，这是预期——它说明代码面与 golden 已脱钩，必须连同 Step 4 一起回滚才是一致状态。

### 跨包写权归属与顺序（WP3A ⇄ WP3B ⇄ WP0）

WP3A 与 WP3B 是并发排期的两把刀，下列路径两包都会写，**每条路径同一时刻只有一个写者**，顺序如下。写权窗口在包的步骤粒度上交接，不在文件粒度上交错。

| 路径 | 写者顺序 | 说明 |
|---|---|---|
| `packages/client/src/agent-home.ts` | WP0 → WP3A S1/S3/S6 | WP0（`codex/agent-home-single-writer`）先合入 main；WP3A S3 在其之上删计数门 |
| `packages/client/src/daemon/task-runner.ts` | WP0 → WP3B Step 4 → WP3A S4/S5/S6 | WP3B Step 4 只做 WS 分支的减法，WP3A S4 是 `:1807-1940` 的重写；减法先落，重写基于最终形状写一次 |
| `packages/client/src/daemon/create-daemon.ts` | WP0 → WP3B Step 4 → WP3A S3/S5 | 同上 |
| `packages/client/src/index.ts` | WP0 → WP3B Step 4 → WP3A S3 | `ConnectionState` 联合收窄（WP3B）与租约类型导出变更（WP3A）都改这一个导出面 |
| `docs/spec.md` | WP0 → WP3B Step 5 → WP3A S7 | |
| `CHANGELOG.md` | WP0 → WP3B Step 5 → WP3A S7 | |
| `api-surface/**` | WP0 → WP3B Step 5 → WP3A S7 | golden 已在 main（`api-surface/client.d.ts` 等 10 个文件，由 `2e01c9a` "chore(ci): gate the public type surface and version strings (#123)" 带入；`4cc765f` 上尚不存在——verified 2026-09-03）。三方各自的 breaking 面必须分三次有意 diff 落，不合并成一次 |

**可并行的窗口**：WP3B Step 0–3 的允许路径只有 `packages/cloud/**`、`packages/cloud-dataplane/**`、`packages/conformance/**`、`packages/server/**`（外加 Step 2 的 `packages/client/scripts/*.mjs`、Step 3 的 `examples/basic/**`），与 WP3A S0–S3 的 `packages/client/src/{__tests__,workspace,agent-home.ts}` 无交集，**可完全并行**。

**必须串行的窗口**：WP3B Step 4 与 WP3A S4/S5 都写 client daemon 面 → 串行，WP3B Step 4 先。WP3B Step 5 与 WP3A S7 都写 `docs/` + `CHANGELOG.md` + `api-surface/**` → 串行且排在两包所有代码步骤之后，WP3B Step 5 先。

**交接纪律**：接手方在自己的步骤开始时重读被交接文件的当前内容与行号，不沿用本包写作时刻的行号；被交接文件上的 required checks 由接手方重跑一遍。

---

## 8. 风险 / 10x / 验证 / 置信度

**R1（最高）— `examples/basic` 与三个 `.mjs` 冒烟脚本是 WS 的真实调用方，不在 §13 审计范围内。** §13 证明的是 Salesko 不用 server/WS，不是仓内无消费者。Step 2 必须同刀改这四处，否则 `templates/service/*` 的 launchd/winsw 冒烟直接断（它们 spawn `control-socket-check.mjs`）。

**R2 — 删 lease reaper 是唯一「非 WS 的能力净损失」。** 暗设备的 task 永远 `pending`，`result()` 永不 resolve（`task-lease.test.ts` 289 行的语义整体消失）。理由：它是协调面持有执行态的判定，重建即重建第二权威；cloud 生产今天就没有它。**这条需要 owner 明确点头**，替代方案是 host 侧超时 + `cancel()`（文档写清）。

**R3 — `cursor_too_old` 分叉今天就存在**（`long-poll-transport.ts:578` 判一个 cloud 永不发的错误码）。若 GAP-3 不做，Step 4 之后所有部署都走 cloud 路径，这条 client 分支变成永久死码，且回收区之后的 cursor 会静默返回空页而非可恢复错误。必须在 Step 1 做。

**R4 — GAP-6 若不同刀，本刀会让 embedded 部署的 bearer 安全姿态**从「有 instance-product 检查」（`index.ts:234-238`）**降级**到 cloud 的 row==claims。`bearer-instance-product.test.ts`(197) 会红，这是好的——它是这条风险的哨兵，不要为了让它绿而放宽断言。

**R5 — SQLite 范围蔓延。** `CloudStores` 是 14 个 port 的 all-or-nothing bundle（`ports.ts:577-582`），加 core 7 个共 21 个；Postgres 版是 9,358 行。若 Step 3 被理解成「完整 SQLite 部署」，本刀翻三倍并推迟 WP4。**明确边界：只做 4 个 port，混装 in-memory，持久化范围与今天逐字相同。**

**10x 首先失效的**：`TaskEventRelay` 的 per-task 无界缓冲（`event-queue.ts:45-47` 从 0 重放且不释放）——10k 并发 task 时 OOM，且今天的 `hub.ts` 同形状。§3 已给出同刀修法（有界环 + 显式截断标记 + 终态 TTL 回收）。第二个是 `tasks.list()` 的全表返回，§6 已改成游标分页。

**Step 2 里唯一被重裁的 Step 0 用例**：case 7。其余九条在 fold 之后逐字通过，只有 case 7 钉的是 `hub.ts` 的重放环（重放已 ack 的行 + 按条数溢出移动 floor），而那是被删的实现件本身，不是协调语义；kernel 的 mailbox 在同一位置给出更强的契约（读不 ack / ack 不可逆 / floor 只由 expiry 移动），Step 2 把该用例改钉在这条契约上，仍然全部打在公开面。重建重放环才是行为倒退——那会在 mailbox 之外再立一个保留权威。详见 §5 第 7 条。

**必需验证**：每步 `bun run build && bun run typecheck && bun run test`；Step 1 追加 `packages/conformance` 全套；Step 2 追加 `node packages/client/scripts/control-socket-check.mjs`、`adapter-task-smoke.mjs`；Step 3 追加 `BYOK_STORE=sqlite` 重启读回；全流程末尾 `repo-harness run check-task-workflow --strict` 与 `node scripts/release/check-package-graph.mjs`。Step 0 的 10 条在 Step 2/3/4 之后必须**零改动**通过——任何一条需要改写，都说明这是行为变更而非重构，须回到本包补裁。

**会改变结论的证据**：(a) 存在本包未发现的 `@byok-sdk/server` 生产消费者（尤其依赖 `attachWebSocket` 或同步 `tasks.get`）；(b) owner 拒绝 R2 的 lease reaper 删除 → 需要在 kernel 里裁一个 attempt 过期权威，Step 1 增一项且 WP4 的 fencing 设计要一起考虑；(c) `api-surface` golden 已在 main 且门禁拒绝本刀的 breaking 面 → Step 5 提前到 Step 0 之后；(d) Step 1 的 `TaskAttempt.claimedRuntime` migration 在 dataplane 上不可在线执行 → GAP-2 降级为「steer 从 façade 移除」，`real-server-longpoll-steer.test.ts` 随之删除。

---

RECOMMENDATION: Execute WP3B as six ≤1-day steps — characterization tests first, then five cloud kernel additions (approve/reject, steer + `claimedRuntime`, `cursor_too_old`, `TaskAttempt` list, instance-product bearer) plus one post-commit observer hook, then reimplement `createByokServer` over `createInMemoryByokCloud` with a read-back-authoritative `TaskHandle` relay, deleting ~5,200 lines including `hub.ts` and both WS transports, with SQLite scoped to exactly today's four-port durability — confidence: HIGH
