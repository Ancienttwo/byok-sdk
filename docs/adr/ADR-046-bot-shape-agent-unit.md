# ADR-046：SDK 不内置 Bot 产品形态，Agent 是 SDK 的单位

> **来源**：owner 2026-11-03 批准。依据是 owner 与 advisor 对两种 Bot 形态的讨论：多 Bot，以及单 Bot + Channel。PR：[#1354](https://github.com/Ancienttwo/byok-sdk/pull/1354)。
> **关联**：[ADR-038](../architecture/adr-2026-10-13-bot-platform.md)（Bot 平台与协作）、[ADR-039](ADR-039-bot-mode-product-prd.md)（Bot 模式产品方案）、[ADR-041](ADR-041-k8b-cross-bot.md)（K8b 跨 Bot）。

状态：已决定（owner 2026-11-03）。本文不改变现行的 API、wire、schema、存储和 K8 行为。

日期：2026-11-03。基线：byok-sdk `main@3c007119b`。

## 1. 背景

市场上的 Bot 产品有两种形态：一种是多 profile 的独立 Bot（例如 Grokbot），一种是单 Bot 带 Channel/Group 模式（例如 Claude Duet）。这两个产品的细节没有核实，本文只按形态讨论。owner 的问题是：SDK 要不要同时支持这两种形态，让下游自己选。

两个下游现在都有多个身份：

- **AiphaBee**：多 Bot 加协作。一个 workspace 最多 5 个 Bot，每个 Bot 自己选 runtime，Bot 之间有委派和群聊（#1319、#1321）。
- **Salesko**：多 Agent 私聊。Agent 的 runtime 创建后不能改，换 runtime 要新建一个 Agent；一个对话只绑一个 Agent，没有群，也没有 channel。

两边需要多个身份的直接原因相同：runtime 绑在身份上。单 Bot + Channel 目前没有下游在用。

## 2. 决定

**D1. SDK 不内置产品形态。** 多 Bot 和单 Bot + Channel 都由 Host 用同一组原语组合出来。

**D2. SDK 的单位是 Agent，即 agentRef 加它的 home。**

- 执行队列按租户、设备和 Agent 分开排（`packages/server/src/execution-core/transitions.ts:32-35`）。
- 每个 Agent 的 home 是按 agentId 命名的目录（`packages/client/src/agent-home.ts:452`）。
- persona 是投影进 home 的文件，记忆属于 home。
- 每次执行的上下文由 Host 给。

**D3. 产品身份到 Agent 的映射归 Host。** 用户看到的 Bot 只存在于 Host 里。

| 形态 | 一个身份对几个 Agent |
| --- | --- |
| 多 Bot | 1:1 |
| 单 Bot + Channel | 1:N，每个会话一个 Agent，同一份 persona 投影到每个 home |
| 混合 | 两种映射并存 |

**D4. 发布的包里不放 Bot、群、团队的状态和规则**，包括账本、发言仲裁和团队快照。`@byok-sdk/protocol` 的 `bot-turn-outcome` 只提供 Host 组合 outcome schema 用的词汇，不带状态，保持不变。

**D5. K8 是 1:1 映射的参考实现，不加模式开关。** 加了开关，每条规则都要按模式分叉，一个状态机里就同时有两套语义。

**D6. 1:N 的参考实现，等有下游开 issue 再做。** issue 要写清楚三件事：channel 里有哪些人，Bot 跨 channel 要记住什么，预期并发多少。参考实现从那个下游的真实接入里提炼，就像 K8 是从 AiphaBee 的接入里提炼出来的。

## 3. 后果

- 下游现在就能用发布的包实现任一种形态，不必等 SDK。
- 如果有 issue 要求把 Bot、群或团队的状态放进发布的包，按 D4 拒绝，或改成在 Host 或 K8 里做。
- 走 1:N 时还要处理下面这些问题，到时在对应的 issue 里定：
  1. **home 回收。** 会话多、寿命短，home 会越积越多。现在归档 Bot 不会删它的 home（`examples/bot-collaboration/README.md:773`）。回收规则和 #1105 的保留规则一起定。
  2. **跨会话的共享记忆。** 由 Host 放进每一轮的上下文。SDK 不加跨 Agent 的记忆。
  3. **persona 更新。** 每次更新要投影 N 次，成本随会话数线性增长。
  4. **设备并发。** 设备上能同时跑的任务数不随 Agent 数增加（K8 的 `deviceConcurrency` 默认 8，`examples/bot-collaboration/src/host.ts:130-133`）。
  5. **发言规则和权限。** 沿用 K8 的做法：mention 模式、#1230 的 `memberMentions`、principal 校验。

## 4. 不采用的方案

- **SDK 内置两种模式，让下游选。** 第二套参考实现没有消费者，细节只能靠猜，维护面和测试矩阵还会翻倍。
- **在 K8 里加模式开关。** 理由见 D5。
- **把「一个 Bot 对一个 Agent」写进发布的包，例如让 K4 按 Bot 排队。** 这样会挡住 1:N，而现有下游也不需要这样做。
