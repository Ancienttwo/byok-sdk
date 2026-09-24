# OP0 — Opus 轨（deep-reasoner）结论摘录

RECOMMENDATION：现在就停掉 fork，P0 的 prepared lane 直接建在官方 0.87.1 上。做法是：用官方 serializer 做编译，用 `context_with_system` 注入 Host 历史，用 `registerProvider` + `fetch` 做最终字节门。前提是 Owner 先批准两条变通：A1 用 capture-fetch 编译，A2 用请求内哨兵 provenance。U1、U2 两个上游 PR 同时提交，不等它们合入。confidence: MEDIUM。

探针脚本：`/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/8e9c9aad-8e8c-4320-aa5b-cfa7610ef38b/scratchpad/op0/probe.mjs`、`probe2.mjs`、`probe3.mjs`。全部离线运行，provider 响应是 synthetic SSE，HOME 和 agentDir 都是临时目录。

## 官方包
- `@earendil-works/pi-coding-agent@0.87.1`、pi-ai、agent-core 三个包的 gitHead 都是 `f07218c4`，等于 tag v0.87.1，并带 SLSA provenance。
- coding-agent 的公开 exports 只有 `.`、`./rpc-entry`、`./client`、`./experimental/plugin`；pi-ai 公开了 `./api/*`、`./utils/*`、`./compat`。
- fork 相对 v0.86.1（13cbf77d）多出 21 个 commit，改动 136 个文件，+13586/−278。

## 能力表
1. **Task-free 编译 D — B。**
   - 官方 serializer 可以离线产出 D，两次结果一致（674 B，sha256 `7feb66e4…`），与 AgentSession 实际发出的字节相同。
   - 缺口：`buildParams` 没有导出，只能靠占位 apiKey 加一个会抛错的 capture fetch 拿到 D（`openai-completions.js:34-40,181-188` 的调用顺序是 key → createClient(fetch) → buildParams → onPayload）。这正是迁移方案 §7.1 所说的"不等于生产 pure prepare"。
   - `buildSystemPrompt` 不在 index.d.ts 里，只能读已构造 session 的 `session.systemPrompt`。
2. **授权历史注入 — B。**
   - `context_with_system` 可以把 Host transcript（含 system 和 toolsAdded）原样送出；native trigger 不会出现在请求里；tool 往返后第二个请求仍保留 Host 前缀。
   - 缺口：官方 `Message` union 没有不带 provenance 的 assistant 类型（`pi-ai dist/types.d.ts:353-387`），Host 的 assistant 文本必须填哨兵 api/provider/model、零 usage、stopReason。这些字段不会上 wire：无论哨兵还是同模型 provenance，发出的字节都是 `{"role":"assistant","content":"..."}`（probe3 已验证）。
   - handler 抛错会 fail-open，照常发送（`runner.ts@v0.87.1:1240-1248`），所以必须由字节门兜底。
3. **最终请求消费 — A。**
   - 公开 API `registerProvider({streamSimple})` 加 `ProviderRequestOptions.fetch`。gate 比较的是 OpenAI SDK 序列化后的真实 body，比 fork 在 onPayload 上做对象比较更严。
   - D 一致时放行；D 漂移时 0 次新发送、1 次拒绝。
   - 上层看到的拒绝只是 "Connection error."，typed code 要在 gate 闭包里自行记录。
4. **Usage 观测 — A**（extension `message_end` 可拿到 input/output/totalTokens）。
5. **Tool 策略与注册 — A**（`tools` allowlist + extension `registerTool`）。opaque provider 默认不发 `strict`；fork 基于 0.86 会发 `tools[].strict`，所以 D 会变。
6. **Opaque BYOK provider 与 compat/thinkingLevelMap — A**，已在官方（`ModelRuntime.registerProvider`），z.ai 的 thinking 字段能正常发出。
7. **打包与身份 — A，有注意点。** 可以用 name + version + integrity + provenance + 已安装文件摘要做 attest。但官方 shrinkwrap 缺 5 个兄弟包（chord、agent-core、pi-ai、telemetry、tui）的 integrity，而且这些兄弟包依赖写的是 `^0.87.1` 区间，需要由 BYOK 钉死。

另外：`prepareRequest` 被 AgentSession 自己占用，SDK 用不上。对 `state.messages` 赋值在 0.87 已不影响请求，fork 在 `agent-session.ts:1419` 的注入点无法直接 rebase。

## 上游缺口
- **U1**：从 `api/openai-completions` 导出纯函数 request builder（fork `4748f2018`，约 105 行）。改动通用，很可能被接受。
- **U2**：root 导出 `buildSystemPrompt`，并把 docsPaths 改成显式参数（fork `edfa2216b`，+136 行）。很可能被接受。
- **U3**：给 `Message` union 加不带 provenance 的 assistant 类型（fork `8792344cf`，50 个文件 +577 行）。侵入大，能否被接受不确定。更务实的是 A2：哨兵只存在于请求内存中，不上 wire。

## 取舍
- 现在停 fork：7 项里没有 C；fork 在 0.87 上本来就要重新设计注入点；继续留在 fork，等于给要删的代码继续投钱，而且每动一次 pi-ai 都要全量重发加交互式 EOTP。
- 不选"P0 先上 fork 再迁"：ruling 和 C 要做两遍，fork 身份 gate 做完又要扔。
- 不选"等上游"：没有 C 级缺口。

## 风险
- capture 编译依赖非契约的调用顺序，上游重构可能打破它，但结果是 fail-closed（拒绝），不会发出未经 gate 的请求。应对：钉精确版本，加 conformance 测试。
- D 受 `PI_CACHE_RETENTION` 环境变量影响，需要固定。
- `retryProviderRequest` 可能重发，gate 必须保证 at-most-once。
- vendored pi-subagents 可能导致两份实例。
- 未测：Linux/Windows、真实 z.ai、print/runner/workflow、五条递归边、MCP pool、SDK typecheck。

## 改判条件
- Owner 否决 A1/A2。
- P0 在 fork 上已经完成，只差发布。
- SDK 在 0.87.1 上 typecheck 或测试大面积破坏，或 capture 编译在跨进程、跨平台下不确定。
