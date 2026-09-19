# OP2-U：官方 Pi 最小接口请求包

日期：2026-09-19
方案：`plans/plan-20260919-1603-official-pi-migration.md` §8.2
前置：`docs/researches/2026-09-19-official-pi-op1-probe-report.md`（G1 = 第二档）
补充证据：`docs/researches/2026-09-19-official-pi-op1-probe-results.json` 中的 `p03b` / `p04d` 两项
上游对象：`earendil-works/pi`（本文写的是**请求**，不是「上游已经支持」）

## 0. 这份文档要解决什么

OP1 裁定：官方 `@earendil-works/pi-coding-agent@0.85.1` 缺三样东西，BYOK 的 prepared 生产路径因此必须保持禁用。但「缺三样」不足以提出上游请求——需要把它们精确到「哪个公开路径做到了什么、差在哪一个字节、差在哪个契约」。本文就用本轮实测把缺口切到可提接口的粒度，并给出最小复现与验收面。

一个前提先排除：**不能用替代手段补**。private deep import、安装后 patch、复制官方 serializer/provider/session 核心、全局网络 monkey patch、关闭预算/S2，都在方案里被明确禁止。因此本文只提通用能力，不要求 Pi 认识 tenant、Turn、BYOK receipt 或 custody。

## 1. 精确缺口（每条都有实测数字）

### G-A：会话的首个请求无法由调用方在会话之外复现

`p03b-pre-session-request` 用同一个模型、同一个显式系统提示、同一条用户消息做了两次：

| 路径 | 结果 |
|---|---|
| 会话（`createAgentSessionFromServices` + `prompt`） | wire body **308** 字节，顶层键 `max_completion_tokens, messages, model, store, stream, stream_options` |
| 会话外（公开子路径 `@earendil-works/pi-ai/api/openai-completions` 的 `streamSimple` + 显式 `Context`） | 调用方拿到 **248** 字节 payload，顶层键多出 `prompt_cache_key, prompt_cache_retention` |

两处具体分歧：

1. **系统消息被会话附加了调用方无法复制的运行时上下文**。调用方给的是 `SYSTEM_MARKER_P03B`；会话实际上发出的是 `SYSTEM_MARKER_P03B\nCurrent working directory: …`。用户消息字节完全一致。
2. **provider 选项面在两条路径上不一致**：直接路径会带上 prompt cache 相关键，会话路径不带。

含义：D 本身在会话外**拿得到**（这否掉了「完全没有公开编译路径」的最坏判断），但拿到的**不是会话将要发送的那一份**。方案 §8.1 要求「已授权 snapshot → 完整 request D → counter projection P(D)」，而当前没有公开入口能保证第一段就是会话真正会发的那一段。

### G-B：payload 不携带任何「编译器证明了什么」的契约

同一次 `p03b` 调用里，payload 经由 `onPayload` 交给调用方（`transportBodyEqualsPayload: true`——调用方看到的字节与真正要发的字节一致），但：

- 这个 payload 里没有任何 certification 字段（实测筛选 `certif|project|residual|coverage|proof|digest` 得空集）；
- `onPayload` 的返回类型是 `unknown | undefined`，语义是「可以替换 payload」，不是「校验并拒绝」；
- 整个 published surface 没有任何准备/投影入口（`p03-task-free-preparation`：coding-agent 151 个导出、pi-ai 48 个导出，匹配数为 0）。

含义：INV-06 要求预算包含实际 framing/history/tools/授权附加内容，并禁止用经验比例或事后 usage 顶替未知覆盖。没有「编译器对 D 的结构投影」，BYOK 只能自己再写一份本地推导——那正是本项目禁止的第二语义权威。

### G-C：host 断言的 assistant 历史无法进入请求，且失败是静默的

`p02-history-projection` 的对照/处理设计：唯一差别是处理组先用公开 `SessionManager.appendMessage` 追加一条不带 `api`/`provider`/`model`/`usage`/`stopReason` 的 assistant 文本。

| 组 | 请求数 | session model | `prompt()` | 事件流 |
|---|---|---|---|---|
| 对照 | 1 | `probe-model` | 不抛错 | 含 `message_update`（真实流式） |
| 处理 | **0** | `probe-model` | 不抛错 | 只有 `message_start`/`message_end` |

含义：官方没有「host 断言文本」这一类事实。BYOK 需要它是因为 INV-07/INV-10：Host 拥有 transcript，SDK 必须能把 Host 已有的 assistant 正文按原样带进新会话，而**不得伪造** provider/model/usage 出身。当前行为不是「拒绝」，而是「静默不发」——这在生产里会表现为「成功但没有正文」。

### G-D：transport 拒发不可传播（**但这条不需要上游**）

`p04-send-gate` 用例 B + `p04d-refusal-observability`：

- 拒发时端点**收到 0 次**请求（安全属性成立）；
- transport 被调用 4 次、事件流出现 3 次 `auto_retry_start`，`prompt()` **不抛错**，最终 `agent_settled`；
- 但调用方**拥有**自己的 side channel（`p04d` 记录到 4 次可归属的 refusal），并且 session 转录里留下了 `stopReason: "error"` 的 assistant 条目。

结论：运行归属方（daemon）可以自行判定「拒发且零请求」，因此本条**不构成对上游的必需请求**，但它仍暴露一个语义风险：会话把一次被拒绝的运行报告为正常结束。BYOK 侧必须显式映射，不能把这个「正常结束」当成功。

## 2. 请求的接口（提议职责，不声称上游已有这些名字）

以下按职责描述，签名只是形状示意；不要求上游采用这些命名。

1. **会话首请求的纯编译入口**（对应 G-A/G-B）

   ```ts
   // 形状示意，非上游现有 API
   function prepareSessionRequest(input: {
     model: Model<Api>;
     context: Context;              // 调用方已完全解析的输入
     options: PrepareOptions;       // 显式、可枚举
     binding: InputBinding;         // 调用方身份，用于绑定
   }): Promise<PreparedRequest>;    // { body, bodyDigest, projection }
   ```

   要求：
   - **纯**：不读文件、环境、会话、凭证、网络；不创建 session；
   - 产出的 body 与「同一输入在会话里实际发送的第一请求」逐字节一致（这是本请求的核心，不是附加条件）；
   - `projection` 说明编译器对请求证明了什么，并对**其余每个顶层键**给出结构分类；无法分类时 fail closed（`unknown`），不得省略。

2. **会话按冻结请求消费**（对应 G-A）

   ```ts
   session.promptPrepared(prepared, expected)  // expected 来自调用方独立来源
   ```

   要求：复核不通过时在 transport 之前拒绝；同一 digest 不二次派发；复用普通会话的生命周期、事件、工具与持久化，不另起一套。

3. **host 断言 assistant 文本作为一等消息种类**（对应 G-C）

   ```ts
   interface HostAssertedAssistantMessage {
     role: "assistant";
     origin: "host";      // 判别位；与 provider 生成的消息互斥
     content: TextContent[];
     timestamp: number;
   }
   ```

   要求：序列化时按普通 assistant 文本逐字节进入请求；**不参与**模型推导、usage 统计、cache 命中判断与压缩锚点；不得要求调用方伪造 `api`/`provider`/`model`/`usage`/`stopReason`。

4. **transport 拒绝的显式语义**（对应 G-D，**优先级最低**）

   要求（或由上游明确文档化为「不可依赖」）：调用方注入的 transport 抛出的错误，能作为 typed、不可静默重试的失败到达调用方；至少不得让一次被拒绝的运行以「正常结束」呈现。

## 3. 最小复现（本仓，可一键运行）

```bash
node packages/client/probes/pi-official/run.mjs --probe p03b   # G-A / G-B
node packages/client/probes/pi-official/run.mjs --probe p02    # G-C
node packages/client/probes/pi-official/run.mjs --probe p04d   # G-D
```

运行器会现场安装官方 tarball 到临时树、把探针源码复制到该树下、以空 `HOME` 起独立子进程、把请求打到本机 127.0.0.1 合成端点；不接触任何真实凭证，也不调用任何真实模型。当前期望结果：

| 探针 | 当前 verdict | 说明 |
|---|---|---|
| `p03b` | not-supported | 会话外能拿到 D，但不是会话会发的那一份；且无 certification |
| `p02` | not-supported | host 断言历史导致静默 0 请求 |
| `p04d` | supported | 运行归属方可自行判定拒发（所以 G-D 不是必需请求） |

上游修复落地后，`p03b` 应能证明「会话外 body == 会话首请求 body 且附 projection」，`p02` 的处理组应产生 1 次请求且该消息以 assistant 原文出现。

## 4. 上游验收面（建议随补丁一起提测）

1. 纯编译入口：同一显式输入下，`prepare` 的 body 与真实会话首请求 body 逐字节相等；一个工具 schema、模型、resource 或 option 改动都会让相等性失败。
2. 纯度：编译调用不产生文件系统写入、不读凭证、不发起网络请求（负控：把网络/FS 打桩为抛错后仍应通过）。
3. 分类完备：所有顶层键要么被证明被覆盖，要么被显式分类；未知键必须走 `unknown` 并 fail closed。
4. 消费复核：`expected` 与 envelope 任一字段不一致时，transport 零调用。
5. host 断言历史：该消息进入请求且字节保持；不计入 usage/cache/模型推导（对比例子：同内容但带完整 provenance 的助手消息行为不变）。
6. 普通 CLI 行为不变：不传新选项时，既有交互/print/RPC 行为与输出不变。

## 5. BYOK 侧在不依赖上游时能做什么、不能做什么

能做（不需要上游）：

- 运行归属方自行判定「拒发且零请求」（`p04d` 已证），并把它映射为 typ failure，而不是让会话的「正常结束」冒充成功。
- 让 BYOK 拥有 transport、由官方产出 serializer 结果（`p04` 用例 A：观察字节 == 线上字节）。
- 显式 session 组装、工具授权、装载 allowlist（`p01` / `p05`）。

不能做（缺 G-A/G-B/G-C）：

- 在创建 Execution 之前产出**会话将会发送的**那一份冻结 D。
- 对 D 给出可审计的覆盖证明；任何本地再推导都会造出第二语义权威。
- 把 Host 已有的 assistant 正文带进新会话而不伪造出身。

因此：**prepared 生产路径继续保持禁用，`official_supported` 不得声明**；OP3/OP5 中不依赖这三项的独立部分可以继续准备，但不得先行切换产品依赖（切换后 prepared 会从「禁用」变成「缺失」，属于 INV-14 禁止的静默降级）。

## 6. 未决

- 上游是否接受该请求、以什么形态接受、何时进入受支持发行包，均不由本仓决定。
- 本文只覆盖 `openai-completions` 一条路径；WebSocket 与其他 API 按方案保持不支持，未做验证。
- 递归/子进程模式下上述结论是否一致（`registerProvider` 在 print/runner 中的可用性）属 OP4 范围，本轮未验证。
