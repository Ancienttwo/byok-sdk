# OP0 — Fable 轨（第三轨，独立复核）

日期：2026-09-24。只读；未改仓库、未调 provider、未提 PR。所有行号均按 `/Users/kito/Projects/pi-wt-086` 中 tag `v0.87.1` 的源码核对，SDK 行号按 `/Users/kito/Projects/byok-sdk-wt-release-0.20.0-closeout`（tip b9fa0d8e）。

## RECOMMENDATION

**fork 从现在起冻结，但 P0 不搬家：P0（用户 Turn 走 `task.offer_prepared` + egress，SDK 0.21.0）留在已发布、已过 gate 的 fork 0.86.1001 上发版；官方迁移作为紧随其后的独立 work-package 在 0.87.1 上立刻开工，不等上游；A1/A2 以收窄后的 amendment 交 Owner 显式批准，同时提交 U1。**

- confidence HIGH：不要把 runtime 替换捆进 P0。
- confidence MEDIUM：A1/A2 收窄后可以批，fork 退役不需要等上游。

"停 fork"拆成两件事：停止开发/发版可以今天做（P0 应当零 fork 改动）；退出活动依赖要等迁移 WP 过 G3/G4。两轨都把这两件事当成一件。

## 我核实的事实

1. **A1 的调用顺序与失败模式。** `openai-completions.ts:336-377`：`getClientApiKey` → `createClient(..., options.fetch)` → `buildParams` → `onPayload` → `retryProviderRequest(() => client.chat.completions.create(...))`。`fetch` 是公开的 `ProviderRequestOptions` 字段，不是私有对象。D 的 body 不含 baseUrl。因此只要 compile 时 `model.baseUrl` 是不可路由 sink（Opus 探针用 `127.0.0.1:9`），上游哪怕不再尊重注入的 fetch，结果也是 ECONNREFUSED → D 缺失 → 拒绝；不会有字节离开本机。**w2:pB 的"上游变化只会 fail-closed"成立，但前提是 sink baseUrl，这个前提必须写进 amendment。**
2. **A2 的 wire 中立性。** `api/transform-messages.ts:96-98` 的 `isSameModel` 只改变 thinking / toolCall 块的处理，text 块两种情况都原样返回；`convertMessages` 的 assistant 分支（`openai-completions.ts:1283` 起）只读 `content`，不读 api/provider/model/usage/stopReason。计量侧 `compaction.ts:174/177` 对 `calculateContextTokens(usage) === 0` 的 assistant 直接跳过。**文本型 Host 历史的哨兵字段既不上 wire 也不进 Pi 自己的上下文计量。** Codex 的负控（不填字段 → `Cannot read properties of undefined (reading 'totalTokens')`，0 次 fetch）与 Opus 的正控（填哨兵 → 字节与同模型 provenance 相同）互相印证，不矛盾。
3. **handler 抛错 fail-open。** `extensions/runner.ts:1221-1250`：`context_with_system` handler 异常被 catch 后只 `emitError`，请求照发。两轨一致：字节门必须是最终强制点，注入只是投影。
4. **两轨都没处理干净的门设计点：重试。** 拒发在上层表现为 "Connection error."，命中 `utils/retry.ts` 的 `connection.?error` 可重试模式；`AgentSession` 默认 `retry.enabled=true`、`maxRetries=3`（`settings-manager.ts:920/935`）；provider 层 `isRetryableProviderError` 对 `status===undefined` 也返回 true。prepared session 必须同时关掉 session 与 provider 两层 retry，并把 typed reason 先写进 run-scoped state 再抛（fork 的 assert-only consume 就是这么做的）。Codex 探针关了两层；Opus 探针只传了 `maxRetries: 0`。这一点对 fork 和官方同样成立，不是选边依据，但要进 amendment 的 required verification。
5. **fork 真实增量。** `v0.86.1..claude/pi-086` 21 个 commit，源码 ≈2.9k 行（coding-agent 1900、ai 941、agent 38），测试 ≈6.3k 行，其余是 lock 与发布工具。SDK 今天对 fork 的耦合只有三处 fork-only 子路径：`prepared-session-input`（`adapters/pi/input-preparation.ts:5,85,703`，动态 import）、`input-preparation`（同文件 :9，类型）、`rpc-types` 的 `RPC_MAX_FRAME_BYTES`（`daemon/input-preparation-service.ts:44`）；加上身份 gate 硬查 `byokFork`（`scripts/release/pi-runtime-identity.mjs:135`、`input-preparation.ts:269`）。
6. **两轨都漏掉的第三类缺口。** fork 里有与 prepared seam 无关的机械修复：RPC JSONL 帧上界（62cbbd87c / 511995810；上游 0.87.1 的 `modes/rpc/jsonl.ts` 没有任何字节上界，一个不带换行的 peer 帧可以把进程吃死）；`e05af044f` 导出的 rpc-types 是 SDK 正在 import 的。停 fork 之前这些要么上游化，要么 SDK 侧接管，否则是 INV-14 的静默降级。`365711677`（pi-ai 声明 MCP SDK 生产依赖）在 0.87.1 的 pi-ai src 里已经找不到 MCP import，大概率过时，迁移 WP 里核一下即可。
7. **P0 与 D 无关。** P0 改的是 `TaskOfferPreparedPayloadSchema`（加 egressPolicy/messageEgress）、`RequiredToolsetsSchema` 的 min(1)、Host 的派发路径（删 `freshPayload` handoff）。它不改 prepared 编译器、不改 D、不改身份 gate。Opus 说"P0 在 fork 上做 = ruling 和 C 做两遍"，但 P0 本身不触发 ruling 重出；重出是迁移 WP 的成本，不管 P0 在哪儿做都要付一次。

## 为什么不把迁移捆进 P0

P0 是产品级堵点（线程约 12 轮卡住、任何非 answered Turn 都卡住）。Opus 方案实际把 OP1–OP5 全部前置到 0.21.0：A1/A2 的 Owner 批准、adapter 编译/消费重写、`context_with_system` 注入、`registerProvider` 门、身份 gate 从 `byokFork` 改成官方 exact artifact + 闭包、shrinkwrap 缺 5 个兄弟包 integrity 且依赖写的是 `^0.87.1` 区间、wire 版本轴再升一次、Host facts 再改一次、ruling C 因 D 变化（0.87 对 unknown OpenAI-compatible endpoint 不再发 `strict`，system 消息改由 Host 框架）重出。这些都是必要工作，但没有一项是 P0 的前置条件。把它们捆进去，P0 的交付日期就变成迁移 WP 的交付日期。

反过来，P0 留在 fork 的边际成本接近零：0.86.1001 已发布、已过 gate、SDK 0.20.0 已 pin。条件只有一条：**P0 需要零 fork 改动**。如果 P0 途中发现必须改 fork，那一块就直接在官方线上做，不给冻结线开口子。

## 两条变通怎么裁

未入库方案 §0、§7.1、P02、§18 的字面确实同时禁止 A1（"给假 apiKey 的实验不等于生产 pure prepare/consume API"）和 A2（"不得编造历史 usage / provenance"）。Codex 按字面读，Opus 按目的读。我的裁法：按目的读，但不是原样批，而是收窄成两条可测试的规则，作为该方案的 amendment 由 Owner 显式批准：

- **A1' —— serializer + sink transport。** 编译 = 调用官方 `streamSimple` 公开入口，`model.baseUrl` 必须是不可路由 sink，`fetch` 必须是只捕获、必抛的闭包，`maxRetries: 0`，捕获点是 OpenAI SDK 序列化后的最终 body 字符串。它满足 INV-03 的实质（无网络、无认证依赖、无 session 副作用），不满足"纯函数"的字面。**它是过渡，不是终态：U1（导出 `buildRequestPayload`）照常提交，合入后换掉 A1'，不长期双轨。**
- **A2' —— 请求内类型占位。** 哨兵 provenance 只允许出现在 compile 输入与 `context_with_system` 返回值里；不得写入任何持久化 session、receipt、日志或 RPC 读回；conformance 测试必须证明"哨兵 vs 同模型 provenance"字节相同，且只允许 text 块（thinking / toolCall 的 Host 历史一律拒绝，因为 `isSameModel` 会改它们的处理）。这样"伪造"退化为满足外部类型约束的内存占位，与方案禁止的"上 wire / 进计量 / 进 receipt 的假元数据"是两回事。U3 太侵入，不作为前置。

Owner 否决任一条 → 回到 Codex 结论（迁移停在缺口处等上游）。但即便如此，P0 的路径也不变。

## 两轨各自错在哪

**Opus 轨**
- 把迁移与 P0 捆绑，低估 OP5 闭包、身份 gate 重写、wire/facts/ruling 的总量；"做两遍"的成本主要来自迁移本身，与 P0 在哪儿做无关。
- U2（导出 `buildSystemPrompt` + docsPaths）在自己探针采用的"Host 拥有整条 system 消息、`context_with_system` 整体替换"设计下根本不需要；不该列为上游前置。
- 漏了 RPC 帧上界这类 SDK 正在 import 的机械项。
- 门的 retry 只关了 provider 层，session 层默认 3 次会重复驱动整条 context 管线。
- 编译时 sink baseUrl 是安全前提，探针这么做了但结论没有把它写成规则。

**Codex 轨**
- 第 1 项判 C 是把"没有同名纯函数 export"当成"能力不存在"；它自己第 3 项已证明最终字节可控、拒发零发送，能力实际是 B（可用、非终态）。
- "上游补接口前迁移停在缺口处"把退役时点交给上游，而 sink-transport 编译的失败模式是 fail-closed，不构成阻断理由；这与 Owner 的偏好方向相反。
- 对 A2 的拒绝没有区分"上 wire / 持久化的伪造"和"内存内类型占位"，但它给出的负控是有价值的（证明字段缺失时 0 fetch、fail-closed）。
- usage 缺失全零成功的观察正确，但 fork 在同一 kernel 上同样如此，SDK 已把零 prompt 判 `usage_unavailable`，不是选边依据。
- 同样漏了 RPC 帧上界。

## 10x 时先坏什么

- 迁移线：sink 编译每次实例化一个 OpenAI client，成本可忽略；先坏的是 conformance golden 的维护——每次升官方版本都要重跑"sink-compile D == live gate body"（含 tool-result 第二轮）。这正是不能长期留在 A1' 的原因。
- fork 线（若不冻结）：每动一次 pi-ai 就全量重发 + 交互式 EOTP，且 0.87 已经打掉 `state.messages` 注入点，fork 每次 rebase 都是重做 seam。冻结在 0.86.1001 是唯一不烧钱的姿势。

## Required verification（进迁移 WP 的 amendment）

1. 同一 Host transcript：sink-compile D 与 live 门捕获 body 逐字节相等，覆盖首轮与 tool-result 第二轮。
2. 哨兵 wire-neutral 负控：哨兵 vs 同模型 provenance 字节相同；含 thinking 块的 Host assistant 被 admission 拒绝。
3. retry 负控：D 漂移时 injected fetch 调用次数恰为 1，`prompt()` 返回后 run-scoped state 里有 typed reason。
4. 上游不尊重注入 fetch 的模拟：编译走全局 fetch 到 sink → 0 次真实发送、编译报错。
5. 停 fork 清单：`RPC_MAX_FRAME_BYTES` 的替代（上游 PR 或 SDK 侧 reader）、身份 gate 改为官方 exact artifact + 闭包、shrinkwrap 兄弟包 integrity 钉死。
6. P0 的 fork 改动数 = 0（gate 检查 pin 字符串不变）。

## Confidence

- HIGH：P0 留 fork 0.86.1001 发 0.21.0，fork 同时冻结。
- MEDIUM：A1'/A2' 收窄后可批、迁移不等上游。取决于 Owner 是否接受"按目的读"这两条规则；否决则退回 Codex 结论，但 P0 路径不变。
