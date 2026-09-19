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

## 6. 上游落点（2026-09-19 只读核对 `earendil-works/pi@main`）

为了让下一刀不必再从零找位置，本轮只读拉取了三份上游源码并记录了锚点（未提交任何上游内容）：

| 缺口 | 上游文件 | 锚点 | 说明 |
|---|---|---|---|
| G-C | `packages/coding-agent/src/core/session-manager.ts`（1786 行） | `:380` `entry.message.role === "assistant"` 决定 session model；`:1043`、`:1528` 的 `hasAssistant` 决定 flush/写入 | 与 fork 修补的三处语义位置一一对应，是最小、最自洽的一刀 |
| G-A | `packages/coding-agent/src/core/sdk.ts`（410 行） | `:39` `CreateAgentSessionOptions`；`:173` `createAgentSession`；`:308` 分支内的 `systemPrompt: ""` | 会话组装入口，决定「调用方能否只靠显式输入决定首请求」 |
| G-A | `packages/coding-agent/src/core/system-prompt.ts`（216 行） | `:9` `BuildSystemPromptOptions`；`:54` `normalizeBuildSystemPromptOptions`；`:121` `buildSystemPromptSections`；`:186` `buildSystemPromptState`；`:195` `buildSystemPrompt`；`:155` 调用 `getDocsPath()` | 上游已有比预想更细的分段导出，但 `buildSystemPrompt` 内部仍直连 `config.ts` 的 docs 路径（fs/config 耦合），这是纯投影必须拆开的那一处 |

两点补充观察：

1. `Current working directory:` 这段被会话追加进系统消息的内容**不在** `system-prompt.ts` 里，说明它由会话组装阶段另行附加。G-A 的补丁必须先定位这个来源，否则「会话外复现」无法成立。
2. 上游 `main` 的 `packages/coding-agent/src/core`（52 个条目）确认仍**没有** `input-preparation.ts` / `prepared-session-input.ts`，所以 G-A/G-B 不是「等一个已有模块发布」，而是要提新接口。

## 7. G-C 的形状代价实测（2026-09-19，上游 main 一次性实验）

本节是一次**实际动手**的结果，不是估计。它推翻了本文 §2.3 提的「新增一等消息种类」是「最小上游改动」这一假设。

做法：完整 checkout `earendil-works/pi@main`，`npm ci --ignore-scripts` + `packages/ai` 的 `hydrate-model-data` 之后先跑基线类型检查——**`npx tsgo --noEmit` = EXIT 0，基线干净**；随后只在 `packages/ai/src/types.ts` 加入 `HostAssertedAssistantMessage`（`origin: "host"`）、在 `AssistantMessage` 上加 `origin?: undefined` 判别位、并把 `Message` 联合扩成五元，再跑同一条命令。

结果：**146 个类型错误，分布在 42 个文件、4 个 package**：

| package | 错误数 |
|---|---|
| `packages/coding-agent` | 75（如 `modes/interactive/interactive-mode.ts` 23、`core/agent-session.ts` 6、`core/usage-totals.ts` 4、`modes/interactive/components/footer.ts` 5） |
| `packages/agent` | 44（harness/runtime、pico3 等新子系统） |
| `packages/ai` | 22（如 `api/openai-completions.ts` 16、`api/anthropic-messages.ts` 4、`api/google-shared.ts` 2） |
| `packages/evals` | 5 |

按目录分：`src` 107、`test` 28、`examples` 11。典型错误形态：`Property 'stopReason' does not exist on type 'AssistantMessage | HostAssertedAssistantMessage'`。

### 这说明了什么

「加一个新消息种类」不是局部改动：判别位一旦进入 `Message` 联合，**每一个 switch 或字段读取点都必须表态**——包括 BYOK 根本不使用的 `packages/agent` harness 子系统与 `packages/evals`。这类跨 4 个 package、107 个生产点的改动，其形状应该由上游决定，而不是由 BYOK 单方面提一个已成型的补丁。把它作为补丁直接提交，反而会把一个需要设计讨论的问题包装成既成事实。

### 候选形状与其代价（供上游选择）

| 形状 | 代价 | 说明 |
|---|---|---|
| A. 新增一等消息种类（本次实测） | 146 处、4 个 package | 类型最清晰，但波及最广 |
| B. 在 `AssistantMessage` 上加可选判别位，并把 `api`/`provider`/`model`/`usage`/`stopReason` 一并放宽为可选 | 联合收窄错误减少，但**每一处读 provenance 的点都要处理 undefined**——波纹只是从「新成员」移到「可选字段」，总数未必下降 | 类型安全性整体下降 |
| C. 保留消息类型不变，改由调用方显式声明「导入 host 文本为 assistant」的入口，由该入口构造出不带伪造用法计数的 assistant 消息 | 需要一个新入口 + 记账路径承认这一约定 | 波纹最小，但引入一个新的「无出处」状态，仍要设计 |

### 建议给上游的提法

不要提交 A 的补丁。改成：**用本轮实测（基线 EXIT 0 → 加一成员后 146 处）说明代价，请上游在 A/B/C 之间选择形状**；BYOK 提供使用场景、不可伪造 provenance 的硬约束、以及 §3 的最小复现与 §4 的验收面作为输入。

附带结论：上游任何形状落地后，BYOK 侧需要重新核对的点是同一批——`session-manager` 的模型推导、`usage-totals`、`cache-stats`、`estimate`，以及各 API 的消息转换。本节的 146 处清单就是那份核对清单的初稿（本机 `/tmp/pi-upstream`，未提交任何上游内容）。

## 8. G-A 实测（2026-09-19，上游 main，真实 session 路径）

做法：在已装好依赖、基线类型检查 EXIT 0 的 `main` checkout 里写一个**临时** vitest 实验（`packages/coding-agent/test/zz-byok-ga-experiment.test.ts`，只在本机 `/tmp`，未提交上游）：用仓库自带的 `createModelRegistry` / `getModelRuntime` / `createTestResourceLoader` 建真实 `AgentSession`，`cwd` 与显式系统提示由调用方给定，把真实目录模型（`anthropic/claude-sonnet-4-5`）的 transport 换成调用方拥有的 `streamSimple`，在其中捕获**会话交给 provider 的 Context** 与 adapter 实际要发的 body，然后拒发（不发任何网络请求）。

结果（`BYOK_GA` 输出，一次通过）：

| 项 | 值 |
|---|---|
| 会话首请求 body 字节数 | **6123** |
| body 顶层键 | `max_tokens, messages, model, stream, system, thinking, tools` |
| 交给 transport 的 **Context 键** | **仅 `messages`** |
| `messages` 的角色序列 | **`system, system, user`** |
| transport 尝试次数 | **4**（`auto_retry` 与 0.85.1 同形，`main` 未改） |

### 三个可操作的结论

1. **系统提示在 `main` 上不是一条消息，而是两条 system 消息**。任何「会话外复现首请求」的方案都必须复现这个拆分，而不是拼一段 prompt 文本。
2. **Context 只带 `messages`**：`system`、`tools`、`thinking`、`max_tokens` 这些顶层键由会话在 adapter 选项层拼出。也就是说调用方要复现的不只是对话内容，还包括**选项推导**——这正是 §1 G-A 里「选项面在两条路径上不一致」在 `main` 上的具体形态。
3. **`auto_retry` 在 `main` 上仍然是 4 次尝试**：P04-B 的「拒发不可传播」不是 0.85.1 独有，是当前 `main` 的行为。G-D 因此继续按「不需要上游、BYOK 侧显式映射」处理。

### 这一节改进了什么

§1 的 G-A 只有定性描述（248 vs 308 字节、cwd 注入、选项不一致）。现在有了 `main` 上的实测形状（两条 system 消息 + 选项层推导 + 6123 字节的完整请求），上游请求里的 G-A 从「请给我们一个纯编译入口」变成了可检验的表述：**请把会话的首请求组装（system 消息拆分、选项推导、工具集）暴露为纯函数，或允许调用方显式提供组装结果**。

（下两节是本节的收尾：先看会话实际交出的三条消息，再做逐字节比对，并据此再次收紧 G-A 的表述。）

### 会话实际交给 transport 的三条消息

| # | role | 键 | 字节 | 内容 |
|---|---|---|---|---|
| 1 | `system` | `content, role, timestamp` | 16 | **调用方给的系统提示原文**（`SYSTEM_MARKER_GA`） |
| 2 | `system` | `content, role, sections, timestamp, toolsAdded` | 0（content 为空） | **派生的提示状态**：具名 `sections` + 完整 `toolsAdded` 声明 |
| 3 | `user` | `content, role, timestamp` | 32 | 调用方的用户消息（text 块） |

关键：调用方显式给的系统提示**原样保留**为第一条消息；派生的东西集中在第二条。这把「复现首请求」拆成了「复现派生的 sections 与 toolsAdded」。

### 逐字节比对（调用方只用公开入口重建）

用公开导出的 `buildSystemPromptSections({ cwd })` 在**没有 session** 的情况下重建同一批 sections，与会话里的实际值逐字节比较：

| section | 会话实际 | 调用方重建 | 相等 |
|---|---|---|---|
| `cwd` | 76 | 76 | **是** |
| `docs` | 1160 | 1160 | **是** |
| `preamble` | 169 | 169 | **是** |
| `rules` | 839 | 146 | 否 |
| `tools` | 339 | 124 | 否 |

第一轮就 3/5 逐字节相等，而且**完全不依赖 session**。再补上 `selectedTools: <会话 toolsAdded 的名字列表>` 后 `rules`/`tools` 两个 section 的调用方结果**没有变化**——说明这两段取决于公开入口还接收、但会话从自身状态填充的输入（工具 snippets/guidelines 等）。

### 这改变了 G-A 的表述（重要）

原判断是「官方没有公开的纯编译入口」。现在要修正为：

1. **提示投影在 `main` 上已经是公开且纯的函数**，且大部分内容当场就能逐字节复现（3/5 sections 一次通过，`docs` 这种 1160 字节的大段也完全一致）。
2. 真正缺的不是「一个 compile 函数」，而是**会话自己的输入推导**：会话喂给投影的那一整套输入（工具选择、snippets、guidelines、context files、skills、append 配置）没有公开入口能让调用方以同样方式得到。
3. 因此 G-A 的上游请求应精确表述为：**暴露（或文档化）会话的输入推导，使调用方用同一组显式输入能逐字节重建首请求**——而不是「新增一个准备接口」。

这一条也把目标版本分叉往「重钉到下一发行版」推：`main` 已经把提示投影拆成了公开纯函数，继续对 `0.85.1` 提接口等于要求上游回到旧形状。

### 残余差异的字段级归因（已定位）

把会话的输入推导按源码逐项搬到调用方（`packages/coding-agent/src/core/agent-session.ts:1081-1101` 的规则）后继续比对：

| 步骤 | `rules` | `tools` | 说明 |
|---|---|---|---|
| 只给 `cwd` | 146 | 124 | 基线 |
| 加 `selectedTools`（= 会话 `toolsAdded` 的名字表） | 146 | 124 | **无变化**：工具名单不是这两段的来源 |
| 再加 `toolSnippets` / `toolGuidelines`（从 `createCodingTools(cwd)` 读 `promptSnippet` / `promptGuidelines`） | 230 | 170 | 有变化，但会话实际是 **839 / 339** |

进一步核对：会话与调用方的**工具集合完全相同**（都是 `read, bash, edit, write`），但调用方能从 `createCodingTools(cwd)` 取到的 `promptSnippet`/`promptGuidelines` **只有 `bash` 一个**。

根因在源码里是明确的：会话的 snippet/guideline 表来自它自己的**定义注册表**（`agent-session.ts:2800-2814`，遍历 `_baseToolDefinitions` + custom tools 的 `ToolDefinition`），而不是来自公开的 `createCodingTools()` 返回值。两者不是同一批对象、也不带同样的 prompt 元数据。

**这就是 G-A 的确切残余**：builtin 工具的 prompt 元数据（`promptSnippet` / `promptGuidelines`）没有公开入口能让调用方按同样方式取得。上游请求因此可以写成一句很小的话：**请把 builtin 工具定义（含 prompt 元数据）或会话使用的 snippet/guideline 映射暴露出来**——而不是「请新增一个准备接口」。

至此 G-A 的三段证据齐了：提示投影是公开纯函数（3/5 sections 当场逐字节相等）→ 输入推导规则可在源码中读出（cwd / skills / contextFiles / customPrompt / appendSystemPrompt / selectedTools / toolSnippets / toolGuidelines）→ 其中只有一项（builtin 工具的 prompt 元数据）没有公开来源。

### `toolsAdded` 逐字节比对：全部可复现（G-A 证据链闭合）

派生的第二条 system 消息除了 `sections` 还带 `toolsAdded`（完整工具 schema）。用公开 `createCodingTools(cwd)` 的返回值与会话捕获的 `toolsAdded` 逐项比对**模型可见投影**（`name` / `description` / `parameters` / `constrainedSampling`）：

| 工具 | `description` 相等 | 字节 | `parameters` 相等 |
|---|---|---|---|
| `read` | **是** | 303 | **是** |
| `bash` | **是** | 248 | **是** |
| `edit` | **是** | 326 | **是** |
| `write` | **是** | 127 | **是** |

4/4 全部相等。差异只出现在对象的**非模型可见字段**上：调用方对象额外带 `execute` / `label` / `executionMode` / `prepareArguments`（这些不进请求），会话的 `toolsAdded` 只保留模型可见子集。

**于是 G-A 的证据链完整闭合：**

1. 提示投影 `buildSystemPromptSections` / `getSystemMessageText` 是公开纯函数 —— 3/5 sections 当场逐字节相等；
2. 输入推导规则可在源码读出（`agent-session.ts:1081-1101`）；
3. `toolsAdded` 的模型可见 schema 4/4 逐字节可复现；
4. **唯一缺公开来源的输入只有一项**：builtin 工具的 `promptSnippet` / `promptGuidelines`（会话从自己的定义注册表取，公开工具工厂只给得出 `bash` 一个）。

因此 G-A 的上游请求定稿为一句话：**请暴露 builtin 工具定义（含 `promptSnippet` / `promptGuidelines`），或会话使用的 snippet/guideline 映射。** 不需要新增准备接口，也不需要改动消息模型。

## 9. G-B 量化（2026-09-19，上游 main 的请求构造）

G-B 原来只有存在性描述（「payload 不携带任何覆盖证明」）。用同一方法量化后，结论与 G-A 同形：**缺的不是能力，是一份契约**。

事实（`packages/ai/src/api/openai-completions.ts`）：

- 整个 provider 请求由**一个** `buildParams`（796–1002 行，207 行）产出；
- 对象字面量先给出 5 个键：`model, messages, stream, prompt_cache_key, prompt_cache_retention`；
- 函数体内再按条件赋值 **15 个**键：`chat_template_kwargs, enable_thinking, max_completion_tokens, max_tokens, priority, provider, providerOptions, reasoning_effort, store, stream_options, temperature, thinking, tool_choice, tool_stream, tools`；
- 每个键的出现与取值都由**显式输入**决定：`model`（含 `compat` 元数据）、`context`（sections + messages + tools）、`options`（`maxTokens / temperature / reasoningEffort / toolChoice / cacheRetention / sessionId` 等）。

也就是说：**顶层键集合是封闭且可枚举的（约 20 个，两个 `max_*_tokens` 互斥），每个键的取值类别都由显式输入决定。**

那么 G-B 真正缺的是什么：**没有任何已发布、带版本的契约把这份键集合与每个键的值类别说出来，也没有在遇到未分类键时 fail closed。** 让调用方在执行前自己维护这份清单，就是允许出现第二份语义权威——上游一旦新增一个键，本地清单会静默失准，而这正是 INV-06 要求「未知覆盖不得填经验比例」要防的事。

**G-B 请求因此同样缩小为一句话**：请把 provider 请求的形状契约（键集合 + 每键值类别，随 adapter 版本发布）公开，并在无法分类的键上 fail closed。这不要求新增认证子系统，也不要求 BYOK 认识任何 Pi 之外的语义。

三条缺口的形态至此统一：

| 缺口 | 原表述 | 量化后的表述 |
|---|---|---|
| G-A | 没有纯编译入口 | 暴露 builtin 工具的 prompt 元数据（其余部分已可逐字节复现） |
| G-B | payload 无覆盖证明 | 公开请求形状契约（键集合 + 值类别）并对未知键 fail closed |
| G-C | 无法导入 host 断言历史 | 需上游在三种形状中选一（A 实测 146 处代价） |

## 10. 基线重估（同日只读核对 `main`）：固定候选可能已经过时

写完 §1–§6 之后又做了一次只读核对，结果推翻了「把 `0.85.1` 当作接口工作对象」这个前提，必须显式记录。

`main` 在 `0.85.1`（2026-09-05 发布）之后重构了本文 G-A 所依赖的**同一块子系统**：

| 位置 | `main` 的现状 |
|---|---|
| `packages/ai/src/types.ts:484-500` | `SystemMessage` 成为**可回放的转录消息**：`content` + `sections`（具名提示分节，后续消息按名替换、`null` 删除）+ `toolsAdded`/`toolsRemoved`。文档原文：把每条 system 消息按序回放即可得到当前提示与工具集 |
| `packages/ai/src/types.ts:546` | `Message = SystemMessage \| UserMessage \| AssistantMessage \| ToolResultMessage` |
| `packages/coding-agent/src/core/system-prompt.ts:54/121/186/195/204` | 新增 `normalizeBuildSystemPromptOptions`、`buildSystemPromptSections`、`buildSystemPromptState`、`diffSystemPromptSections`；`buildSystemPrompt` 变成 `getSystemMessageText({role:"system", ...state})` |
| `system-prompt.ts`（`forceSystemPrompt`） | 允许直接给定系统提示内容 |

也就是说：G-A 里「系统提示与会话状态耦合、调用方无法复现」这一条，**`main` 已经在往可显式化、可回放、可 diff 的方向走**，只是还没有把「首请求纯编译」作为公开入口暴露出来。

仍然缺失（`main` 上同样没有）：

- G-B：`main` 上搜不到任何 prepared/preparation 模块，也没有 residual/覆盖证明这类概念；
- G-C：`Message` 联合里没有 host 断言文本，`AssistantMessage` 仍要求 `api`/`provider`/`model`/`usage`；
- `CreateAgentSessionOptions` 仍不暴露 fetch、也不接受调用方给定的首个 system 消息。

发布面事实：npm `dist-tags.latest` 仍是 **0.85.1**，registry `time.modified` 仍是 2026-09-05——**`main` 尚未发布**。

### 结论与需要 owner 裁决的分叉

对 `0.85.1` 提「请加纯编译入口」有实际风险：这正是 `main` 已经在重塑的子系统，针对旧形状提的接口很可能被要求按新形状重写。两条互斥路径：

1. **等下一个官方发行版**（推荐）：把迁移目标从 `0.85.1` 重钉到「包含分节 `SystemMessage` 的下一个正式发行版」，届时用 `node packages/client/probes/pi-official/run.mjs --official-version <x.y.z>` 一条命令重跑全部 7 项，按新结果重写 OP2-U 请求（G-A 可能只剩「暴露首请求编译入口」一小步）。
2. **继续按 `0.85.1` 提接口**：需要同时论证「为什么要求上游在即将被替换的形状上新增接口」，否则请求本身不成立。

两种情况下当前判断不变：**prepared 生产路径保持禁用，`official_supported` 不得声明**。差别只在 OP2-U 的请求文本与目标版本，以及后续 OP2/OP3 的实现面。

机器可执行的重估入口（下一刀的第一步）：

```bash
npm view @earendil-works/pi-coding-agent dist-tags --json   # 是否已出现新版本
node packages/client/probes/pi-official/run.mjs --official-version <new>   # 按新版本重跑 7 项
```

## 11. 未决

- 上游是否接受该请求、以什么形态接受、何时进入受支持发行包，均不由本仓决定。
- 目标版本分叉（重钉到含分节 `SystemMessage` 的下一发行版 vs 维持 `0.85.1`）待 owner 裁决。
- G-C 的形状（A 新联合成员 / B 放宽 provenance 字段 / C 显式导入入口）待上游选择。
- G-A 的逐字节比对（调用方重建 vs 会话实际发送）尚未跑完。
- 本文只覆盖 `openai-completions` 一条路径；WebSocket 与其他 API 按方案保持不支持，未做验证。
- 递归/子进程模式下上述结论是否一致（`registerProvider` 在 print/runner 中的可用性）属 OP4 范围，本轮未验证。
