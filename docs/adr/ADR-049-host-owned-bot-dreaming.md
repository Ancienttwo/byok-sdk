---
schemaVersion: archcontext.adr/v1
title: 做梦归 Host 层，K8 Bot 默认开启，SDK 只提供指令构建函数
status: accepted
decidedAt: 2026-11-06
appliesTo:
  - sdk-root
---

# ADR-049：做梦归 Host 层，K8 Bot 默认开启

> **来源**：issue [#1475](https://github.com/Ancienttwo/byok-sdk/issues/1475)。owner 决定见 [6677575477](https://github.com/Ancienttwo/byok-sdk/issues/1475#issuecomment-6677575477)（v1 范围）和 [6678494027](https://github.com/Ancienttwo/byok-sdk/issues/1475#issuecomment-6678494027)（Bot 默认开启，Host 层，模型有基础方案和 fallback）。设计裁定见 [6677987347](https://github.com/Ancienttwo/byok-sdk/issues/1475#issuecomment-6677987347)（`agentMemory: 'none'`）和 [6679051372](https://github.com/Ancienttwo/byok-sdk/issues/1475#issuecomment-6679051372)（`bot-dream` hook 和 H 的 B1）。
> **实现**：[#1477](https://github.com/Ancienttwo/byok-sdk/pull/1477)（`packages/protocol/src/dream.ts`）、[#1481](https://github.com/Ancienttwo/byok-sdk/pull/1481)（`examples/bot-collaboration/src/dream.ts`）。
> **关联**：[ADR-046](ADR-046-bot-shape-agent-unit.md)（Bot 状态归 Host）、[ADR-048](ADR-048-device-injects-resident-memory.md)（`MEMORY.md` 注入）。

状态：已决定（owner 2026-11-06）。

## 1. 背景

做梦是一个后台任务：定时读过去的记录和现有记忆，核对、补充、整理，让之后的任务读到更好的记忆。

记录在哪里决定了 v1 的形状。journal 不存事件和工具的输入输出，云端的 activity 在任务结束后很快过期，对话历史归 Host（`docs/spec.md`「Fresh Agent execution Host composition requirements」）。完整的工具记录只在设备上各 runtime 自己的会话文件里。所以 v1 的输入只有现有记忆和 Host 历史。

## 2. 决定

**D1. 做梦归 Host 层。** SDK 不定时，不存 Host 历史，也不加做梦存储；v2 的输入与 wire 加法见 [ADR-050](ADR-050-dream-native-session-input.md)。`@byok-sdk/protocol` 提供纯函数 `buildDreamInstruction`：Host 用自己的历史调用它，把结果作为 fresh task 发出。K8 的 `BotCollaboration` 是这样的一个 Host，Host 仓库按 `src/VENDOR.md` 拷贝。（#1845 修订：拷贝已取消，Host 安装 `@byok-sdk/bot-collaboration`。）

**D2. K8 Bot 默认开启。** Host 级选项 `dreaming`：
- 不传就开启，`false` 关掉整个 Host 的做梦，并结束所有未完成的做梦 routine。
- 每个未归档、模板可用的 Bot 有一个做梦 routine。每次 sync 补上新 Bot 的，结束已归档 Bot 的。
- 默认每天 03:00。时区取 `dreaming.timeZone`；没配时取建 routine 时进程的本地时区，存进 routine 定义。
- 这个 Bot 自上次做梦成功以来至少完成过一个 Turn 才跑，否则记下 `no_new_turns` 并跳过。

**D3. 模型按基础方案加 fallback 选。** 做梦总是跑在 Bot 自己的设备上，因为记忆 home 在那里。
1. 基础方案：`dreaming.models` 里第一个在当前 `models` 中存在、并且在这台设备上的模板。
2. fallback：Bot 自己的模板。
3. 两个都没有：跳过这一次，记下 `model_unavailable`。

模板只提供 runtime 和 limits，Agent 仍是 Bot 的 `agentRef`。便宜不便宜只由这个列表决定，K8 不从 runtime 名推断厂商或价格。每次结果记在 `snapshot().dreams`，包括用了哪个模板、是不是 fallback。

**D4. 做梦是 fresh writer。** 所有平台都是 `agentMemory: 'none'`，不带 `agentMemoryCommit`。offer 必须显式写 `none`：不写时由 daemon 的准入决定，可能挂上记忆 MCP。不带原生会话输入时，方法由 D1 的指令给出，使用 runtime 自己的文件工具；v2 的 lane、平台和 offer 限制见 [ADR-050](ADR-050-dream-native-session-input.md)。它不带 `homeAccess`、`preparation`、`messageEgress` 和 `requiredToolsets`。

**D5. 路径按 cwd 解析。** 做梦不是 `homeAccess` 任务，所以 cwd 就是 Bot 的 home。`none` 模式下设备不注入 `MEMORY.md`，也不加记忆说明。指令里的 `MEMORY.md` 和 `notes/` 都从 cwd 解析。

**D6. K4 管队列。** K8 自己的 occurrence hook `bot-dream` 把 occurrence 记成待做梦，K8 的 sync 再决定跳过，或者把它提升进这个 Bot 的 FIFO。FIFO 位置、顶替和截止时间都由 K4 管。用户输入排在还没开始的做梦前面。正在跑的做梦不打断，用户输入最多等 `maxDurationMs`，默认 15 分钟。`dreams.open` 记下每个做梦 intent 的归属，所以它的终态到不了 Host intent handler。

**D7. H 跑完整做梦（B4，#1516）。** H 通过 K8 package exports 使用同一份 `dream.ts` 规则，默认开启；每个 scope 的 Host config 可配置 `dreaming` 或用 `false` 关闭。H 在 scope 事务中记录 occurrence、决定 promotion 并持久化结果。成功终态属于 dream，不经过 Bot outcome parser；后续 sync 从 intent conclusion 关闭 dream，只有成功推进 mark。Host history 在事务外读取，缺结果等待、失败记 skip，不回退到本地 Turn。`dreams.open` 在结果同步前保留，因此 #1500 的 compaction veto 同样适用；H 仍不压缩 routine intents。H 和 L 共用 `userFirst` 及后台 intent 集合，用户 Turn 在入队事务内越过同 Agent 尚未提交的 routine、bot_request 和 dream intent；H 的 device slot reservation 不在这次范围内。

## 3. 影响

- v1 的 SDK wire 和存储不变，v2 的 wire 加法见 [ADR-050](ADR-050-dream-native-session-input.md)；做梦记录在 K8 自己的 application state 里。`buildDreamInstruction` 是 protocol 的公开 API 加法，属于 MINOR。K8 的默认行为变了，拷贝 K8 的 Host 按 CHANGELOG 和 README 迁移。
- 默认开启的成本是每个有新 Turn 的 Bot 每天跑一次。没配列表时用 Bot 自己的模型，可能偏贵，Host 应当把便宜的模板排进 `dreaming.models`。
- 做梦期间到的用户输入要等它结束。
- 记忆超限时做梦照常跑。两种启动拒绝的 reason 都写明修复办法：发一个 `agentMemory: 'none'`、不带 `agentMemoryCommit` 的写任务（`docs/protocol.md` §2.2）。做梦正是这种任务，所以不需要例外。
- 开始时 `MEMORY.md` 在上限以内、结束时被写超，设备把它恢复成开始时的内容，`notes/` 不动。这和 `agentMemory` 的取值无关（ADR-048）。
- 做梦的写入没有回滚。指令要求每一步之后记忆都完整可用：先写目标文件、读回核对，再删源文件。做梦没有成功时，下一次覆盖同样的 Turn。
- 不带原生会话输入的 v1 不加工具限制：「只改 `MEMORY.md` 和 `notes/`」是指令里的要求，设备不强制。推荐用 Pi 跑做梦；审批请求走普通任务路径，Host 可以拒绝。v2 的工具与外发边界见 [ADR-050](ADR-050-dream-native-session-input.md)。
- 不带原生会话输入时仍看不到工具层面的事实；v2 的输入范围与残余风险见 [ADR-050](ADR-050-dream-native-session-input.md)。

## 4. 不做

| 方案 | 原因 |
| --- | --- |
| SDK 自己定时，或加 wire 字段和存储 | Host 的队列、生成和定时都不归 SDK。 |
| Host job 加 `enqueueHostIntent`（Step 0 的 A） | K8 要再写一份顶替逻辑。 |
| 带标记的 routine Turn（Step 0 的 C） | Turn 代码要绕开 Bot frame 和 outcome schema。 |
| 设备支持时带 `agentMemoryCommit: 'on-success'` | 记忆超限时带它的任务启动前就被拒，而做梦要把记忆收回上限。 |
| 不写 `agentMemory`，由 daemon 决定 | 可能挂上记忆 MCP，`MEMORY.md` 超限时做梦启动前失败。 |
| 从 runtime 名推断便宜的模型 | runtime 名不等于厂商，用户可以接任何模型。 |
| 只给有 Claude 或 Codex 的用户用 | owner 要求所有接入的 agent 都能做梦，所以 fallback 到 Bot 自己的模板。 |
| 合并文件时留 `MOVED TO` 占位 | 占位文件占用文件数上限。 |
| H 导出时拒绝（B3） | 默认开启以后，所有 Host 都切不到 H。 |

## 5. 延后

- **v2 设备原生会话已决定进入 0.40：** 设计与验收边界见 [ADR-050](ADR-050-dream-native-session-input.md)，不再适用原来的延后触发条件。

## 6. 取代

无。本 ADR 不取代已有 ADR 的条款。
