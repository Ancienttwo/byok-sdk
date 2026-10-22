# K4 统一 routine 模型与 K8 可移植性（#606 剩余部分设计草案）

状态：设计草案，等待 owner 决定。本文不改变现行 SDK API、wire、ledger 格式或部署。

日期：2026-10-22（Asia/Taipei）。
SDK 基线：`ac57f6bc0e2b0633a1b28e3c7edd3214e2daf081`。下文的 `file:line` 都指这个基线。
下游：AiphaBee 的要求取自 #606 正文和两条「统一发版前」评论。本文没有读 AiphaBee 源码。
关联：[issue 606](https://github.com/Ancienttwo/byok-sdk/issues/606)；已合入的 #622、#669（只读 toolset 和五项小修）；#612 由 #620、#661 关闭（审计、Host job、不触发执行的 occurrence）；#684（K4 retention）。
上游方案：[双车道 Host 方案](2026-10-21-dual-host-collaboration.md)（下称「双车道方案」）。它的 D1 已经承接 #606 的外部权威部分。

## 1. 目标、范围与建议

#606 还没完成的五项：

1. 把 K8 的纯语义规则拆出来，不依赖 `CollaborationState`：同 id routine 版本语义、群聊 seat 仲裁（`rooms.ts`）、输入合并（`coalesce.ts`）。
2. K4 只保留一套 routine 模型：支持同 id 版本变更，并承载 Host job。Bot routine 和 Host job 共用一条去重和补排路径。
3. Windows 可用的 persona consumer。
4. 云端权威接缝。
5. 两进程 relay。

AiphaBee 说第 1–2 项挡住 S7（create / update / cancel routine）和 S10（watchlist 放在 K4 routine 上）。第 3–5 项和 S12 有关。

不在范围：

- 已完成的只读 toolset（#622、#669）。
- outcome、schema、委派 verdict 状态机的拆分。双车道方案 D1 已经承接它（`2026-10-21-dual-host-collaboration.md:174-188`）。本文第 5.4 节的拆法和 D1 的提交契约保持一致。
- 冻结中的 0.28.2（#649）。

建议（细节见第 5 节，决定见第 11 节）：

- **K4 是唯一的 routine 模型。** `Routine` 增加一个 `pending` 定义。新增显式的 `updateRoutine`。切换规则沿用 K8a 的规则：在途 occurrence 都结算、没有到期未投递的旧 slot 之后才切换。
- **K4 增加第三种 occurrence 去向。** 它是事务内的同步 hook，写法和 `applyOutcome`、`applyMessage` 一样。Host 在同一次提交里写入自己的状态（例如 K8 的 Turn）。之后 Host 用导出的 `promoteOccurrence` 把 occurrence 升级成 intent，K4 照常结算它。
- **K8 删除自己的 routine 状态、wake 操作队列和 `consume` 分流。** K8 只保留 Bot 策略：每个 owner 最多 8 个、authority、prompt、ContextPack 里的 routine 列表。
- **群聊和输入合并改成只读窄数据的纯函数。** 它们不再读或写 K4 的 `LedgerState`。
- **第 3–5 项本文不排实现。** 第 3 项需要 owner 决定 Windows 的持久化承诺。第 4 项归双车道方案 D1。第 5 项和双车道方案的首版范围冲突，需要 owner 裁决。

## 2. P1：现状

### 2.1 两套 routine 模型

| 方面 | K4 `examples/host-execution-core` | K8 `examples/bot-collaboration` |
| --- | --- | --- |
| 定义 | `Routine.definition` 只有一个（`src/model.ts:52-62`） | `versions`、`current`、`pending`、`generation`（`src/model.ts:89-97`） |
| 同 id 变更 | 拒绝：`Routine definition is immutable`（`src/core.ts:173`） | `updateRoutine` 写 `pending`，条件满足时 `switchVersion`（`src/routines.ts:45-61`） |
| wake key | `${id}:${version}:${slot}`（`src/routines.ts:34`） | 同一格式（`src/routines.ts:14`），并用 K4 的 `parseRoutineWakeKey` 解析（`:73`） |
| occurrence 身份 | `hash([id, version, trigger])`，版本已在 key 里（`src/routines.ts:90`） | 以 wake key 为 key（`src/routines.ts:79-83`） |
| 去向 | Agent intent 或异步 Host job（`src/routines.ts:113-122`） | K8 Turn，之后由 `process()` 入队（`src/host.ts:485-488`、`:598`） |
| 重叠策略 | 新 slot 结算排队中的旧 intent，保留运行中的那个（`src/routines.ts:100-109`） | 在途上限 2，第三个记 `capacity`，不执行（`src/routines.ts:81-82`） |
| 补排判定 | `lateAfterMs` 由定义给出（`src/routines.ts:89`） | 写死 60 000 ms（`src/routines.ts:84`） |
| 日历 | 每个 core 注入一个 `NextOccurrence`（`src/schedule.ts:4`，`src/core.ts:73`） | 直接调 `@byok-sdk/core` 的 `nextRoutineOccurrence`（`src/routines.ts:13`） |
| wake 调度 | outbox 行 `schedule:<key>` / `cancel:<key>`（`src/transitions.ts:33-36`，`src/routines.ts:55`） | 自己的 `operations` 数组，带 sequence 和 generation（`src/routines.ts:8-10`，`src/host.ts:648-685`） |
| 迟到或失效的 wake | 有界审计，128 条，只存 key 的 hash（`src/routines.ts:10-14`、`:82-86`） | `skipped` / `superseded` occurrence 行；`state.audit` 存原始 key（`src/routines.ts:74`、`:76`） |
| 重放保护 | `slots` 加 slot tombstone（`src/routines.ts:75-80`，`src/core.ts:201`） | `state.occurrences[key]` 存在即返回（`src/routines.ts:79`） |
| 恢复 | `recover()` 重排丢失的 wake（`src/core.ts:212-228`） | 自己再做一遍（`src/host.ts:520-537`） |
| retention | `compact` 清理已结算的 occurrence、slot 和 Host-only occurrence（#661、#684） | `occurrences`、`operations`、`audit` 没有清理路径 |

K4 README 把同 id 版本变更划给了 K8a（`examples/host-execution-core/README.md:325-327`）。同一处还写明版本历史和 CAS 命令归 Host 服务（`:315-318`）。

### 2.2 K8 里 Host job 无法和 Bot routine 共存

这条由结构决定，不需要复现。

1. K8 构造 K4 core 时没有传 `hostJobs`（`examples/bot-collaboration/src/host.ts:111-113`）。所以 `bot.core.addRoutine` 加 Host job 定义会抛出 `Host job handler not registered`（`examples/host-execution-core/src/core.ts:163`）。
2. 即使注册了 handler，wake 也到不了 K4。K8 的 `consume` 只把 `host-scan:` 交给 K4，其余都交给 `consumeRoutine`（`examples/bot-collaboration/src/host.ts:477-491`）。
3. 一个 K4 routine 的 wake key（例如 `watchlist:abc:1:<t>`）能被 `parseRoutineWakeKey` 解析。K8 查不到这个 routine，就记一条 `skipped` occurrence 并返回（`examples/bot-collaboration/src/routines.ts:80-86`）。K4 不知道这次投递。

所以 AiphaBee 的验收条件「一个 K4 测试里 Bot routine 和 Host job routine 共存」现在不能通过。

### 2.3 群聊仲裁和输入合并的耦合

`rooms.ts`：

- `reserve`、`newRound`、`roomInput`、`applySpeech` 只用 `state.team`（`src/rooms.ts:12-48`、`:58-96`）。它们和 `CollaborationState` 的耦合很浅。
- `advanceRooms` 收 K4 的 `LedgerState`。它读 `s.intents`、`s.executions`（`src/rooms.ts:102`），并直接写 K4 intent 的 `cancelReason`（`:108`、`:123`）。这是对 K4 ledger 布局的读写依赖。

`coalesce.ts`：

- `coalesceKey` 读 `state.team.bots` 的 revision 和 model（`src/coalesce.ts:26-29`）。
- `agentBusy` 扫描 `state.turns`（`:31-33`）。
- `admitUserInput` 写 `state.budgets`，并调 `addTurn`（`:83-86`）。`addTurn` 自己又会封存该 Bot 的 open batch（`src/model.ts:139-145`）。

### 2.4 第 3–5 项的现状

- **persona consumer。** K8 的 consumer 先 rename，再 open 目录并 `sync`（`examples/bot-collaboration/src/persona.ts:12-18`）。README 写明它不支持 Windows（`README.md:284-289`）。SDK 的契约要求 consumer 自己原子、幂等地保证字节（`packages/client/src/agent-home.ts:125-129`）。完全相同的 revision 和 hash 会再调一次 consumer（`agent-home.ts:1286-1325`）。SDK 内部的 `atomicWriteFile` 已处理 Windows：用 `r+` flush 目标文件，依靠 rename，不做目录 flush（`packages/client/src/util/atomic-write.ts:15-26`）。它没有导出。WO-09a 记录：Windows 故障模型 S 已选定，但没有证明，`B=false`（`docs/plans/2026-10-19-windows-ntfs-ledger-barrier-decision.md:3-9`）。
- **云端权威。** K8 构造时在本地 ledger 写入 Main Bot（`examples/bot-collaboration/src/host.ts:114-121`）。README 写明每个 ledger 一个 team、一个 owner（`README.md:144`）。turn、schema、history 都在设备 ledger（`src/model.ts:110-121`）。
- **两进程 relay。** `SECOND-DEVICE.md:36-61` 只定义契约，不实现。`VALIDATION.md:151-153` 的三行仍是 OPEN。#683 在 workerd 上补了 Topology H 两设备证据，但 K8 的 VALIDATION 表没有变。

## 3. P2：一条 Bot routine 路径

现在的路径：

1. Bot outcome 带 `create_routine`。`applyOutcome` 在 K4 的结果事务里运行。它只拿到 `tx.application`（`examples/bot-collaboration/src/host.ts:238-239`、`:282-288`）。
2. `createRoutine` 写 K8 的 routine，并在 `operations` 里加一条 `schedule`（`src/routines.ts:27-39`、`:11-21`）。
3. `flushWakes` 按 sequence 调 `server.wakes.schedule`（`src/host.ts:648-685`）。
4. 到期后 SDK 调 K8 的 `consume`，进入 `consumeRoutine`。它写 occurrence 和 Turn（`src/host.ts:484-489`）。
5. `process()` → `sync()` 用 K4 的 `enqueue` 入队，key 是 `turn.id`（`src/host.ts:598`）。这个 intent 没有 `occurrence` 字段。K4 不知道它来自 routine。
6. Turn 结束后，`sync()` 从 `inflight` 移除它，条件满足时 `switchVersion`（`src/host.ts:619-628`）。

K4 自己的路径在一次事务里写 occurrence、slot 和 intent（`examples/host-execution-core/src/routines.ts:110-124`）。intent 的 key 必须是 `occurrence:<key>`，并且和 occurrence 双向关联。否则 ledger 拒绝提交（`src/ledger.ts:26-27`、`:121-122`）。`settle` 结算 intent 时，也写 occurrence 的结论（`src/transitions.ts:25`）。

差异在第 5 步：K8 的 Turn intent 和 K4 的 occurrence 没有关联。要合并，K4 必须让 Host 在 occurrence 事务里写自己的状态，并在之后用关联方式入队。异步 Host job 不够：handler 在事务外运行（`examples/host-execution-core/src/core.ts:357-370`），K8 不能在同一次提交里写 Turn。

## 4. P3：必须保留的不变量

- **持久去重。** 一个 slot 最多产生一个 occurrence。重复投递只增加 `slotReplayCount`（`routines.ts:75-80`）。slot tombstone 过期前，重放直接返回（`core.ts:201`）。
- **预留即栅栏。** 只有等于 `routine.next` 的 wake 才能记 occurrence。其他情况写审计，不执行（`routines.ts:82-87`）。版本切换以后，旧版本的 wake 由这条规则拦住。所以 K4 不需要 K8 的 `generation`。
- **fail-closed。** 版本冲突、重放内容不同、未注册的 handler、不符合定义的 Host 结果，都抛错或写审计。不得静默改写。
- **既有 K4 ledger 契约。** `LedgerState.version` 保持 1。新增字段都是可选字段，和 `ignoredWakes` 的做法一样（`model.ts:86-87`）。`occurrence:<key>` 的关联规则不变。`addRoutine` 的语义不变：同定义幂等，不同定义报错。
- **版本切换不改在途工作。** 已接受的 occurrence 用接受时的版本完成。
- **无常驻兼容层。** ADR-038 记录了 O10：项目未上线，直接重构，不留兼容层（`docs/architecture/adr-2026-10-13-bot-platform.md:3`）。不保留 K4/K8 两套 wake 路径之间的 router。

## 5. 第 1–2 项：方案

### 5.1 选项

| 选项 | 内容 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A：只拆函数 | K8 版本规则改成纯函数，作用于窄类型；K8 仍自己调度 | 改动小（S–M） | 仍有两套模型；第 2.2 节的共存失败仍在；S7 和 S10 在同一进程里有两个调度器 |
| B：K4 吸收版本（推荐） | K4 `Routine` 加 `pending` 和 `updateRoutine`；加事务内 occurrence hook；K8 改用 K4 routine | 一套去重、补排、retention、审计；K4 已有版本化 key，改动集中 | K4 公开面增加；K8 routine 测试要改写；需决定重叠策略 |
| C：K8 模型替换 K4 | 把 `versions`、`operations`、`generation` 搬进 K4 | 保留 K8 全部行为 | 破坏 K4 的 slot、tombstone、retention、Host job 契约和 MCP 示例；重复做 K4 已有的栅栏 |
| D：共享 wake router | 按 key 前缀分发给 K4 和 K8 | 不改两边模型 | 就是 #612 想删掉的那层；去重和补排仍有两份 |

推荐 B。依据：

- K4 已经把版本放进 wake key 和 occurrence key（第 2.1 节）。不可变只由一处检查保证（`core.ts:173`）。
- K4 的预留栅栏已经能拒绝旧版本 wake。K8 的 `generation` 和按 routine 排序的 `operations` 在 K4 上没有必要。
- K8 能直接得到 #661 和 #684 的 retention，原始 key 不再进入审计。

### 5.2 K4 版本模型

数据：

- `Routine.pending?: RoutineDefinition`。不增加 `versions` 表。
- 理由：只有在途工作都结算后才切换。所以未结算的 occurrence 总是属于 `definition`（当前版本）。旧版本不需要留在 ledger 里。版本历史归 Host 服务（`README.md:315-318`）。

命令 `updateRoutine(definition)`，异步方法和事务内句柄（第 5.3 节）各一个入口：

- `definition.id` 必须已存在，routine 不能是 `completed`。
- `definition.version` 必须等于 `max(current, pending) + 1`。这就是 CAS：Host 服务分配版本号。
- 和 `pending` 或 `definition` 完全相同的重放，什么都不做。
- 版本号更小、或同版本内容不同，报错。
- 去向种类不能变：Agent、Host job、Host occurrence 三者之间不能互换。Host job 的 `type` 也不能变（见 O2）。
- 写入 `pending`，然后检查切换条件。

切换条件，作为导出的纯函数（例如 `versionSwitchDue`），不依赖 `HostLedger`：

- `lifecycle === 'active'`；
- 有 `pending`；
- 这个 routine 没有未结算的 occurrence；
- 没有到期未投递的旧 slot：`next === null` 或 `next.availableAt > now`。

切换动作：取消旧的 `next` wake，`definition = pending`，删除 `pending`，从 `now` 用新定义算 `next`。

其他规则：

- 有 `pending` 时，旧 slot 照常记 occurrence，但不再预留下一个旧 slot。这和 K8 的「不再给旧链补充」一致（`examples/bot-collaboration/src/routines.ts:95-97`）。
- K4 在每次 drain 的 scan 事务里检查切换条件。这和 K8 `sync()` 的做法一样（`src/host.ts:619-628`）。
- 暂停时取消 `next`，保留 `pending`。恢复时，满足条件就切换，否则按当前版本预留。
- `completed` 时丢弃 `pending`。
- 切换后投递来的旧 wake 落到 `reservation_mismatch` 审计（`routines.ts:86`）。

重叠策略：两边不同，必须选一个（见 O1）。

- 建议：只保留 K4 现行策略。新 slot 结算排队中的旧工作，保留运行中的那个（`routines.ts:100-109`）。对同一个 Agent 的 FIFO，结果最多一个运行中加一个排队中，和 K8 的上限 2 相同。区别是保留最新的，而不是丢掉最新的。
- K8 的 `capacity` 决策随之删除。K8 README 的「Routine invariants」一节（`README.md:103-126`）改写。
- 备选：定义里加 `overlap: 'supersede' | 'skip'`。它会多一个公开字段，K4 也要多一个审计原因。

日历：不改 K4。K4 每个 core 只注入一个 `NextOccurrence`（`schedule.ts:4`）。K8 和 AiphaBee 都注入 `@byok-sdk/core` 的 `nextRoutineOccurrence`，把 `rule` 当作 `RoutineSchedule`。`examples/byok-mcp-server/src/routines.ts:1`、`:24` 已经这样做。K8 的 `checkRoutineSchedule` 校验和 `daysOfWeek` 去重（`src/routines.ts:22-26`）留在 K8，在提交定义前执行。补排阈值改用定义里的 `lateAfterMs`，K8 写 60 000。

### 5.3 第三种去向：事务内 occurrence hook

定义：

- `RoutineDefinition` 增加第三种：`hostOccurrence: { type: string; input: Json }`。`execution`、`hostJob`、`hostOccurrence` 三者只能有一个。名字待定，见 O9。
- `HostOptions.occurrenceHooks?: Record<string, (run, tx) => void>`。`run` 带 `occurrenceKey`、`routineId`、`definitionVersion`、`trigger`、`type`、`input`。`tx` 带 `application` 和 `publish`，和 `OutcomeTransaction` 一样（`core.ts:18-24`）。
- hook 是同步的。返回 Promise 时抛错，和 `applyOutcome` 的检查一样（`core.ts:633`）。hook 不做外部 I/O。

`recordOccurrence` 对 `hostOccurrence` 的处理：

- 在同一个事务里写 occurrence 和 slot，然后调用 hook。hook 抛错时整个事务回滚，wake 留给 SDK 重试。
- 不创建 intent。occurrence 一直未结算，直到下面两种情况之一。

导出两个纯 transition，Host 在自己的 `ledger.transaction` 里调用：

- `promoteOccurrence(state, tenant, occurrenceKey, execution)`：现有函数（`routines.ts:128-136`）改为导出并按 key 查找。intent 的 key 是 `occurrence:<key>`，所以 `ledger.ts:121-122` 的关联检查照常成立。之后 `settle` 会写 occurrence 的结论（`transitions.ts:25`）。
- `concludeOccurrence(state, occurrenceKey, conclusion)`：给不需要执行的情况，例如 Turn 在入队前被取消。

重叠：未升级的 `hostOccurrence` 在新 slot 到来时，按现有 `job.executionSuperseded` 的规则处理（`routines.ts:101-103`、`:134`）：之后升级时立即记为 `superseded`。字段名在实现时确定，不改已有行。

事务内 routine 命令：

- `OutcomeTransaction` 增加 `routines` 句柄：`create`、`update`、`lifecycle`、`list`。K8 的 `create_routine` 等动作在 outcome 提交里执行（`host.ts:282-288`），而这个事务只暴露 `application`（`host.ts:238-239`）。
- 句柄复用 `addRoutine` 的校验（`core.ts:153-167`），在事务内用 core 的 `now` 和日历计算 `next`。异步的 `addRoutine`、`lifecycle` 改为调用同一组 transition。

### 5.4 K8 的改动

删除：

- `src/routines.ts` 的状态和调度部分：`operation`、`arm`、`switchVersion`、`consumeRoutine`。
- `CollaborationState` 的 `routines`、`occurrences`、`operations`（`src/model.ts:115`）和对应类型（`:87-106`）。
- `host.ts` 的 `flushWakes`（`:648-685`）、`recover` 里的 routine 补排（`:527-535`）、`sync` 里的 `inflight` 循环（`:619-628`）。
- `consume` 的分流。`consume` 改为：先 `sync`，再交给 `core.consume`。

保留（Bot 策略）：

- 每个 owner 最多 8 个未完成 routine（`src/routines.ts:30`）。用 `tx.routines.list()` 按 `input.owner` 计数。
- routine id：`hash([taskId, 'create_routine', index])`（`:33`）。
- `hostOccurrence.input` 带 `owner`、`authority`、`prompt`。owner 和 authority 在版本之间不能改。
- ContextPack 里的 routine 列表从 K4 的 `routines` 读取。

新增：

- 注册 hook `bot-routine`。hook 写一条 routine Turn，id 是 `occurrence:<key>`。
- `sync` 入队 routine Turn 时调用 `promoteOccurrence`，不调用 `enqueue`。
- `waitUntil` 改由定义的 `waitMs` 决定（`routines.ts:131`）。K8 写 300 000，和现在的 `now + 300_000`（`host.ts:598`）等长。区别是起点从入队时间变为 occurrence 记录时间（见 O10）。

K8 ledger：

- `CollaborationState.version` 升到 2。`stateOf` 已经拒绝未知版本（`src/model.ts:128`）。
- 旧的 version 1 ledger：建议拒绝打开并给出明确错误，不写迁移代码（见 O3）。

### 5.5 群聊和输入合并的纯规则

放在 `examples/bot-collaboration/src/rules/`。它可以单独 vendor。

边界：

- 只 import `@byok-sdk/protocol`、`@byok-sdk/core`、K4 的 `hash`/`canonical`，以及 `rules/` 自己。
- 不 import `LedgerState`、`HostLedger`、`stateOf`、`CollaborationState`。
- 一个测试扫描 `rules/` 的 import，保证这条边界。

函数照现有写法，直接修改传入的窄状态切片，不做 I/O，`now` 由调用方传入。

`rooms`：

- 输入是 `TeamState` 里 `rooms`、`rounds`、`seats`、`roots` 和 Bot 成员视图的切片。
- `advanceRooms` 不再收 `LedgerState`。它收每个 seat 的执行事实 `{ admitted, started, conclusion }`。它返回要取消的 seat id 和要新建的 seat Turn。
- K8 adapter 从 `s.intents`、`s.executions` 生成事实。它再把取消写到 K4 intent 的 `cancelReason`。行为不变。

`coalesce`：

- 输入是 `{ inputs, inputBatches }`，加上每个 Bot 的事实 `{ busy, configKey, archived }`。
- `admitUserInput` 返回「直接成 Turn」或「并入 batch」，以及这次封存的 batch 列表。adapter 负责建 Turn。
- 「新 Turn 先封存该 Bot 的 open batch」这条规则（`src/model.ts:139-141`）作为单独的纯函数导出，adapter 在建 Turn 前调用。

和双车道方案 D1 的关系：D1 定义「scope、command id、预期 revision → 新 revision、处置、outbox intent」的提交契约。这里的纯函数是 D1 状态转换的一部分。它们只负责决定，不负责提交、去重和 revision。

## 6. 第 3 项：Windows persona consumer

需要的东西：

- 一个跨平台的写入原语。AiphaBee 建议在 `createAgentHomeProjectionConsumer` 的回调 input 里加 `writeHomeFile(name, body)`（#606 第一条评论）。实现可以复用 `atomicWriteFile` 的 `fsync` 模式。
- 这是 `@byok-sdk/client` 的公开 API 变更。同一个 PR 要更新 `docs/spec.md` 和 api-surface golden。
- K8 的 `createBotPersonaProjection` 改用它，并删除 README 里「不支持 Windows」的段落。
- `windows-latest` 测试：写 3 个文件；在写入中途终止进程；每个文件要么是旧内容，要么是新内容；同一 revision 重放幂等。
- #681 发现 CI 选择器可能跳过 Windows job。这个切片要证明测试在 `windows-latest` 上真的运行了。

未知：

- 能承诺什么。WO-09a 的 `B=false`，所以 Windows 上只能承诺「进程崩溃下单文件原子」和「目标文件 flush」。OS 崩溃或断电后，rename 是否持久没有证明。
- SDK 的 projection 状态记录在 consumer 之后写（`agent-home.ts:1334-1335`）。OS 崩溃后，记录可能比文件新。那时只有 Host 重发同一 revision 才会重写文件。没有核实 Host 是否会重发。
- 多个文件是否要一起原子。`writeHomeFile` 只能逐个文件原子。

## 7. 第 4 项：云端权威接缝

本文不重复设计。双车道方案 D1 已经承接（`2026-10-21-dual-host-collaboration.md:174-188`）：

- 不允许在 H 的设备端由 constructor 创建本地 team（`:184`）。
- 配置和 history 由指定的权威读取。

需要先回答的问题：

- 双车道方案说，AiphaBee 新的联网 Bot 默认用 H（`:15`）。H Bot 的设备只处理收到的执行，不再运行同一 Bot 的 L routine（`:136`）。如果 S12 走 H，设备上就不运行 K8，「向设备 K8 注入 history」这个接缝不需要。
- 如果 S12 走「L 加云端 history」（`:120`），才需要 K8 的注入接缝。#606 原验收第 4 条（注入 history 的测试）只对这种形态有意义。

第 5.5 节的纯规则对两种形态都有用。

## 8. 第 5 项：两进程 relay

冲突：

- #606 要求实现两进程 Topology L relay，并把 `VALIDATION.md:152` 改成 PASS。
- 双车道方案写明：两个独立 L Host 之间的实时委派不进入首版，也不隐式桥接（`2026-10-21-dual-host-collaboration.md:140`）。
- #606 的需求示例（Bot 定义、history 和委派记录都在云端 DO）是 Topology H 的形态，不是 L↔L relay。

建议：把这一行改由 H 路径（双车道方案 D2/D3）提供证据。`VALIDATION.md:152` 保持 OPEN，并注明它不在首版范围。本文不排 relay 切片（见 O4）。

如果 owner 仍要 relay，未知项有：传输方式（两个 Host 直连，还是经云端 mailbox）、Host 之间的认证、谁部署它，以及 `SECOND-DEVICE.md:44-61` 里 inbox 和 outbox 的持久化位置。

## 9. 实施切片

顺序：R3 → R4 是 S7 和 S10 的关键路径。AiphaBee 不 vendor K8，它直接用 R4 的 hook 建自己的 Bot Turn。R5 是上游清理，不挡 AiphaBee。R1、R2 和 routine 无关，可以并行。R6 等 O6。

| 切片 | 大小 | 内容 | 验收与测试 |
| --- | --- | --- | --- |
| R1 | S | `rules/rooms`：移入纯规则；`advanceRooms` 改收事实 | 新的规则测试不 import `HostLedger`；`rooms.test.ts`、`group-chat.test.ts` 不改断言仍通过；import 边界测试 |
| R2 | M | `rules/coalesce`：同上；导出 boundary 封存规则 | 新的规则测试不需要 ledger；`coalesce*.test.ts` 不改断言仍通过；import 边界测试 |
| R3 | M | K4 `pending`、`updateRoutine`、`versionSwitchDue`；README 和 spec 段落 | 无在途时立即切换，旧 wake 取消、新 key 预留；有在途时进 `pending`，旧链不补，结算后切换；到期未投递的旧 slot 推迟切换；暂停和恢复；重放幂等；版本号错误、种类改变报错；切换后旧 wake 记 `reservation_mismatch`；`pending` 和切换之间重启再 `recover()`；Host job routine 也能升级版本；纯函数测试不需要 `HostLedger` |
| R4 | M | `hostOccurrence`、`occurrenceHooks`、导出 `promoteOccurrence` 和 `concludeOccurrence`、`OutcomeTransaction.routines` | hook 和 occurrence 在同一提交（崩溃夹具：两者都在或都不在）；重复投递只调一次 hook；升级后 intent key 是 `occurrence:<key>`，结算写回 occurrence；未升级时被新 slot 顶替；`compact` 清理已结算行；异步 hook 被拒绝；一个 K4 测试里 Agent routine、Host job routine、`hostOccurrence` routine 共存 |
| R5 | L | K8 改用 K4 routine；删除第 5.4 节列出的代码；`CollaborationState` v2 | K8 Host 里 Bot routine 和 Host job 共存的测试；`routines.test.ts` 改写，PR 里逐条说明每个改动的断言（例如 `capacity`）；旧 v1 ledger 打开时报明确错误；K8 routine 行由 K4 `compact` 清理；全部 K8 套件通过 |
| R6 | M | `writeHomeFile` 原语和 K8 persona consumer | 见第 6 节；api-surface golden 和 spec 更新；`windows-latest` 上实际运行的证据 |

每个切片都跑根目录的 required checks：`bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`。

## 10. 回退与风险

- 本 PR 只加文档，删除即可回退。
- R3、R4 只加可选字段和新命令。回退时，只要 ledger 里没有 `pending` 或 `hostOccurrence` 行，旧代码就能打开。有这些行时，旧代码的 `addRoutine` 校验会拒绝。这是 fail-closed。
- R5 升级 K8 状态版本。回退要恢复 R5 之前的备份。
- 最大的风险是 R5 改变 K8 已文档化的行为（`capacity`、Turn id、`waitUntil` 起点）。PR 必须逐条列出。
- `occurrenceHooks` 在 serialized drain 的事务里运行。hook 慢会拖慢整个 core，和 `applyOutcome` 一样。README 要写明。

## 11. 待决问题

给 owner：

- **O1 重叠策略。** 统一用 K4 的「保留最新」，删除 K8 的上限 2 加 `capacity`？还是在定义里加 `overlap` 字段，两种都保留？建议前者。
- **O2 版本规则。** `version` 必须严格加 1，去向种类和 Host job `type` 不能变。可以吗？
- **O3 旧 K8 ledger。** R5 拒绝打开含 routine 的 v1 ledger，不写迁移，可以吗？依据是 ADR-038 的 O10 和示例未发布。
- **O4 relay。** 第 5 项是否从 #606 移到 H 路径（双车道方案 D2/D3）？`VALIDATION.md:152` 保持 OPEN 并注明首版不做？
- **O5 拆分范围。** outcome、schema、委派的拆分留在双车道方案 D1，本文只做 routine、rooms、coalesce。#606 是否按 R1–R6 和 D1 拆成多个 issue？
- **O6 Windows 承诺。** persona 原语只承诺「进程崩溃下单文件原子加文件 flush」，不承诺 OS 崩溃和断电，可以吗？在 client 加公开 API 放在哪个版本？
- **O7 版本落点。** R3–R5 进哪个版本？本文假设不进冻结的 0.28.2。
- **O8 版本历史。** K4 只存当前版本和 `pending`，历史归 Host 服务，可以吗？
- **O9 命名。** `hostOccurrence` 和 `occurrenceHooks` 这两个名字可以吗？
- **O10 waitUntil 起点。** K8 routine Turn 的等待期从 occurrence 记录时间算，而不是从入队时间算，可以吗？

给 AiphaBee：

- **A1** S7 的 routine 在设备 K4（L）上，还是在云端调度器（H）上？如果在 H，需要哪些纯函数（例如 `versionSwitchDue`）？
- **A2** S10 的 watchlist 需要同 id 更新（R3），还是「换新 id」就够？只靠 #661 的 Host job 能不能先上线？
- **A3** Bot routine 和 watchlist 接受「保留最新」的重叠策略吗？
- **A4** S12 跨设备走 H（双车道方案默认），还是走「L 加云端 history」？
- **A5** persona 需要 OS 崩溃后仍持久吗？还是「进程崩溃下原子」加同 revision 重放就够？3 个文件需要一起原子吗？
- **A6** 所有 routine 都用 `@byok-sdk/core` 的 `RoutineSchedule`，并注入一个 `nextRoutineOccurrence` 吗？
