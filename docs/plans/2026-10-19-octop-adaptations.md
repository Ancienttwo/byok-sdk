# Octop 适配执行方案（plan）

- **状态**：只有方案，Draft。不含实现代码，不改 spec、PRD 或 ADR。
- **来源**：
  - Octop 调研 [#548](https://github.com/Ancienttwo/byok-sdk/pull/548) @ `98a7087a`（`docs/researches/2026-10-19-tencentcloud-octop.md`，已按外部审阅修订）。
  - 外部审阅意见 A–G（owner 转交）。
- **基线**：`origin/main@27044406`。文中 byok-sdk 的路径和行号都对应这个提交。#548 的节号对应 `98a7087a`。
  - #551–#556 的行号对应 `649f9f0b`。两个提交之间，本文引用的文件只有 `docs/spec.md` 变了：第 18 行后插入了 8 行。
- **权威**：`docs/spec.md` 是产品真相。平台 PRD、产品 PRD、K4 指南和 K8b 计划定义契约。本方案只细化执行。
- **裁定状态**：
  - 第一批和第二批按审阅推荐的推进顺序排期（#548 §3.5）。
  - owner 于 2026-10-19 裁定：§14 的 Q1–Q8 全部按推荐。
  - 第三批两项已确认：§9.2 防休眠选项 B（Q1）；§9.3 cgroup v2 选项 B（Q2），有 Linux 常驻需求时再排期。
  - 第一批先在 `examples/bot-collaboration` 试点（Q3）。
  - §14 列出全部开放问题和裁定。
- **Issue**：#548 修订后，owner 授权开出 6 个 issue：① [#551](https://github.com/Ancienttwo/byok-sdk/issues/551)、② [#552](https://github.com/Ancienttwo/byok-sdk/issues/552)、③ [#553](https://github.com/Ancienttwo/byok-sdk/issues/553)、④ [#554](https://github.com/Ancienttwo/byok-sdk/issues/554)、⑤ [#555](https://github.com/Ancienttwo/byok-sdk/issues/555)、⑥ [#556](https://github.com/Ancienttwo/byok-sdk/issues/556)。
  - issue 定义范围和验收。本方案细化设计和切片。
  - 本方案与 issue 的差异列在 §12。

## 1. 结论

审阅意见要求把建议分成两组，并且不进核心协议。本方案把 6 项建议和 1 组原则拆成可以单独合并的切片。

| # | 项目 | 组 | 归属层 | 批次 | 主要落点 | owner 状态 |
|---|---|---|---|---|---|---|
| ① | 同会话连续输入合并（#551） | Bot/Host 产品体验 | Host 参考实现 | 第一批 | `examples/bot-collaboration/src/coalesce.ts`（新）、`host.ts`、`model.ts` | 审阅推荐；试点位置已确认（Q3） |
| ② | IM 收发契约（#552） | Bot/Host 产品体验 | Host adapter | 第一批 | `docs/host-im-adapter.md`（新）；`examples/bot-collaboration/src/channel.ts`（新） | 审阅推荐 |
| ③ | 执行记录完整性（#553） | SDK 执行可靠性 | SDK adapter 和 daemon；Host 只展示 | 第二批 | `packages/client/src/adapters/*`、`daemon/execution-record.ts`（新） | 审阅推荐 |
| ④ | 取消与落盘故障测试（#554） | SDK 执行可靠性 | 只有文档和测试 | 第二批 | `packages/client/src/__tests__/*` | 已实现，只补测试 |
| ⑤ | Host 防休眠（#555） | Bot/Host 产品体验 | Host 应用（下游）；SDK 仓库只出指南 | 第三批 | K4 指南 §7 新小节；Aiphabee | §9.2 选项 B 已确认（Q1） |
| ⑥ | cgroup v2 进程树收容（#556） | SDK 执行可靠性 | SDK launcher | 第三批，有 Linux 常驻需求时再做 | `adapters/process-tree.ts`、`adapters/cgroup-v2.ts`（新）、`daemon/owned-process-ledger.ts` | §9.3 选项 B 已确认（Q2） |
| 维护 | 维护原则 | SDK 执行可靠性 | SDK daemon；现在只成文 | 随清理、压缩或恢复功能 | `docs/host-local-storage-layout.md` | 审阅推荐 |

全部切片都不改下面这些：

- wire 协议：`packages/protocol` 和 `PROTOCOL_VERSION = 3`。
- K4 执行核心：`examples/host-execution-core/src/core.ts` 和 `transitions.ts`。
- K7 结算：只有成功 terminal 授权应用 outcome；缺少 outcome 的成功运行是不可重试的失败。
- SDK 服务拓扑：不新增服务、队列或定时任务。

公开 API 的变化只在 `@byok-sdk/client`（③ 和 ⑥）。这些变化在各自的 PR 里更新 api-surface golden。①② 只改 example 和文档。

## 2. 共同约束

- 两组分开排期，不进核心协议（审阅意见 A）。
- 不照抄 Octop 的两条做法：「丢弃全部 bot 消息」和「最多合并 20 条」。
- 「取消时等待持久写入」已经实现，不再立项，只补故障测试（审阅意见 C）。
- 不新建维护服务。本地 Agent-home 备份不计入 `TenantStorageEntitlement`（审阅意见 C）。
- 已有设计保留，只补针对性测试，不重构：ContextPack 数据边界、结构化 mention、per-Agent FIFO、能力收窄和凭据 broker（审阅意见 E）。
- 防休眠默认关闭。只在接通电源并且有任务时，阻止系统空闲休眠。它与定时唤醒和醒后补跑互不绑定。
- 配置要求 cgroup 而环境不支持时，拒绝执行，不静默降级。cgroup 不是完整的沙箱。
- 沿用现有不变量：
  - I8：每个委派只有一个结论。
  - I9：结果按执行身份绑定。
  - I10：不从模型正文推导控制语义。
  - I11：一个 Agent home 同时只有一个 writer。
  - A1：Bot 执行拿不到有外部副作用的工具。
  - O10：没有稳态兼容层。
  - 平台 PRD §9.7：不在 SDK 里做 per-Agent 队列，也不用 steer 作为投递路径。
- 每个代码切片都运行根 `CLAUDE.md` 的五项必检：`bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`。
- 真实 Pi 运行是付费调用，需要另行授权。CI 用 fake runtime。

## 3. 基线（P1 / P2 / P3）

### P1：边界

| 边界 | 位置 | 本方案涉及的项目 |
|---|---|---|
| K4 Host 执行核心（copy-and-own） | `examples/host-execution-core/src/`。队列就是 `LedgerState.intents`，按 `sequence` 排序；每个 Agent 的队头在 `core.ts:177-182` 选出 | ①（只读）、⑤（只读） |
| K8 Bot 协作参考实现 | `examples/bot-collaboration/src/`。入口 `BotCollaboration`（`host.ts:39`） | ①、② |
| daemon 执行与结束 | `packages/client/src/daemon/task-runner.ts`。`finishOnce` 在 5373–5498 行 | ③、④ |
| runtime adapter | `packages/client/src/adapters/{pi,claude,codex}/` | ③ |
| launcher 与进程树 | `packages/client/src/adapters/process-tree.ts`、`daemon/owned-process-ledger.ts`、`adapters/win32-job-object.ts` | ⑥ |
| Agent-home lease 与维护准入 | `packages/client/src/agent-home.ts`（`AgentHomeLeaseManager` 536 行，`withIdleHomeLease` 1129 行） | ④、维护 |
| 本地事件面 | `daemon/observer.ts`（`DaemonEvent`）、`daemon/daemon-record.ts`（content-free `DaemonRecord`）、`Daemon.subscribe`（`create-daemon.ts:811`） | ③ |
| 下游 Host | Aiphabee（外部仓库，Topology L）。产品 PRD P6 | ①（可选）、②、⑤ |

### P2：一条真实链路（Bot 忙时用户连发消息）

1. `BotCollaboration.input(key, request)` 生成 Turn id `hash(['user', botId, key])`。同 key 不同文本时抛 `Input identity conflict`（`host.ts:79-93`）。
2. `process()` 调用 `sync()`。`sync()` 给每个还没有 intent 的 Turn 冻结 schema 和 instruction（`schema.ts:103-110`），然后调用 K4 `enqueue`（`host.ts:364-391`）。Agent 是否在忙，不影响这一步。
3. `enqueue` 按 key 幂等。内容不同时抛 `Intent identity conflict`（`transitions.ts:4-20`）。
4. K4 每个 Agent 只放一个 writer 在途。后面的 intent 在 FIFO 里等待（K4 指南 §3，89–95 行）。
5. 所以 Bot 忙时用户连发 3 条，就有 3 个 intent 和 3 次执行。每次执行的输入在入队时冻结。第 1 次执行看不到第 2、3 条，第 2、3 条各自再跑一次。
6. 执行结束时，daemon 按这个顺序收尾：`session.close` 回执（`task-runner.ts:5429`）→ terminal 提交（5431–5435）→ 记忆快照（5443）→ Agent terminal 证据（5444–5474）→ 释放 Agent-home lease（5475–5481）。
7. Host 读到成功 terminal 后，在一个事务里应用 outcome，每个 `taskId` 只应用一次（K4 指南 §8）。

### P3：现在的设计为什么是这样

- 队列在 Host，不在 SDK。队列混合了触发来源、优先级和放弃策略，属于 Host 的策略（平台 PRD §9.7）。所以输入合并只能在 Host 做。
- 输入在入队时冻结并持久化，崩溃后才能按原字节读回（K4 指南 §3，97–98 行）。所以已经入队的 intent 不能改，合并只能发生在入队之前。
- terminal 先落盘再发出，lease 在 terminal 提交之后释放。这条不变量已经实现，只缺少针对取消路径的故障测试。
- Windows 已经用每棵进程树一个 kill-on-close Job Object，把「daemon 死后进程树也死」交给 kernel，并且没有降级路径（`win32-job-object.ts:1-40`）。Linux 和 macOS 只靠进程组加进程表扫描，所以有 POSIX 残留（ADR-037 72 行）。

## 4. ① 同会话连续输入合并

### 4.1 归属层

- Issue：#551。
- Host 参考实现：`examples/bot-collaboration`（copy-and-own）。
- 这是可选策略，默认关闭。
- K4 执行核心、SDK 包和 wire 都不改。
- 试点位置已确认：先在 `examples/bot-collaboration` 做（Q3）。

### 4.2 问题与成功标准

问题见 §3 P2 第 5 条。

成功标准，全部可测：

- **S1**：策略关闭时（默认），行为与现在逐字节相同。Turn id、冻结的 instruction、K4 intent 和投影都不变。现有测试一行不改。
- **S2**：策略开启、Agent 空闲时，第一条输入在同一次 `input()` 调用里入队。它的 Turn id 和 instruction 与关闭时相同。
- **S3**：Agent 忙时，同一合并键的连续输入在窗口内合并成 1 个 Turn、1 个 intent、1 次执行。
- **S4**：窗口从批次第一条输入开始计时，后到的输入不延长它。Agent 变空闲时，批次立即封口，不等窗口到期。
- **S5**：遇到边界时，先封口当前批次，再插入边界 Turn。所有输入在 FIFO 里的相对顺序与关闭时相同。边界包括：
  - 审批（`decide`）、回答（`answer`）和取消（`cancelTurn`）；
  - routine、`bot_request`、`bot_reply`、`continuation`、`action_result` 和 `room_slot` Turn；
  - 发送者、权限或配置发生变化。
- **S6**：已经有 K4 intent 的 Turn 永不修改。合并不会触发 `Intent identity conflict`（`transitions.ts:9-13`）。
- **S7**：不丢消息。
  - 每条输入都有持久记录。
  - 超过条数或字节上限的输入开一个新批次。
  - 单条输入超过 ContextPack 预算时，沿用现有的 `CurrentRequestTooLargeError` 阻塞，用户能看到（`history.ts:29-31`、`host.ts:371`）。
- **S8**：崩溃后恢复。
  - 重启后，到期的批次在 `recover()` 里封口。
  - 重放同一个 `input(key, request)` 返回同一个 Turn id，不会重复入批。
- **S9**：合并不制造新的阻塞。多成员批次的 Request 字节数 ≤ `maxBytes` ≤ `⌊contextMaxBytes / 4⌋`，所以不会触发 `CurrentRequestTooLargeError`。构造时检查这个不等式。

### 4.3 非目标

- 不改 K4 core，不在 SDK 里排队。
- 不合并已经入队的 intent，不加优先级，不重排。
- 不合并群聊输入。`roomInput()` 是边界。
- 不把新消息注入正在运行的执行（steer）。
- 不照抄 Octop 的 20 条上限，不静默丢弃消息，不用会延长的滑动窗口（debounce）。
- 不从正文推导语义，例如不把「算了」当作撤回（I10）。
- 不改 routine 的 `superseded` 规则（`examples/host-execution-core/src/routines.ts:92-94`）。那条规则是 occurrence 去重，不是输入合并。

### 4.4 设计

**配置**（`BotOptions`，`host.ts:21-33`）：

```ts
coalesce?: { windowMs: number; maxItems: number; maxBytes: number };  // 不传即关闭
```

- 建议默认值（开启时）：`windowMs = 10_000`、`maxItems = 8`、`maxBytes = 8_192`（Q4）。
- 构造时校验以下范围。超出时构造函数抛错：
  - `1_000 ≤ windowMs ≤ 60_000`；
  - `2 ≤ maxItems ≤ 16`；
  - `1_024 ≤ maxBytes ≤ ⌊contextMaxBytes / 4⌋`。`contextMaxBytes` 默认 32 KiB（`history.ts:3`）。

**数据**（`examples/bot-collaboration/src/model.ts`）：

- `CollaborationState` 仍是 version 1。新字段在首次使用时初始化，与 `Budget.reserved?` 的做法相同。
- 不用 `batches` 这个名字，因为 Cross-Bot 已经用了它。

```ts
interface UserInput {
  id: string;            // hash(['user', botId, key])，与现在 user Turn 的 id 规则相同
  key: string; botId: string; request: string; bytes: number;
  sender: string;        // 发送者主体；② M2 落地之前固定为 owner
  authority: Authority;
  receivedAt: number;
  batchId: string;
}
interface InputBatch {
  id: string;            // 第一条输入的 id，也是批次 Turn 的 id
  botId: string; key: string;        // key 是合并键
  inputIds: string[]; bytes: number; // bytes 含成帧开销
  openedAt: number; sealAt: number;  // sealAt = openedAt + windowMs，之后不再修改
  state: 'open' | 'sealed';
  sealReason?: 'idle' | 'window' | 'items' | 'bytes' | 'boundary' | 'key_changed' | 'cancel' | 'policy_off';
}
// CollaborationState 新增
inputs?: Record<string, UserInput>;
inputBatches?: Record<string, InputBatch>;
// Turn 新增
inputIds?: string[];
```

**合并键**：`hash([botId, conversationId, sender, authority, configKey])`。

- 参考实现里，1:1 对话的 `conversationId` 就是这个 Bot 的 canonical 对话。
- `configKey = hash([bot.revision, bot.model])`，取自 `BotProfile`（`team-model.ts:4-8`）。

**忙碌判定** `agentBusy(state, botId)`：这个 Bot 有一个 Turn，它既没有 `conclusion`，状态也不是 `blocked`。

**状态机**：每个 Bot 最多有一个 `open` 批次。

```text
input(key, text)
  ├─ 已有同 id 输入：文本相同 → 返回原批次的 Turn id；文本不同 → 抛 Input identity conflict
  ├─ 策略关闭 → 走现有路径（addTurn）
  ├─ 有 open 批次，并且合并键不同、已到 sealAt、条数已满或字节已满 → 先按对应原因封口
  ├─ 有 open 批次 → 追加
  ├─ 没有 open 批次，Agent 空闲 → 建单成员批次，立即封口（idle），建 Turn
  └─ 没有 open 批次，Agent 忙 → 建 open 批次，sealAt = now + windowMs

sync() 开头调用 sealDueBatches(now)。对每个 open 批次：
  now ≥ sealAt → 封口（window）
  Agent 空闲 → 封口（idle）
  合并键与当前配置不符 → 封口（key_changed）
  策略已关闭 → 封口（policy_off）

addTurn(fields) 插入一个新的非 user Turn（fields.id 还不存在）→ 先封口 fields.botId 的 open 批次（boundary）
  幂等重放（fields.id 已存在）不封口

cancelTurn(id)，并且 id 是 open 批次或它的成员 → 先封口（cancel），再走现有的「未入队即取消」路径
```

- 封口时调用 `addTurn({ id: batch.id, root: batch.id, source: 'user', request: batchRequest(batch), hop: 0, authority, inputIds })`。
- 之后 `sync()` 照常冻结并入队。
- 封口后，批次和它的 Turn 都不再修改。

**边界检查为什么放在 `addTurn` 里**：

- 所有 Turn 都经过 `examples/bot-collaboration/src/model.ts:97` 的 `addTurn` 插入：
  - `host.ts:88, 246, 288, 344, 425`；
  - `delegation.ts:92, 135, 170`；
  - routine 经 `host.ts:286-289` 的回调插入。
- `sync()` 按插入顺序物化 Turn，所以插入顺序就是入队顺序。
- 插入边界 Turn 之前先封口，批次就排在边界前面。
- 没有 open 批次时，这个检查什么也不做。所以策略关闭时行为不变（S1）。

**合并后的 Request**：

- 单成员批次：`request` 就是原文，与现在相同（S1、S2）。
- 多成员批次：先写一行说明，再逐条成帧。帧格式沿用 Cross-Bot 的 `frame()`（`delegation.ts:252-256`）：

  ```text
  The owner sent 3 messages while you were busy. Read them in order and answer them together.
  --- message 1/3 (42 bytes) ---
  {"inputId":"…","receivedAt":1760000000000}
  …原文…
  --- end message 1/3 ---
  ```

- 原文只出现一次，不做第二次 JSON 编码。这是 K8b Q8 的教训。
- 字节界：
  - 每条的成帧开销 ≤ 352 字节：元数据行 ≤ 256，帧行 ≤ 96。说明行 ≤ 128。
  - 追加前检查 `batch.bytes + bytes_i + 352 ≤ maxBytes`。不满足时，先封口，再开新批次。
  - `bytes_i + 352 + 128 > maxBytes` 的单条输入自成一个单成员批次，不成帧。所以单条长消息的行为与现在相同。

**计时与恢复**：

- `process()` 的定时器（`host.ts:541-557`）把 open 批次的 `sealAt` 加进 `due` 列表。
- 定时器只是提示。持久状态才是权威（I4）。
- `recover()` 先运行 `sync()`，所以重启后到期的批次会封口。

**投影**：

- 每次状态变化发一个 `input-batch:<batchId>:<revision>`：open 是 1，sealed 是 2。空闲时直接封口的批次只发 2。
- K4 的 `project()` 不允许同一 id 对应不同的值（`examples/host-execution-core/src/model.ts:96-101`）。所以沿用 Cross-Bot 的 revision 做法。
- `bot-turn:<id>` 投影带上 `inputIds`。
- UI 显示（#551 待确认第 4 条；已按 Q4 确认）：
  - 一个批次只有一个回复。UI 只显示一次这个回复，并按 `inputIds` 标出它回答的全部成员消息。
  - IM 渠道把回复挂在最新一条成员消息下（§5.4）。

**失败模式**：

| 情况 | 处理 |
|---|---|
| 封口事务失败 | 事务回滚，批次保持 open。下次 `sync()` 再封口 |
| 追加之后、封口之前进程崩溃 | 重启后，`sealAt` 已过或 Agent 空闲，批次封口。用同一 key 重放返回同一 Turn id |
| 封口后批次 Turn 被阻塞（例如 schema 超预算） | 沿用 `blockTurn`（`host.ts:328-335`）。成员仍然能从 `inputs` 追踪 |
| 用户取消批次 | 整批取消。成员的 `batchId` 不变，仍可追踪 |
| Bot 被归档 | `sync()` 先封口 open 批次。然后按现有规则，把没有 intent 的 Turn 结为 `cancelled`（`host.ts:348`） |

### 4.5 与现有设计的衔接

- **K4 队列**：
  - 批次 Turn 就是一个普通的 user Turn。
  - `intentKey` = Turn id = 第一条输入的 id。`taskId = H(intentKey, generation)` 的规则不变。这回答了 #548 §9.1 和 #551「待 owner 确认」的第 3 个问题。
  - 换代、等待上限和取消读回都不变。
- **ContextPack**：
  - 合并后的文本放在 `Request:`。
  - 历史截断按 2026-10-19 裁定执行（recent-N 加截断提示）。`fitHistory` 不改。
- **K7 结算**：每个 `taskId` 只应用一次 outcome，不变。
- **schema 收窄**：一个批次只有一个 `authority`。所以 schema 收窄（`schema.ts:59`）和应用时的权限检查都不变。
- **Cross-Bot**：
  - `bot_request`、`bot_reply` 和 `continuation` 都是边界。
  - 批次 Turn 是 root。续作预算（每个 root 4 次）和 Bot 预算（每个 root 12 次）按批次计。
- **群聊**：不合并。mention 规则、非 @ 消息只作背景、后加入的 Bot 只看加入后的消息，这些都不变。
- **凭据 broker**：无关。
- **②**：
  - IM 输入的 `key` 用平台消息 id。
  - ② M2 落地后，合并键里的 `sender` 换成验证过的发送者主体。

### 4.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| I1 核心 | `coalesce.ts`：合并键、`admitUserInput`、`sealDueBatches`、`batchRequest`；`model.ts` 的新字段和 `addTurn` 边界；`host.ts` 的 `input()`、`sync()`、`cancelTurn()` 接线；构造校验 | 关闭时逐字节等价；空闲时立即入队；忙碌时合并；窗口不延长；Agent 空闲时提前封口；条数上限；字节上限；单条超长；每种边界各一条用例；发送者、权限或配置不同时不合并；批次入队后到达的输入进新批次；`cancelTurn` 整批取消；identity conflict；随机交错的顺序属性测试 | 无 |
| I2 恢复与投影 | 定时器 `due`；`recover()` 封口；`input-batch:<id>:<rev>` 投影 | 追加后崩溃，重启后只有一个 Turn；重放 `input()` 幂等；投影没有 identity conflict | I1 |
| I3 文档 | `examples/bot-collaboration/README.md` 新增一节；VALIDATION 新增行；K4 指南 §3 加一句：输入合并是入队前的显式 Host 策略 | 五项必检 | I1 |
| I4 下游（可选） | 如果 owner 选 Aiphabee 试点：移植到 Aiphabee 的输入层，用真实 Pi 验收 | Aiphabee 侧测试；真实 Pi 需要另行授权 | I1、I3 |

### 4.7 验收

- **单元测试**：§4.6 列出的测试全部通过。策略关闭时，现有 `examples/bot-collaboration` 测试不改一行。
- **属性测试**：随机生成用户输入、routine、answer、decide、cancel 和委派的交错序列。断言以下四条：
  1. 每条输入恰好属于一个批次。
  2. 把批次展开成成员后，FIFO 顺序等于到达顺序。
  3. 没有已经入队的 intent 被修改。
  4. 多成员批次的 Request 不超过 `maxBytes`。
- **集成测试**：真实 SDK transport 加 fake runtime，做法同 `host.test.ts`。Agent 忙时连发 3 条，只多 1 次执行。fake runtime 收到的 instruction 里有 3 个帧。
- **必检**：五项必检。只改 example，api-surface golden 不变。
- **三平台**：不适用。这是纯 TypeScript，在 Linux CI 上运行。

### 4.8 风险与回退

- **语义**：后一条消息可能修改前一条的意图。模型同时看到全部消息，并按顺序回答。Host 不做语义判断。
- **延迟**：从第二条开始，输入最多多等 `windowMs`，再加上当前执行的时长。Agent 空闲时没有额外延迟。
- **预算**：合并后共用一个 root，所以 Bot 预算（12）和续作预算（4）按批次计，比按条计少。试点要记录这个差异（Q4）。
- **ContextPack 新鲜度**：窗口到期时 Agent 可能还在忙。这时批次先入队等待。它的 ContextPack 在入队时冻结，看不到前一次执行的结论。现在任何排队中的 Turn 都是这样。
- **回退**：关闭 `coalesce`（它默认就是关闭），或者 revert example PR。不需要数据迁移，因为批次 Turn 就是普通 Turn。

## 5. ② IM 收发契约

### 5.1 归属层

- Issue：#552。
- Host adapter：下游 Host 的 IM 渠道层，例如 Aiphabee。
- SDK 仓库交付三样东西：
  1. 新文档 `docs/host-im-adapter.md` 里的契约文本。K4 指南链接到这个文档（#552 的建议）。
  2. `examples/bot-collaboration` 里可以复制的参考模块：类型、纯状态机和 fake channel 合约测试。
  3. 参考 Host 里的发送者主体和投递接线。
- 不接入任何真实 IM 平台，不改 SDK 包和 wire。
- 产品 PRD 把外部事件触发列为 v1 非目标，并写明 SDK 不接收外部事件（产品 PRD 279 行）。本项只定义 Host 侧的契约。

### 5.2 问题与成功标准

平台 PRD 没有 IM 章节（#548 §3.1 第 2 条）。Host 自己接 IM 时，容易重复 Octop 的反例（#548 §4 第 1 条和 §3.1 第 2 条）：

- 回复凭据被当作推送目标。
- 群成员被当作 owner。
- 超时后盲目重发。
- 中间进度刷屏。
- bot 消息互相触发。

成功标准（编号供 Host 指南和测试引用）：

- **R1 路由分开**：
  - 回复路由绑定一条入站消息，有过期时间。
  - 推送路由需要用户显式开启，并指定目标。它可以撤销。
  - 测试：没有推送路由时，routine 结果不发到 IM，只记 `no_push_route`。
  - 测试：回复凭据过期，或者它的 Turn 已结算后，不再使用这个凭据。
  - 测试：回复凭据不会写进推送路由表。
- **R2 真实发送者**：
  - 每条入站消息带验证过的发送者主体。adapter 给不出主体时，拒绝这条消息。
  - 只有 owner 主体可以做这些操作：审批卡片、回答问题、取消 Turn、结束委派和触发 1:1 执行。
  - 测试：群成员 B 审批 owner 的卡片，被拒绝并写入审计。
- **R3 投递三态**：
  - 投递结果分为 `accepted`、`rejected` 和 `unknown`。
  - 调用开始后超时或连接中断，记为 `unknown`，不自动重发。
  - 平台明确拒绝并且可以重试时（例如带 Retry-After 的 429），按上限重试。
  - 重启时仍是 `sending` 的投递，记为 `unknown`。
  - 测试：注入超时后，`send` 只被调用一次。
- **R4 只发最终结果**：
  - 默认只投递 Host 已接受的 `messageEgress` 消息和 Host 自己的卡片。
  - 草稿（#500 draft lane）和 typed activity 不发。
  - 测试：N 次草稿更新，IM 发送 0 次。
- **R5 bot 消息不触发执行**：
  - bot 发出的入站消息默认不触发执行。
  - 在群里，它记为背景，与非 @ 消息的规则相同。在 1:1 里，它只写审计。
  - 自己发出的消息的回显用于投递对账，不再作为入站消息。
  - Bot 之间的协作只走 `delegate`。
  - 测试：bot 消息带结构化 mention，产生 0 个席位、0 次执行。
  - 测试：回显把 `unknown` 投递改为 `accepted`。
- **R6 结构化点名**：
  - 群里点名只来自平台的 mention 实体，不扫描正文（I10、G1）。
  - 测试：正文里有「@Bot」但没有 mention 实体，产生 0 个席位。
- **R7 渠道凭据**：
  - bot token 和 webhook secret 由 Host broker 保存在 OS 凭据库里。它们不进 Bot 执行的 toolset，也不明文入库。
  - 渠道注册后状态是 `unverified`。真实探测成功后，状态才是 `connected`。

### 5.3 非目标

- SDK 包里的 IM 投递、IM 平台 SDK 和平台特定格式。
- 新的 wire 字段或协议消息。
- 用 `AgentMessageDispositionPayload` 的 `accepted | held | refused` 表示 IM 投递结果。那个字段属于 Agent 回复消息的处置（`packages/protocol/src/messages.ts:509-522`）。
- 默认开启主动推送。
- 「丢弃全部 bot 消息」。
- 对 `unknown` 自动重发。声称端到端 exactly-once。
- 把草稿或进度流式发到 IM。
- 用 IM 文本命令（例如 `/approve`）审批。平台提供可以验证主体的按钮回调时，才接受审批。

### 5.4 设计

**参考模块** `examples/bot-collaboration/src/channel.ts`（新）：

```ts
interface Principal { id: string; kind: 'human' | 'bot' }        // adapter 已验证
interface InboundMessage {
  channel: string; platformMessageId: string;
  conversation: { kind: 'direct' | 'group'; id: string };
  sender: Principal; text: string;
  mentions: string[];          // 从平台 mention 实体映射出的 Bot id
  replyRoute?: ReplyRoute; receivedAt: number;
}
interface ReplyRoute { kind: 'reply'; channel: string; inboundId: string; token: string; expiresAt: number }
interface PushRoute {
  kind: 'push'; id: string; channel: string; target: string;
  optedInBy: string; optedInAt: number; revokedAt?: number;
}
type DeliveryState = 'pending' | 'sending' | 'accepted' | 'rejected' | 'unknown';
interface Delivery {
  id: string;                  // H(taskId, messageId, routeKey)；平台支持时也用作幂等键
  taskId: string; messageId: string; body: string;
  route: { kind: 'reply'; inboundId: string } | { kind: 'push'; pushRouteId: string };
  state: DeliveryState; attempts: number; nextAttemptAt?: number;
  platformMessageId?: string; code?: string;
}
interface ChannelPort {
  send(input: { deliveryId: string; route: ReplyRoute | PushRoute; body: string }, signal: AbortSignal): Promise<
    | { result: 'accepted'; platformMessageId: string }
    | { result: 'rejected'; code: string; retryable: boolean; retryAfterMs?: number }>;
  readback?(deliveryId: string): Promise<'accepted' | 'absent' | 'unsupported'>;
}
```

**入站分类** `classifyInbound(message, state)`：

| 条件 | 结果 |
|---|---|
| adapter 给不出验证过的主体 | 拒绝，审计 `unverified_sender` |
| `platformMessageId` 是自己发出的消息 | 回显：只做投递对账，不作为入站消息 |
| 发送者是 bot，1:1 对话 | 只写审计，不建 Turn |
| 发送者是 bot，群 | 记为群背景，0 个席位 |
| 人类，1:1，主体是 owner | `input(platformMessageId, text, { sender })`，进入 ① |
| 人类，1:1，主体不是 owner | 拒绝，审计 `not_owner`（v1 推荐，见 Q6） |
| 人类，群 | `roomInput(platformMessageId, roomId, text, mentions)`，`from` 记主体 id |

**投递状态机**：

```text
pending ──先持久化 sending，attempts + 1──▶ sending ──send()──▶ accepted
                                              │             └─▶ rejected，可重试，attempts < 3
                                              │                  → pending；nextAttemptAt = max(retryAfter, 1 s × 2^n)，上限 60 s
                                              │             └─▶ rejected，不可重试或次数用尽 → 终态，UI 显示原因
                                              └─超时、连接中断或进程重启──▶ unknown
unknown ──readback 返回 accepted，或收到回显──▶ accepted
unknown ──readback 返回 absent（平台能确定没收到）──▶ pending
unknown ──用户手动重发──▶ 新的 Delivery（新 id）；旧记录留作审计
```

- 调用 `send` 之前，先持久化 `sending`。所以崩溃后看到 `sending`，只能记为 `unknown`。S10-F1 对不确定 outbox I/O 的处理也是这样（`s10-f1-terminal-recovery.test.ts:274`）。
- 发送超时默认 15 s。Host 可以配置。
- 回复路由在入站时持久化。Turn 结算或回复路由过期后，删除它的 token。
- 长任务结束时回复路由可能已经过期。这时有推送路由就用推送路由，没有就只在 Host UI 显示，并记 `reply_route_expired`。
- 批次（①）的回复用最新一条成员的回复路由。

**参考 Host 接线**：

- `BotOptions.owner?: string`：owner 主体 id，默认 `'owner'`。
- 这些方法增加可选的 `principal` 参数，默认是 owner：`input`、`roomInput`、`answer`、`decide`、`cancelTurn`、`abandonDelegation`。只限 owner 的操作检查这个参数。
- `roomInput` 传入主体时，`rooms.ts:45` 的 `from` 记主体 id。不传时保持 `'user'`，现有测试不变。ContextPack 的群消息本来就有 `from` 字段。
- `consumeMessage`（`host.ts:152-174`）在接受消息的同一个事务里，为需要 IM 投递的 Turn 写一条 `pending` 的 `Delivery`。
- `process()` 新增 `flushDeliveries()`，位置与 `flushCards()` 相同（`host.ts:526`）。

### 5.5 与现有设计的衔接

- **消息接受**：沿用 `consumeMessage` 的绑定检查和首次接受规则，以及 spec「Host exact Agent message disposition readback」一节。IM 投递只发生在 Host 接受之后。
- **K4 队列**：不变。投递是 Host 的 outbox，做法与 `flushProjections` 相同：持久行、稳定 id、确认后才移除（K4 指南 §8）。区别是 IM 平台通常不按 id 去重，所以超时记 `unknown`，不重发。
- **ContextPack**：群消息的说话人 id 进入 `room.messages`。非 @ 消息只作背景，后加入的 Bot 只看加入后的消息，这些规则不变。
- **K7 结算**：不变。
- **Cross-Bot**：Bot 之间只走 `delegate`：去重 key 是 `H(A.taskId, 'delegate', index)`，hop ≤ 4，每个 root 的预算是 12（`delegation.ts:11-12, 125-170`）。
- **schema 收窄**：不变。只限 owner 的动作在 Host API 层检查主体。
- **凭据 broker**：渠道 secret 按 `examples/salesko-connector-broker` 的方式，经 `@byok-sdk/keys` 保存在 OS 凭据库里。Bot 执行已经拒绝 connector toolset（`host.ts:51`）。
- **①**：IM 的 `platformMessageId` 作为输入 key。批次的回复用最新成员的回复路由。

### 5.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| M1 Host 指南 | 新文档 `docs/host-im-adapter.md`（英文，与 K4 指南一致）：R1–R7、投递状态机、检查清单。`docs/host-execution-core.md` §1 末尾加一行链接。§11 的清单对应平台 PRD §12.10，不改 | 文档评审 | 无 |
| M2 发送者主体与入站分类 | `channel.ts` 的类型和 `classifyInbound`；`BotCollaboration.receive(inbound)`；`BotOptions.owner`；只限 owner 的 API 增加 `principal` 参数；`rooms.ts` 的 `from` | 主体未验证 → 拒绝；1:1 非 owner → 拒绝；非 owner 审批 → 拒绝；bot 消息不触发执行；正文里的 @ 不点名；群消息带主体 | M1；在 ① I1 之后合并，避免同改 `host.ts` 冲突 |
| M3 投递 outbox | `Delivery` 状态机；`BotOptions.channel`；`consumeMessage` 写投递；`flushDeliveries`；开启和撤销推送路由的 API；重启时 `sending → unknown` | fake `ChannelPort`：超时 → `unknown`，只 send 一次；429 → 按 Retry-After 重试；不可重试的拒绝；回显对账；readback；没有推送路由时 routine 不发；草稿不发；崩溃后恢复 | M2 |
| M4 下游 | Aiphabee 的真实渠道 adapter 跑 M2 和 M3 的合约测试 | Aiphabee 侧 | M3 |

### 5.7 验收

- M2 和 M3 的单元测试和 fake channel 合约测试全部通过。
- 合约测试导出为可复用的测试工厂 `channelContract(port)`。下游 adapter 用同一组用例测试自己的实现。
- 五项必检。只改 example 和文档。
- 三平台：不适用。真实平台的验收在下游做。

### 5.8 风险与回退

- 平台没有幂等键时，`unknown` 的消息可能已经送达。用户需要看到「可能未送达」和手动重发入口（Q7）。
- 回复凭据可能在长任务结束前过期。
- 群主体映射错误会让非 owner 拿到审批权。adapter 用平台签名的数据做映射，并有测试覆盖。
- 回退：M2 和 M3 是 example 代码，直接 revert。M1 是文档。

## 6. ③ 执行记录完整性

### 6.1 归属层

- Issue：#553。
- SDK adapter 提供证据（`packages/client/src/adapters/*`）。
- daemon 把证据汇总成本地诊断记录（`packages/client/src/daemon/`）。
- Host 只负责展示。
- 第一刀不进 wire。记录经 daemon 的本地事件面交给 Host：`Daemon.subscribe`、control socket 的 `tasks.subscribe` 和 `audit.jsonl`。

### 6.2 问题与成功标准

K7 的成功只说明 runtime 正常结束并暂存了 outcome。它不说明 SDK 看到了完整的执行轨迹。现状如下（#548 §3.2 第 1 条，已核对）：

- Pi 的映射器无状态，不检查 `tool_execution_start` 和 `tool_execution_end` 是否配对（`adapters/pi/events.ts:118-136`）。
- Pi 无法解析的行被静默丢弃（`adapters/pi/rpc-client.ts:255-261`）。未知帧只在退出错误里汇总（`rpc-client.ts:170-178`）。
- Claude 的孤立 `tool_result` 把工具名记为 `unknown`（`adapters/claude/events.ts:250-254`）。
- Codex 在中断时给未完成的调用补合成结果（`adapters/codex/projection.ts:192-208`）。
- `DaemonTurnRecord` 只统计 `toolUses` 和 `toolResults` 的数量，不按 id 配对（`daemon/daemon-record.ts:87-88`）。
- 诊断文档的规则是：缺少证据就保持未知（`docs/agent-diagnostics-integration.md:174-176`）。

成功标准：

- **D1**：每个已认领的执行结束时（complete、failed 或 cancelled），daemon 产生一条记录 `{ status, source, gaps }`。
- **D2** 状态规则：
  - `complete`：来源已声明，每个 `toolCallId` 恰好有一个结果，没有被丢弃的帧，看到了 `turn_end`。
  - `partial`：来源已声明，至少有一个缺口。
  - `unknown`：来源没有声明，或证据超过上限，或 Host 读不到记录（例如 `daemon_interrupted`）。
- **D3**：记录不改变 terminal 类型、`retryable`、outcome 应用和 K4 结论，也不触发重跑。测试断言：有没有记录，terminal 字节都完全相同。
- **D4**：Pi 先验证。T0 证明 Pi 1.3.0 在四种情况下的事件配对行为：正常、工具报错、中断和进程被杀。T0 通过之后，Pi 才声明证据来源。
- **D5**：记录只有计数和封闭的原因码，不含工具输入和输出。这与 `DaemonRecord` 的 content-free 规则一致（`daemon-record.ts:8-23`）。单条记录 ≤ 1 KiB。
- **D6**：
  - Topology L 的 Host 能读到记录，方式是 `Daemon.subscribe`（`create-daemon.ts:811`）或 control socket。
  - Topology H 读不到。文档写明这一点（Q5）。

### 6.3 非目标

- wire 字段，例如 `task.complete` 上的可选字段。这是核心协议改动，留给 Q5。
- 改 K7 结算或 `result_not_submitted` 规则（`docs/spec.md:2573`）。
- 按状态自动重试、换代或重跑。
- 保存 transcript 或工具内容。读取 Claude 或 Codex 的本地会话文件。
- 检查「有没有最终回答」。Bot 的最终回答走 `messageEgress`，不是 assistant 文本，所以这一项不可靠，不算缺口。

### 6.4 设计

```ts
type ExecutionRecordStatus = 'complete' | 'partial' | 'unknown';
type ExecutionRecordGap =
  | 'unpaired_tool_call' | 'orphan_tool_result' | 'duplicate_tool_result'
  | 'synthetic_tool_result' | 'decode_dropped' | 'unmapped_frame'
  | 'stream_ended_early' | 'no_turn_end' | 'spill_unstored';
type ExecutionRecordUnknown = 'source_not_declared' | 'evidence_overflow';
interface ExecutionRecord {
  taskId: string; terminal: 'complete' | 'failed' | 'cancelled';
  status: ExecutionRecordStatus; source: 'event-stream' | 'none';
  gaps: Array<{ reason: ExecutionRecordGap; count: number }>;
  unknownReason?: ExecutionRecordUnknown;
}
```

- **来源声明**：
  - `RuntimeAdapterDescriptor`（`types.ts:215`）新增可选字段 `trajectoryEvidence?: 'event-stream'`。
  - `freezeRuntimeAdapterDescriptor`（`types.ts:492`）按字段名复制，要同时改。
  - 自定义 adapter 不声明时，状态是 `unknown`。
- **adapter 计数**：
  - `Session`（`types.ts:165`）新增可选方法 `evidence?(): { decodeDropped: number; unmappedFrames: number; syntheticToolResults: number }`。
  - Pi 在 `onLine` 的 catch 分支计数。T0 先确认 Pi 正常运行时 stdout 有没有非 JSON 行。如果有，只计以 `{` 开头但解析失败的行，避免误报。
  - 这时 #553 的验收「无法解析的行被计数」按 T0 的结论收窄，并在 #553 里记录原因。
  - Claude 和 Codex 用已有的 `recordUnmappedFrame` 计数。
  - Codex 统计合成结果的个数。
- **累加器** `daemon/execution-record.ts`（新）：
  - 它在 `pump`（`task-runner.ts:3986`）里、批处理之前读取每个 `AgentEvent`。
  - 它按 `toolCallId` 记录未闭合的调用，上限 4 096 个。超过上限时，状态是 `unknown`，原因是 `evidence_overflow`。
  - `tool_result` 带 `spill.unstoredReason` 时，计入 `spill_unstored`。
  - runtime 流在 `turn_end` 之前结束时，计入 `stream_ended_early`。
- **发布**：
  - terminal 提交之后，`finishOnce` 调用新的可选依赖 `TaskRunnerDeps.onExecutionRecord`。它与 `onRuntimeDisposalFailure`（`task-runner.ts:486`）是同一类依赖。
  - 每个 task 只发布一次。
  - `create-daemon.ts` 把它接到 observer：新增 `DaemonEvent` 种类 `execution-record`，以及同名的 `DaemonRecord` 种类（本来就是 content-free）。
- 计算只在内存里做，不阻塞 terminal 和 lease 释放。发布失败只记日志。
- 没有记录的 terminal（例如 `daemon_interrupted`）由 Host 显示为 `unknown`。

### 6.5 与现有设计的衔接

- **K7 结算**：不变。先定 terminal，后发记录，二者互不影响。
- **K4 队列**：不读这条记录。结论规则（`core.ts:419-446`）不变。
- **诊断文档**：新增「execution record」一节。沿用「缺少证据保持未知」和「exit code 0 不代表检查通过」的写法。
- **adapter 能力文档**：矩阵（`docs/adapter-capabilities.md:11-22`）新增一行「trajectory evidence」。Pi 现在标为未重新认证（同文件 32–36 行），所以 Pi 的单元格需要 T0 的新证据。
- **公开面**：`@byok-sdk/client` 的 `RuntimeAdapterDescriptor`、`Session`、`DaemonEvent` 和 `DaemonRecord` 有新增。api-surface golden 在同一个 PR 里更新。`packages/protocol` 不变。
- **ContextPack、Cross-Bot、schema 收窄、凭据 broker**：无关。
- **Host 展示**：参考 Host 没有 daemon 句柄，所以不做展示接线。Host 指南写明读取方式和文案：`complete` 只表示采集检查通过。

### 6.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| T0 Pi 配对验证 | 读固定的 Pi 1.3.0 闭包里发出事件的代码；用合成 RPC 记录覆盖正常、工具报错、中断和进程被杀四种情况；结论写进 `docs/notes/`。真实 Pi 跑一次是付费调用，需要另行授权 | 合成记录测试，不改产品代码 | 无 |
| T1 累加器与 Pi | `execution-record.ts`；`Session.evidence` 和 descriptor 字段；Pi 计数和声明；`onExecutionRecord`；`DaemonEvent` 和 `DaemonRecord` 的新种类；api-surface | 配对、孤立、重复、解码丢弃、提前结束、上限；`StubRuntimeAdapter` 集成测试覆盖 complete、partial、unknown；不变性测试覆盖 terminal 字节、K4 结论、没有重试 | T0 |
| T2 Claude 与 Codex（待定） | 两个 adapter 的计数和声明；能力矩阵新行 | 合成流测试；Codex 中断时补的结果 → `partial`（`synthetic_tool_result`） | T1；Pi 验证之后由 owner 决定是否做（#553 范围第 5 条，Q5）。决定之前，这两个 adapter 不声明来源，记录是 `unknown` |
| T3 文档 | `docs/agent-diagnostics-integration.md` 新增一节，写明读取方式和展示文案（#553 范围第 4 条）；K4 指南新增一段；adapter 能力文档 | 五项必检 | T1 |

### 6.7 验收

- §6.6 的单元测试和集成测试全部通过。不变性测试是硬门槛。
- `bun run check:api-surface` 的 diff 只有新增。
- 三平台：累加器是纯逻辑，Linux CI 跑全部单元测试。macOS 和 Windows 依赖已有的 adapter lifecycle smoke job（`.github/workflows/ci.yml:254`）。Pi 配对证据的范围以 T0 的记录为准。

### 6.8 风险与回退

- **误报 `partial`**：Pi 可能在中断时本来就不发 end 事件。T0 先确认。如果确认，这种情况的原因码是 `unpaired_tool_call`，文案说明「执行被中断」。
- **用户误读**：用户可能把 `partial` 当成失败。Host 文案要说明它只是采集诊断。
- **公开面增长**：新增的都是可选字段。发布前可以直接 revert。发布后按 O10 处理，不留兼容层。

## 7. ④ 取消与落盘故障测试

### 7.1 归属层

- Issue：#554。
- 归属层是「文档与测试 only」。本项只加测试，不改生产代码。
- 测试发现缺陷时，另开 bug issue，用单独的 PR 修复。不在补测试的 PR 里顺手修改。

### 7.2 问题与成功标准

已经实现的不变量在 `TaskRunner.finishOnce`（`task-runner.ts:5373-5498`）：

1. `awaitActiveSessionClose`（5429 行）。失败时报告 `onRuntimeDisposalFailure`，返回 `false`，保留任务和 lease（1928–1953 行）。
2. `awaitTerminalCommit`（5431–5435 行）。失败时返回 `false`，保留任务和 lease。
3. 记忆快照（5443 行）。失败只记日志（`quiesceAndSnapshotAgentMemory`，3744 行）。
4. Agent terminal 证据，最多尝试 3 次，失败只上报一次（5444–5474 行）。
5. 释放 Agent-home lease（5475–5481 行）。失败时记日志，返回 `false`。然后释放 Git lease（5482 行）。

另外：

- `finish()` 让并发的结束请求共用一次尝试（5365–5371 行）。
- `settleSemanticTerminal` 让第一个 prepare 决定 terminal（5501–5531 行）。
- cancel 的 prepare 先发 interrupt，再启动 `session.close`，但不等它完成（`interruptBounded`，1985–2003 行）。
- terminal 发出时，daemon 立即把它排进 journal 提交（`create-daemon.ts:2261-2273`）。所以 terminal 提交和 `session.close` 同时进行。`finishOnce` 等这两件事都完成。

成功标准：

- **F-a**：#554 的 8 个场景各有一个测试。下面的覆盖矩阵已按基线读过每个已有测试的发起方。F1–F3 的 PR 描述按矩阵的行引用。
- **F-b**：每个新测试都由 cancel 发起结束流程（#554 验收）。每个测试断言四件事：
  1. 只有一个 terminal。
  2. terminal 提交之前不释放 lease。
  3. lease 最多释放一次。
  4. lease 释放之前，同一 Agent 不能有第二个 writer：新 offer 收到 `agent_home_writer_busy` decline，或者 `agentHome.acquire` 抛错。释放之后可以。
  - 例外：1a 的 lease 要等重试成功才释放；1d 的释放本身失败。这两个测试改为断言失败被报告。
- **F-c**：强杀测试复用 `execution-recovery-kill.test.ts` 的编译 daemon 夹具，在现有的 macOS CI job 里运行（`.github/workflows/ci.yml:221-243`）。平台限制写在测试里，并说明原因。
- **F-d**：时序只用 deferred 闸门和注入点控制，不用固定的 sleep。

覆盖矩阵。「发起方」是先开始结束流程的一方：

| 故障类 | 场景 | 已有测试 | 状态 |
|---|---|---|---|
| 基线 | cancel 发起；close 完成之前，home 一直被持有 | `agent-home-single-writer.test.ts:231` | 已覆盖 |
| 写失败 | revoke 失败，之后由 cancel、shutdown 或 finalization 重试 | `s10-f1-terminal-recovery.test.ts:128` | 已覆盖 |
| 写失败 | cancel 发起；revoke、close 和 terminal 提交依次阻塞，home 一直被持有 | `s10-f1-terminal-recovery.test.ts:238` | 已覆盖 |
| 写失败 | cancel 发起；terminal 提交失败，重试成功之后才释放 | `s10-f1-terminal-recovery.test.ts:258` | 已覆盖 |
| 写失败 | cancel 发起；outbox I/O 不确定 → 隔离 | `s10-f1-terminal-recovery.test.ts:274` | 已覆盖 |
| 写失败 | cancel 发起；发送失败 → 按原字节重发 | `s10-f1-terminal-recovery.test.ts:217` | 已覆盖 |
| 写失败 | `session.close` 失败 | `task-runner-close-receipt.test.ts:94`、`agent-home-single-writer.test.ts:199`，都由 `turn_end` 发起 | 缺口 1a：cancel 发起 |
| 写失败 | 记忆快照失败 | — | 缺口 1b |
| 写失败 | `recordTerminal` 一直失败 | `agent-home-contract.test.ts:607`（启动失败）、`agent-home-contract.test.ts:651`（`turn_end` 发起） | 缺口 1c：cancel 发起 |
| 写失败 | Agent-home lease 释放失败 | `agent-home-contract.test.ts:763`，由 `turn_end` 发起 | 缺口 1d：cancel 发起 |
| 重复取消 | cancel 发起；revoke 阶段再收到 cancel 和 shutdown | `s10-f1-terminal-recovery.test.ts:164` | 已覆盖 |
| 重复取消 | `turn_end` 发起；close 阶段再收到 cancel 和 shutdown | `task-runner-close-receipt.test.ts:53` | 已覆盖 |
| 重复取消 | cancel 发起；`session.close` 等待期间再收到 cancel 和 shutdown | — | 缺口 2a |
| 重复取消 | cancel 发起；terminal 提交等待期间再收到 cancel 和 shutdown | — | 缺口 2b |
| 重复取消 | 排队中的 offer 被重复 cancel；完成后再 cancel | `task-runner-cancel-native.test.ts:246, 393` | 已覆盖 |
| 重复取消 | cancel 在 offer 之前到达；启动 handoff 期间 cancel | `task-runner-cancel-race.test.ts:178`；`s10-f1-terminal-recovery.test.ts:304` | 已覆盖 |
| 强杀 | 运行中 SIGKILL：先结束残留进程，再发 `daemon_interrupted` | `execution-recovery-kill.test.ts:395` | 已覆盖 |
| 强杀 | terminal 提交之前或之后 SIGKILL | `execution-recovery-kill.test.ts:525, 550`，都由完成发起 | 缺口 3a、3b：cancel 发起 |
| 强杀 | 多次死亡后仍保留云端取消 tombstone | `execution-recovery-kill.test.ts:725` | 已覆盖 |
| 强杀 | 上面各项在 Linux 上运行 | 套件只在 darwin 运行（`execution-recovery-kill.test.ts:372`） | 缺口 K3（本方案新增，不在 #554） |

各缺口的期望。按现有设计写，已对照代码：

- **1a** cancel 发起，`session.close` 失败：
  - `task.cancelled` 只发一次。`onRuntimeDisposalFailure` 收到一次报告。
  - 任务和 lease 保留。之后的 cancel、shutdown 或 `retryTerminalFinalization` 重试 close。
  - close 成功、terminal 提交确认之后，才释放 lease。
- **1b** cancel 发起，记忆快照失败：
  - 任务照常结束，lease 被释放，日志里有这次失败。
  - 快照只在安全文件系统可用时运行：Linux 原生，或 macOS 配置了 helper（`agent-memory.ts:176-184`）。测试按同样的条件跳过，并写明原因。
  - 注入方式：给 `TaskRunnerDeps.agentMemoryHostedProjection`（`task-runner.ts:689`）一个会抛错的实现（推断，F1 核对）。
- **1c** cancel 发起，`recordTerminal` 一直失败：
  - cancel 的 prepare 尝试 3 次（`task-runner.ts:4473`、5230–5272），`finishOnce` 再尝试 3 次。`agent-home-contract.test.ts:651` 在完成路径上断言同样的 2 × 3 次。
  - `onAgentTerminalEvidenceFailure` 只报一次。任务结束，lease 被释放。
- **1d** cancel 发起，lease 释放失败：
  - 沿用 `agent-home-contract.test.ts:763` 的做法：从外部改写 lease marker。
  - 错误写入日志，`finishOnce` 返回 `false`（5480 行），任务被移出。terminal 只发一次。
- **2a** cancel 发起，在 `session.close` 等待期间再收到 cancel 和 shutdown：
  - close 只调用一次。`closeActiveSession` 复用同一个 `disposalAttempt`（1921 行）。
  - terminal 只发一次。`settleSemanticTerminal` 只认第一个决定。
  - lease 只释放一次。`finish` 共用同一个 `finalizationAttempts` 条目。
- **2b** 同 2a，但发生在 terminal 提交等待期间。用 `awaitTerminalCommit` 闸门，做法同 `task-runner-close-receipt.test.ts:53`。
- **3a** cancel 之后、terminal 提交之前 SIGKILL：
  - 用现有的 journal 故障点 `terminal:before-commit`（`daemon/journal/sqlite-journal.ts:674`）。故障点在事务里，所以 terminal 行被回滚。
  - 用夹具的云端 `cancelTask` RPC 发起 cancel。现有用例只在 daemon 停止后调用它（`execution-recovery-kill.test.ts:515, 735`）。它能否把 `task.cancel` 送到运行中的 daemon，F3 先核对（推断）。
  - 期望：runtime 不重跑（`starts()` 只有 1 条）。重启后只确认一个 terminal：`task.fail{daemon_interrupted, retryable: false}`，同 `execution-recovery-kill.test.ts:525`。
  - 云端 attempt 保持 `cancelled`。依据是 `:725` 的取消 tombstone 规则（推断，F3 实测）。
- **3b** terminal 提交之后、lease 释放之前 SIGKILL：
  - 用现有的 journal 故障点 `terminal:after-commit`（677 行）。它在提交返回给 `finishOnce` 之前触发，所以 lease 还没有释放。
  - 期望：重启后按原字节重放 `task.cancelled`，断言方式同 `execution-recovery-kill.test.ts:550`。不生成新的结论，runtime 不重跑，lease 被回收。
- 3a 和 3b 都用 `agentHome: true` 配置（`execution-recovery-kill.test.ts:803` 已有先例），检查重启后同一 Agent 只有一个 writer。夹具没有 Git workspace 时，在测试里写明。

### 7.3 非目标

- 重做「取消时等待持久写入」。
- 改变 `finishOnce` 的顺序或语义。
- 改 K7 结算或 wire。
- OS 崩溃导致的 NTFS 回滚（#522）。
- Host 侧的重复取消：
  - K4 `cancel` 只写一个 `cancelReason` 字段（`examples/host-execution-core/src/core.ts:105-113`）。重复调用写入同一个值。
  - 未入队 Turn 的重复 `cancelTurn` 已有测试（`examples/bot-collaboration/src/context-budget.test.ts:173`）。
- 复现 #521。#521 已由 #526 修复。回归测试是 `agent-memory-helper-crash.test.ts:213`。
- 在测试里用 sleep 计时。

### 7.4 设计（测试方法）

- **1a–1d、2a、2b**：
  - 用现有的 `TaskRunner` 夹具：`s10-f1-terminal-recovery.test.ts` 的 `activeFixture`，`task-runner-close-receipt.test.ts` 的 `makeRunner`，`StubRuntimeAdapter` 会话的 `blockClose()`，以及 `vi.spyOn`。
  - 用 `deps.agentHome.acquire(AGENT)` 是否抛错观察 lease。s10-f1 已经这样做。
  - 1b 需要 `tenantId` 和可用的安全文件系统。否则快照直接跳过（`task-runner.ts:3746-3750`）。
- **3a、3b**：
  - 用 `execution-recovery-kill.test.ts` 的编译 daemon 夹具和它的 `journalFault` 配置（`fixtures/execution-recovery-daemon.ts:191-196`）。
  - 不需要新的 test seam。`JournalFaultSeam` 已经有这两个点（`daemon/journal/sqlite-journal.ts:95-111`）。
- **K3**：
  - 先查清这个套件为什么只在 macOS 运行。
  - 能在 Linux 运行，就加一个 ubuntu job。不能，就记录原因。
  - ⑥ 的 Linux 强杀测试依赖这个结论。

### 7.5 与现有设计的衔接

- **K4 队列**：结论映射不变：`cancel_requested` 加设备 terminal → `cancelled`（K4 指南 §4）。
- **Cross-Bot**：委派的「不确定」规则依赖「cancel 之后会有 terminal」（K8b 计划 §8.3）。这些测试保护这个前提。
- **P5a 记忆**：记忆快照在 lease 还被持有时进行（`task-runner.ts:5440-5443`）。1b 保护这个顺序。
- **ContextPack、K7、schema 收窄、凭据 broker**：无关。

### 7.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| F1 写失败 | 1a–1d | 见 §7.2 | 无 |
| F2 重复取消 | 2a、2b | 见 §7.2 | 无 |
| F3 强杀 | 3a、3b，放在 macOS job | 见 §7.2 | 无 |
| F4 Linux 强杀（调查，本方案新增） | 查清只在 darwin 运行的原因；可行时加 ubuntu job | CI | F3 |

### 7.7 验收

- #554 的验收清单全部满足。新测试在 CI 通过。
- 不改任何已有断言。
- 任何测试变红：开 bug issue，单独提交修复 PR。补测试的 PR 不合并红测试。

### 7.8 风险与回退

- **计时测试不稳定**：只用 deferred 闸门、注入点和事件观察，不用 sleep。
- **强杀测试耗时**：放在已有的 macOS job 里，不新增 job（F4 除外）。
- **3a 的云端状态是推断**：F3 实测结果不同时，按 #554 的规则另开 issue。不改断言去迁就结果。
- **回退**：revert 测试 PR。

## 8. ⑤ Host 防休眠（§9.2 选项 B，owner 已确认）

### 8.1 归属层

- Issue：#555。
- Host 应用：下游的桌面 Host，例如 Aiphabee。
- SDK 仓库只交付两样东西：
  - K4 指南 §7 里的一个小节。
  - 一个可选的参考策略模块（S2）。按 Q1 的裁定先不做，等 Aiphabee 需要时再做。
- SDK daemon 不持有电源断言。
- owner 已确认 §9.2 选项 B（Q1，2026-10-19）。

### 8.2 问题与成功标准

问题：

- 设备空闲休眠时，daemon 进程随系统一起暂停。正在运行的执行被拉长，可能超时。
- 平台 PRD §15 把「设备休眠时 routine 不运行」列为 BYOK 的固有限制（945 行）。
- 仓库里没有电源相关的代码。

成功标准：

- **P1**：默认关闭。用户没有开启时，Host 从不申请断言。
- **P2**：开启后，只在「接通电源」并且「有活动任务」时持有防空闲系统休眠的断言。显示器可以关闭。
- **P3**：活动任务数用引用计数。
  - 计数降到 0、拔掉电源或关闭开关时，立即释放断言。
  - 插上电源并且计数大于 0 时，重新申请。
- **P4**：不阻止用户主动睡眠、合盖休眠和低电量休眠。
- **P5**：Host 进程异常退出后，系统里不残留断言。
- **P6**：不承诺定时执行。设备休眠时，routine 仍然不运行。醒后补跑由 K2 和 K4 处理，与本功能无关。
- **P7**：UI 显示当前状态和原因：关闭；生效中（N 个任务）；未生效（使用电池）。

「活动任务」包括两类：

- 本设备上已经认领、还没有 terminal 的执行。
- Host 账本里目标是本设备、可以立即开始的 intent：K4 `phase` 是 `queued` 或 `inflight`，并且 `notBefore ≤ now`。

第二类避免在 FIFO 的两个任务之间短暂释放断言。

### 8.3 非目标

- 由 SDK daemon 或 launcher 持有断言（选项 C 和 D）。
- 定时唤醒：RTC wake、`pmset schedule` 和 Windows wake timer。
- 阻止显示器休眠。阻止合盖休眠。
- 用电池时防休眠。
- 改变 K2 wake 队列或 K4 补跑规则。
- 照抄 Octop 的 `caffeinate -dimsu`。`-d` 阻止显示器休眠，`-s` 创建的是 `PreventSystemSleep` 断言，二者都超出 P2。

### 8.4 设计

**策略**（纯逻辑，S2 的参考模块就是它）：

```text
want = enabled && onAC && activeCount > 0
want && !held → acquire(reason)
!want && held → release()
触发重新计算的事件：开关变化、电源变化、任务开始或结束、Host 启动
```

**平台实现**（Host 应用；来源见 §13）：

| 平台 | 申请 | 释放 | 进程退出时 | 电源状态 | 观察命令 |
|---|---|---|---|---|---|
| macOS | `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep, …)` | `IOPMAssertionRelease` | 自动释放（Apple 文档，并已实测 `kill -9`） | IOKit 电源信息；Electron `powerMonitor` 的 `on-ac` 和 `on-battery` 事件 | `pmset -g assertions` |
| Windows | 推荐 `PowerCreateRequest` 加 `PowerSetRequest(PowerRequestSystemRequired)`；也可以用 `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` | `PowerClearRequest` 加 `CloseHandle`；或 `SetThreadExecutionState(ES_CONTINUOUS)` | request 是内核对象句柄，进程结束时句柄自动关闭（推断）。线程退出时的行为没有官方说明，所以推荐 request API | `GetSystemPowerStatus`；Electron `on-ac` 和 `on-battery` 事件 | `powercfg /requests` |
| Linux（GNOME） | gnome-session `Inhibit`，标志 4（suspend） | `Uninhibit`，或断开 session bus | 断开 bus 时释放 | Electron `powerMonitor.isOnBatteryPower()` 轮询（Linux 没有变化事件） | `gnome-session-inhibit --list`（推断，S3 核对） |
| Linux（其他） | logind `Inhibit("idle", …, "block")` | 关闭返回的 fd | kernel 关闭 fd，自动释放 | 同上 | `systemd-inhibit --list` |

- **Electron Host**：用 `powerSaveBlocker.start('prevent-app-suspension')`。它让系统保持活动，但允许关闭屏幕。不要用 `prevent-display-sleep`，因为它优先级更高，会让屏幕也保持开启。
- **Linux 不用 `sleep` 锁**：systemd 257 起，`block` 模式的 `sleep` 锁也会挡住锁持有者自己发起的睡眠，这违反 P4。
- **Linux 不依赖 logind `idle` 锁**：在 GNOME 上不能只用它。GNOME 的自动挂起只看 gnome-session 的 inhibit，不看 logind 的 `idle` 锁（GNOME 源码；没有官方文档说明）。logind 的 `idle` 锁只影响 logind 自己的 `IdleAction`，它的默认值是 `ignore`。
- **合盖**：logind 默认不让合盖遵守挂起锁，所以 P4 在 Linux 上默认成立。
- **Windows 的冲突**：
  - `PowerSetRequest` 文档写明：用户主动睡眠（电源键、合盖、开始菜单）会结束 power request。
  - Modern Standby 的文档又写明：接电时，power request 可以无限期挡住待机的某个阶段。
  - 两份官方文档冲突，所以 S3 必须在真机上验证合盖和电源键（§8.7 最后一行）。

**参考模块 S2（可选）**：

- 文件：`examples/host-execution-core/src/power.ts`。
- `PowerHold` 注入 `PowerAssertionPort` 和 `PowerSourcePort`，从 K4 账本计算活动数。
- 测试用 fake 端口。

### 8.5 与现有设计的衔接

- **K2 wake 队列**：调度器仍是「等待上限 60 s 加墙钟比较」（`packages/server/src/wakes/scheduler.ts:62`；spec 531 和 564 行）。防休眠不改变它。
- **K4 队列**：只读账本里的 intent 状态。FIFO、等待上限和补跑（K4 指南 §6，160 行）都不变。
- **平台 PRD §15**：现有限制不变。Host 指南写明：防空闲休眠只让已经在运行的任务跑完，不会让休眠期间到期的 routine 运行。
- **三平台**：产品 PRD 不接受 Linux-only（239 行），所以 S3 的手动验收覆盖三个平台。
- **ContextPack、K7、Cross-Bot、schema 收窄、凭据 broker**：无关。

### 8.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| S1 Host 指南 | `docs/host-execution-core.md` §7「Wake behavior」末尾新增小节「Device sleep (optional)」（#555 的建议）：P1–P7、平台 API 表、验收矩阵，并写明它与 wake 和醒后补跑互相独立。不新增编号章节，所以 §8–§12 的现有引用不变 | 文档评审 | 无（Q1 已确认） |
| S2 参考策略（可选） | `power.ts` 和 fake 端口测试 | 引用计数；拔电；关闭开关；FIFO 两个任务之间不释放；默认关闭 | S1；owner 要求时才做 |
| S3 下游实现 | Aiphabee 的三平台实现和手动验收记录 | 见 §8.7 | S1 |

### 8.7 验收矩阵（S3）

每个平台用一台真机，按 P 编号记录命令输出。

| 场景 | 期望 | 证据 |
|---|---|---|
| 默认关闭，任务运行，空闲时间超过系统休眠时间 | 系统按原设置休眠 | 断言列表为空 |
| 开启，接电，任务运行，空闲 | 不休眠；显示器按设置关闭 | 断言列表有一条，原因里有 Host 名 |
| 开启，任务结束 | 断言消失 | 断言列表为空 |
| 开启，任务运行中拔电 | 断言消失；系统可以按电池设置休眠 | 同上 |
| 开启，任务运行中插电 | 断言重新出现 | 同上 |
| 开启，合盖（没有外接显示器） | 系统休眠 | 醒后的系统日志 |
| 开启，用户主动睡眠，电源键或菜单 | 系统休眠 | 同上 |
| 开启，`kill -9` Host 进程 | 断言消失 | 断言列表为空 |
| 开启，关闭开关 | 断言消失 | 同上 |
| 休眠期间有 routine 到期 | 不运行；醒后最多补跑一次（K4） | Host 账本 |
| Windows Modern Standby 设备，接电，合盖 | 记录实际行为，对照 §8.4 的文档冲突 | `powercfg /requests`、`powercfg /sleepstudy` |

### 8.8 风险与回退

- **电源误判**：会导致耗电和发热。只在接电时持有断言，并且 UI 显示状态。
- **Modern Standby**：行为有文档冲突。真机结果决定 Windows 的文案。
- **Linux 桌面差异**：GNOME 以外的桌面（KDE 等）没有核对。S3 只承诺验收过的桌面。
- **用户误解**：用户可能以为开启后 routine 能在休眠中运行。文案要写明不会。
- **回退**：关闭开关，或者 Host 删除这个功能。SDK 侧只有文档。

## 9. ⑥ cgroup v2 进程树收容（§9.3，Linux，owner 已确认）

### 9.1 归属层

- Issue：#556。
- SDK launcher，涉及这些位置：
  - `packages/client/src/adapters/process-tree.ts`：启动和处置。
  - 各个 owned spawn 站点。
  - `packages/client/src/daemon/owned-process-ledger.ts`：崩溃恢复。
  - `createDaemon` 的配置。
- 只在 Linux 上提供。
- owner 已确认 §9.3 选项 B（Q2，2026-10-19）。有 Linux 常驻需求时再排期。

### 9.2 问题与成功标准

问题：

- POSIX 残留：如果父进程在 SDK 读进程表之前退出，子进程会被 init 收养，SDK 不会结束它。例如独立 session 里 `cmd &` 留下的后台进程（`process-tree.ts:707-711`；ADR-037 72 行；`docs/security.md:879-885`）。
- Windows 已经用每棵进程树一个 kill-on-close Job Object 解决这个问题（`win32-job-object.ts:1-40`）。Linux 和 macOS 还没有对应机制。

成功标准：

- **G1**：配置 `processContainment: 'cgroup-v2'` 时，每棵 owned 进程树在 exec 之前进入自己的 cgroup。树里的全部后代都在这个 cgroup 里，包括 `setsid`、双 fork 和 `cmd &` 产生的进程。
- **G2**：取消、超时和关闭时，现有的进程组处置之后再做三步：写 `cgroup.kill`，等到 `cgroup.events` 显示 `populated 0`，然后 `rmdir`。
  - 这三步都成功，处置才算完成。所以 Agent-home lease 和 Git lease 都排在它之后。
  - 等待超时 → `RuntimeDisposalFailure{stage: 'quiescence'}`。之后沿用现有的「处置失败就保留所有权」路径（`daemon-stop-shutdown-parity.test.ts:177`）。
- **G3**：配置要求 cgroup 而环境不支持时，`createDaemon` 抛出带类型的 `ProcessContainmentUnsupportedError`，并带原因码，不降级为进程组。环境不支持的情况包括：不是 Linux；没有 cgroup2；没有委派的子树；没有 `cgroup.kill`。
  - 运行中某次进入失败时，这次启动失败（fail-closed）。Windows Job Object 也是这样处理。
- **G4**：daemon 崩溃后重启时，`reconcile()` 先清理 ledger 记录里的每个 cgroup（`cgroup.kill`、等空、`rmdir`），再回收 lease。
  - 清不掉 → `OwnedProcessResidueError`，拒绝启动。这是现有行为（`owned-process-ledger.ts:56-64`）。
- **G5**：状态如实。`daemon.status()` 和诊断都报告当前的收容方式：
  - `process-group`：macOS，以及 Linux 默认；
  - `job-object`：Windows；
  - `cgroup-v2`：Linux，开启时。

  文档写明 macOS 仍有 POSIX 残留。
- **G6**：没有配置时，行为与现在相同。

### 9.3 非目标

- 沙箱：不限制文件、网络、系统调用和 uid。
- 资源控制器，例如 `memory.max` 和 `pids.max`。v1 不启用任何控制器。
- PID namespace 和 user namespace（选项 D）：
  - ADR-037 记录了 root 运行时 Claude 拒绝跳过权限确认的启动参数（86 行）。
  - namespace 可能让 agent 看到 root 身份（推断）。所以不做。
- `PR_SET_CHILD_SUBREAPER`（选项 C）：
  - 它不提供原子的整树结束。
  - subreaper 死后，孤儿转给上一层 subreaper 或 init。
  - Node 没有对应的 API。
- 经其他服务管理器启动的进程，例如 `systemd-run --user`、D-Bus 激活、`at` 或 `cron`、ssh 到本机和容器运行时。这些进程不在 daemon 的 cgroup 里。这是写进文档的残留。
- macOS 的等价机制。默认开启。

### 9.4 设计

**探测** `probeCgroupV2()`（新文件 `adapters/cgroup-v2.ts`）：

1. `process.platform === 'linux'`，否则原因码是 `not_linux`。
2. `/proc/self/cgroup` 只有一行 `0::<path>`（纯 v2），否则是 `cgroup2_unavailable`。
3. `/proc/self/mountinfo` 里 `/sys/fs/cgroup` 的类型是 `cgroup2`。
4. 自己所在的 cgroup 是委派给 daemon 的子树。systemd 文档要求：不要在没有设置 `Delegate=` 的 cgroup 下自建 cgroup。判定方法在 C0 确定，例如读 systemd 写在 cgroup 目录上的委派标记（推断）。不满足时，原因码是 `not_delegated`。
5. 在子树里 `mkdir byok-probe-<rand>` 成功，目录里有 `cgroup.kill`（Linux 5.14 起），然后 `rmdir`。否则是 `not_delegated` 或 `cgroup_kill_unavailable`。

**委派来源**（选一种，文档逐一说明）：

- systemd 用户服务：安装时在单元文件里加 `Delegate=yes`。现在的单元没有这一行（`lifecycle/systemd.ts:170-184`）。只有配置了 `cgroup-v2` 时才加。
- 前台运行：`systemd-run --user --scope -p Delegate=yes <daemon 命令>`。
- 容器：私有 cgroup namespace，并且 cgroup2 可写挂载。

**布局**：

- daemon 启动时，把自己移进 `<委派根>/byok-daemon` 叶子节点。
- 每棵进程树用一个兄弟叶子节点：`<委派根>/byok-exec-<treeId>`。
- 这样委派根只是内部节点，符合 systemd 委派文档的要求。将来启用控制器时也不用改布局。

**exec 之前进入**：

Node 不能用 `clone3(CLONE_INTO_CGROUP)`（glibc 没有封装），所以先 spawn 一个 `sh` 垫片。垫片把自己的 pid 写进 `cgroup.procs`，再 `exec` 真正的命令：

```text
/bin/sh -c 'echo $$ > "$1/cgroup.procs" || exit 125; shift; exec "$@"' byok-cgroup <cgroupDir> <command> <args...>
```

- 命令和参数都作为 argv 传入，不拼接字符串。
- 写入失败时，垫片在 exec 之前以 125 退出，这次启动失败。
- 垫片 exec 之后 pid 不变。所以进程组 leader、`adoptOwnedProcessTree`（`process-tree.ts:299`）和现有的 ledger 记录都不变。
- 所有 owned spawn 站点改走同一个 helper：
  - Claude：`adapters/claude/process-client.ts:100`；
  - Pi：`adapters/pi/rpc-client.ts:93`；
  - Codex：`runtime/owned-line-process.ts:20`；
  - durable Pi：`adapters/pi-durable/shell.ts:32` 和 `adapters/pi-durable/session.ts:85`。
- 加一个源码扫描测试：adapters 里的 owned 进程不能绕过这个 helper 直接 spawn。

**处置顺序**（`disposeOwnedProcessTree`，`process-tree.ts:749-845`）：

1. 现有步骤：SIGTERM，等 `termGraceMs`，SIGKILL 进程组和离组的后代，等 `killGraceMs`。
2. 新增：向 `cgroup.kill` 写 `1`。
3. 新增：等到 `populated 0`。`cgroup.events` 变化时可以用 inotify 得到通知，否则每 20 ms 轮询一次（与 `POLL_MS` 相同）。等待上限是 `killGraceMs`。
4. 新增：等待期间如果仍有成员，再写一次 `cgroup.kill`。没有 stable 回补的内核上，`cgroup.kill` 有 fork 竞态（修复在 6.14 首发，并标记回补到 5.14+）。
5. 新增：`rmdir`。

先给 runtime 正常退出的机会，最后用 cgroup 兜底，并证明没有残留。

**崩溃恢复**：

- 记录：
  - `owned-processes/` 目录（`owned-process-ledger.ts:36`）新增一种 cgroup 记录：`{ version: 1, treeId, cgroupPath, bootId, recordedAt }`。
  - 记录在 `mkdir` 之前 fsync 写入。
  - 现有进程组记录的 `FILE_KEYS`（50 行）不变，不升版本。`reconcile()` 要能识别两种记录。
- 重启：
  - `reconcile()` 在回收 lease 之前运行（`create-daemon.ts:1989-1995`）。
  - 它先处理 cgroup 记录：目录还在，就 `cgroup.kill`、等空、`rmdir`。然后走现有的进程组回收。
  - 它还扫描委派根下没有记录的 `byok-exec-*` 目录。因为先写记录再 `mkdir`，正常不会有这种目录。这一步是防御。
  - `bootId` 不同时（机器重启过），cgroup 已经不存在，直接删除记录。
- systemd 服务模式下，单元停止时 systemd 本来就会结束服务 cgroup 里的进程（默认 `KillMode=control-group`，推断，C0 实测）。ledger 恢复不依赖这一点。

**配置与错误**：

```ts
createDaemon({ processContainment?: 'process-tree' | 'cgroup-v2' })   // 默认 'process-tree'
class ProcessContainmentUnsupportedError extends Error {
  readonly code: 'not_linux' | 'cgroup2_unavailable' | 'not_delegated' | 'cgroup_kill_unavailable';
}
```

- 状态：`daemon.status().processContainment = { mode, cgroupRoot? }`。
- 诊断：新增 `process-containment` 检查。

### 9.5 与现有设计的衔接

- **Agent-home lease**：`finishOnce` 的顺序不变。lease 在 `awaitActiveSessionClose` 之后释放，而 close 回执包含进程树处置。所以 cgroup 清空自然排在交接之前（G2）。Git lease 同理（`task-runner.ts:5482`）。
- **owned-process ledger**：沿用「先回收进程，再回收 lease」的启动顺序（`create-daemon.ts:1989-1995`）。
- **Windows Job Object**：同样 fail-closed，没有降级路径（`win32-job-object.ts` 头注释）。
- **ADR-037**：「runtime 不能执行的选项被拒绝，不被丢弃」（23 行）。
- **凭据**：垫片不读也不改环境变量。BYOK custody launcher（`pi-adapter.ts:515-535`）作为根进程进入 cgroup，行为不变。
- **K4、ContextPack、K7、Cross-Bot、schema 收窄**：无关。
- **文档**：`docs/security.md:877-885`、`docs/architecture/sdk-architecture.md:946`、ADR-037 的 Keep 列表、诊断文档。

### 9.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| C0 探测与诊断 | `probeCgroupV2()`；诊断检查只读报告；Linux CI job 骨架，在委派的 scope 里跑测试 | 用 fixture 解析 `/proc/self/cgroup` 和 mountinfo；在真实 Linux 上探测成功和失败；实测 systemd `KillMode` 的行为 | 出现 Linux 常驻需求（Q2 已确认）；F4 的结论 |
| C1 启动与处置 | 配置项；带类型的错误；垫片 helper 和全部 spawn 站点；daemon 自身移进叶子节点；处置新增的步骤；cgroup 记录 | 单元：argv 构造，没有注入。Linux 集成：`setsid sh -c 'sleep 600 &'` 和双 fork，cancel 或超时（`maxDurationMs`）之后全部进程消失，`populated 0`；同一用例在 `process-tree` 模式下留下残留，作为对照；环境不支持 → 带类型的错误。macOS 和 Windows：配置 `cgroup-v2` → 带类型的错误 | C0 |
| C2 崩溃恢复 | `reconcile()` 处理 cgroup 记录和没有记录的目录 | Linux：SIGKILL daemon；重启前残留存在；重启后清空，之后才回收 lease；清不掉 → 拒绝启动 | C1、F4 |
| C3 文档与安装 | 安全文档、架构表、ADR-037 附注、诊断文档；systemd 单元的 `Delegate=yes` 选项；README 说明三种委派方式 | 五项必检 | C1 |

### 9.7 验收

- **Linux CI**：在 ubuntu runner 上，用 `sudo systemd-run --scope -p Delegate=yes --uid=$(id -u) …` 建一个委派的 scope，在里面跑 cgroup 测试。这个方法能不能用要在 C0 验证（推断）。
- **macOS 和 Windows CI**：只验证「配置 `cgroup-v2` → 带类型的错误」。
- **api-surface**：`@byok-sdk/client` 新增配置项、错误类型和状态字段。
- **必检**：五项必检。

### 9.8 风险与回退

- **环境差异大**：WSL2、旧内核、没有 systemd 的容器。只做显式开启，探测失败就拒绝。
- **不可中断睡眠**：处于 D 状态的进程，`cgroup.kill` 也杀不掉，`populated` 不归零。这时处置失败，lease 被保留。这是正确的 fail-closed 行为，但用户会看到 Agent 一直忙，所以诊断要显示原因。
- **被误当成沙箱**：文档和状态都写明「这是进程归属，不是沙箱」。
- **回退**：不配置就回到现状。revert 代码之前，先确认 ledger 里没有 cgroup 记录。

## 10. 维护原则

### 10.1 归属层

- SDK daemon，范围是 Agent home 的维护。
- 现在只成文，不写代码。原则随第一个清理、压缩或恢复功能的 PR 实现。
- 不新建维护服务。

### 10.2 问题与成功标准

问题：将来对 Agent home 做压缩、清理或恢复时，要满足三点：与运行中的执行互斥；可以回退；不把本地备份算进收费存储。

已有的基础：

- `AgentHomeManager.withIdleHomeLease`（`agent-home.ts:1129`）用基础 writer 注册表做维护准入。home 忙时，它返回 `false`。
- retention sweeper 已经通过它做清理（`daemon/retention/producers.ts:145`）。每个 home 的遍历有上限，用轮转游标（`docs/host-local-storage-layout.md:97-98`）。
- 计量：用户容量只统计 tenant 的 R2 对象字节和 Postgres inline 字节（`docs/architecture/sdk-architecture.md` §12.7.6，1691 行）。`TenantStorageEntitlement` 定义在 `packages/core/src/quota.ts:32-41`。Agent home 的内容是本地权威（`docs/spec.md:2039-2042`）。

成功标准：将来每个维护功能的 PR 都满足下面 6 条，并在 PR 描述里逐条引用。

- **M-1 准入**：只经 `withIdleHomeLease` 或 writer lease 准入。home 忙时跳过，下次再试。不长时间等待。
- **M-2 重新鉴权**：Host 发起的维护（例如恢复）在执行时按当前授权重新检查，不信任排队时的授权。P5a 的 ContextPack 也是这样重新鉴权。
- **M-3 备份**：破坏性改写之前，先写一份本地备份：`O_EXCL`、权限 0600、fsync、读回后校验 hash。备份归入 retention registry，有 TTL 或数量上限。
- **M-4 有界批次**：每批以开始时的固定高水位为界，不追新写入的数据。
- **M-5 如实报告**：
  - 部分完成时，就报告部分完成（`SweepReport` 和 `retention-sweep` 事件）。
  - 不自动回滚已经完成的批次。
  - 恢复操作先做安全快照，失败时按快照回滚。
- **M-6 计量**：本地 Agent-home 备份不计入 `TenantStorageEntitlement`。只有上传到受管云存储的字节才计量。

### 10.3 非目标

- 新的维护服务、cron 或云端维护。
- 现在就实现压缩功能。
- 改变 retention 的现有规则。

### 10.4 设计

原则就是 §10.2 的 M-1 到 M-6，再加一张「维护 PR 检查表」，每条一个复选框。

### 10.5 与现有设计的衔接

- **retention registry**：#399 和 #412 的规则不变。
- **P5a 记忆**：memory intent 已经在 lease 下做 CAS（K4 指南 P5a 一节）。
- **Agent home**：本地权威不变（`docs/spec.md:2039-2042`）。
- **K4、ContextPack、K7、Cross-Bot、schema 收窄、凭据 broker**：无关。

### 10.6 切片

| 切片 | 范围 | 测试 | 依赖 |
|---|---|---|---|
| D1 文档 | `docs/host-local-storage-layout.md` 新增英文小节「Agent-home maintenance admission」，内容是 M-1 到 M-6 和检查表。可以和第二批的文档一起提交，也可以等第一个维护功能 | 文档评审 | 无 |

### 10.7 验收

- D1：文档评审通过。
- 将来的功能 PR：要有三类测试：home 忙时跳过；备份校验；部分完成的报告。

### 10.8 风险与回退

- 原则没有执行机制，可能被跳过。检查表要求每个维护功能的 PR 逐条回答。
- 回退：revert 文档。

## 11. 推进顺序与依赖

```text
第一批（可以并行）
  ①  I1 → I2 → I3      （I4 可选，下游）
  ②  M1 → M2 → M3      （M4 下游）
      M2 在 ① I1 之后合并：两者都改 host.ts；M2 把合并键里的 sender 换成验证过的主体

第二批（可以并行）
  ③  T0 → T1 → T3      （T2 等 Pi 验证后由 owner 决定，Q5）
  ④  F1、F2、F3 并行 → F4

第三批（owner 已确认；⑥ 等 Linux 常驻需求）
  ⑤  S1 →（S2 可选）→ S3 下游
  ⑥  C0 → C1 → C2 → C3   （C0 需要 F4 的 Linux 结论）

维护原则
  D1 随第二批的文档提交，或随第一个维护功能提交
```

- 每个切片单独开 PR，单独合并。合并后系统仍然可用。
- ① 和 ② 只改 example 和文档。③ 和 ⑥ 改 `@byok-sdk/client` 的公开面。④ 只改测试。⑤ 在 SDK 仓库只改文档（S2 可选）。
- 跨项依赖只有三条：
  - ② M2 排在 ① I1 之后。
  - ⑥ C0 和 C2 依赖 ④ F4。
  - ③ T1 和 ⑥ C1 都改 `packages/client`。主要文件不同（`task-runner.ts` 与 `process-tree.ts`），但两者都改 `create-daemon.ts`。后合并的一方 rebase。

## 12. Issue 对应与差异

#548 修订后，owner 授权开出下面 6 个 issue（审阅意见 G）。issue 定义范围和验收，本方案细化设计和切片。二者不一致时，以 issue 为准。最后一列的补充不扩大 issue 的验收。需要收窄验收时，先在 issue 里记录原因。

| 项目 | Issue | 本方案切片 | 本方案与 issue 的差异 |
|---|---|---|---|
| ① | [#551](https://github.com/Ancienttwo/byok-sdk/issues/551) | I1–I4 | 范围一致。补充：Agent 变空闲时提前封口（S4）。#551「待 owner 确认」的 4 条已按 Q4 确认：第 3 条见 §4.5，第 4 条见 §4.4 |
| ② | [#552](https://github.com/Ancienttwo/byok-sdk/issues/552) | M1–M4 | 范围一致。M1 按 #552 的建议新建 `docs/host-im-adapter.md`。补充 R6（结构化点名）和 R7（渠道凭据） |
| ③ | [#553](https://github.com/Ancienttwo/byok-sdk/issues/553) | T0–T3 | T0 是新增的前置切片。Pi 的解码计数可能按 T0 的结论收窄（§6.4）。T2 等 Pi 验证后由 owner 决定 |
| ④ | [#554](https://github.com/Ancienttwo/byok-sdk/issues/554) | F1–F4 | F1–F3 与 #554 的 8 个场景一一对应（§7.2）。3a 和 3b 用现有的 journal 故障点，不加 test seam。F4（Linux）是新增的调查 |
| ⑤ | [#555](https://github.com/Ancienttwo/byok-sdk/issues/555) | S1–S3 | 范围一致。S1 放在 K4 指南 §7 末尾。补充 Windows 和 Linux 的 API 与来源（§8.4）；真机行为仍按 #555 在实现时核对 |
| ⑥ | [#556](https://github.com/Ancienttwo/byok-sdk/issues/556) | C0–C3 | 范围一致。补充委派探测（C0）和 cgroup 的 ledger 记录（§9.4） |

维护原则不单独开 issue，随第一个维护功能落地（§10）。

## 13. 本方案的核对与残余风险

已核对：

- byok-sdk 的路径和行号按 `origin/main@649f9f0b` 逐处读过。方法：三路只读测绘（K4 和 K8、launcher 和取消路径、adapter 事件和结算），然后作者复核关键行。
- main 前进到 `27044406`（#550）之后，`docs/spec.md` 的行号已同步。其他引用的文件没有变化（`git diff --name-only 649f9f0b 27044406`）。
- #548 按 `98a7087a` 读过。
- #551–#556 的范围和验收已与本方案逐条对照（§12）。
- §7.2 引用的每个已有测试，都读过它的发起方和断言。
- 外部文档按官方来源核对：

| 主题 | 来源 |
|---|---|
| macOS 断言语义和进程退出时释放 | [kIOPMAssertionTypePreventUserIdleSystemSleep](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep)；[IOKit Power Management Release Notes](https://developer.apple.com/library/archive/releasenotes/Darwin/RN-IOKitPowerManagment/index.html)；`man 8 caffeinate`；`man 1 pmset` |
| Windows 执行状态和 power request | [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)；[System Sleep Criteria](https://learn.microsoft.com/en-us/windows/win32/power/system-sleep-criteria)；[PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)；[Prepare software for modern standby](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby)；[powercfg](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options) |
| Linux inhibitor 锁 | [systemd Inhibitor Locks](https://systemd.io/INHIBITOR_LOCKS/)；[systemd-inhibit(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-inhibit.html)；[logind.conf(5)](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html)；[gnome-session Inhibit](https://gnome.pages.gitlab.gnome.org/gnome-session/re04.html) |
| Electron | [powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)；[powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) |
| cgroup v2 | [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)；`cgroup.kill` 引入提交 [661ee628](https://github.com/torvalds/linux/commit/661ee6280931548f7b3b887ad26a157474ae5ac4)；fork 竞态修复 [b69bb476](https://github.com/torvalds/linux/commit/b69bb476dee99d564d65d418e9a20acca6f32c3f)；[clone(2)](https://man7.org/linux/man-pages/man2/clone.2.html) |
| systemd 委派 | [Control Group APIs and Delegation](https://systemd.io/CGROUP_DELEGATION/)；[systemd-run(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)；[user@.service(5)](https://www.freedesktop.org/software/systemd/man/latest/user@.service.html) |
| subreaper 与进程组 | [PR_SET_CHILD_SUBREAPER](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)；[Node child_process `detached`](https://nodejs.org/api/child_process.html#optionsdetached)；[setsid(2)](https://man7.org/linux/man-pages/man2/setsid.2.html) |

- 本地实测一项：在 macOS 26.5 上运行 `caffeinate -i` 后 `kill -9`，2 s 后 `pmset -g assertions` 里没有这个 pid 的断言。

没有做的：

- 没有运行 byok-sdk 的测试。本方案只新增一个文档。
- 没有运行 Octop。

残余风险：

- §7.2 的覆盖矩阵来自阅读测试源码。这些测试没有在本方案里运行。
- 标为「推断」的内容需要在对应切片实测：
  - Windows power request 句柄在进程结束时自动关闭。
  - systemd 的委派标记判定方法。
  - ubuntu runner 上委派 scope 的做法。
  - systemd `KillMode` 对服务 cgroup 的清理。
  - ④ 1b 的快照失败注入方式。
  - ④ 3a 的云端 attempt 状态；3a 和 3b 用 `cancelTask` RPC 向运行中的 daemon 发 cancel。
- Windows Modern Standby 的官方文档互相冲突，只能用真机结果定论。
- GNOME 只看 gnome-session inhibit 这一点来自 GNOME 源码，不是文档。GNOME 2026 年改过这段代码，所以行为取决于 GNOME 版本。
- ① 的默认参数没有数据支撑，要靠试点数据调整（Q4）。

## 14. 开放问题与 owner 裁定

owner 于 2026-10-19 裁定：Q1–Q8 全部按推荐。

| # | 问题 | 推荐 | 影响 | 裁定 |
|---|---|---|---|---|
| Q1 | §9.2（#555）：是否采纳选项 B（Host 应用实现，SDK 只出指南）？SDK 仓库要不要 S2 参考策略模块？三平台真机验收放在哪里？产品 PRD 对记忆证明已裁定「不接受 Linux-only」（239 行） | 采纳 B。S2 先不做，等 Aiphabee 需要时再做。三平台真机验收都放在 Aiphabee，按 §8.7 的矩阵记录 | ⑤ 能否开工 | 按推荐（2026-10-19） |
| Q2 | §9.3（#556）：是否采纳可选的 cgroup v2？只在 Linux 上提供，是否符合平台一致性的要求？现在有没有 Linux 常驻部署的需求？systemd 单元的 `Delegate=yes` 是否作为安装选项？是否确认排除选项 C 和 D？ | 采纳 B，默认关闭。Windows 已经有 Job Object；cgroup v2 让 Linux 有同等的收容，macOS 仍有残留，状态和文档如实写明（G5）。没有常驻需求就不排期。`Delegate=yes` 只在开启时写入。排除 C 和 D | ⑥ 能否排期 | 按推荐（2026-10-19） |
| Q3 | 第一批试点先在 `examples/bot-collaboration` 做，还是直接在 Aiphabee 做？ | 先在 `examples/bot-collaboration` 做：CI 可测，copy-and-own，不依赖外部仓库。Aiphabee 之后按 I4 切片移植 | ① 和 ② 的落点 | 按推荐（2026-10-19） |
| Q4 | ①（#551「待 owner 确认」1–4）：策略是否默认关闭？默认参数是否用 `windowMs = 10 s`、`maxItems = 8`、`maxBytes = 8 KiB`？intentKey 是否取批次 Turn id，即第一条输入的 id？一个回复对应多条消息时，是否按 §4.4 显示？是否接受一个批次共用一个 root 预算？ | 默认关闭。接受这些默认值，试点后按数据调整。intentKey 按 §4.5，UI 按 §4.4。接受共用 root 预算 | ① I1 | 按推荐（2026-10-19） |
| Q5 | ③（#553）：Pi 验证之后，要不要做 T2（Claude 和 Codex 的证据）？以后要不要给 terminal 加可选的 wire 字段，让 Topology H 也能看到记录？ | T2 等 T1 有了 Pi 的数据再定。wire 字段现在不做：它是核心协议改动，等有 Topology H 的需求再议 | ③ 的范围 | 按推荐（2026-10-19） |
| Q6 | ② 的 1:1 对话里，非 owner 的发送者怎么处理？群里的审批是否只限 owner？ | 1:1 拒绝非 owner。群里的审批只限 owner | ② M2 | 按推荐（2026-10-19） |
| Q7 | ② 的 `unknown` 投递：确认参考实现不自动重发，只提供手动重发入口？ | 确认 | ② M3 | 按推荐（2026-10-19） |
| Q8 | 是否把 SIGKILL 恢复套件扩展到 Linux CI（④ F4）？它是 ⑥ 的前置条件 | 先调查原因，再决定 | ④ F4、⑥ C0 | 按推荐（2026-10-19） |
