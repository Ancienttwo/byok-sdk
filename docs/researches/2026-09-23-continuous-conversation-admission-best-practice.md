# 连续对话准入 best practice：精确预计数降级为可证明上界

日期：2026-09-23
状态：**Owner 已批准方向（2026-09-23，原话"批准"）**；C02 amendment 正文另行起草、冻结。

## 0. 背景

产品目标：把类 Grok bot 的连续对话基建做成 SDK，嵌入其他 SaaS 作为这类 Agent 的依赖。形态包括长期 1:1 bot 线程、记忆，以及后续的 routines 和 bot 间协作。推理跑在终端用户本地的 coding agent（Pi / Claude Code / Codex CLI）上，使用 BYOK 凭证；Host 持有会话状态，SDK 负责执行。

现行设计（C02 冻结契约 + C07）：
- 每个 Turn 都 fresh 执行，上下文是 Summary 加上未被覆盖的全部逻辑前缀，不静默截断。
- 派发前，设备编译出模型实际看到的完整请求，调 live provider tokenizer（z.ai `coding/paas/v4/tokenizer`）拿精确计数，生成 prepared receipt，Host 以 CAS 方式把它纳入准入。
- 只有拿到真实 provider 计数，`counter_authority_not_production` 这条 readiness 门才会放行。
- Summary writer 后置。

为了在真机上证明这一次 live 计数，验证链一路加长：sealed 装机、per-device grant ledger（防止自动重试烧掉 3 次额度）、mailbox 排空、receipt 读回，每一环都很脆弱。

## 1. 业界做法

| 系统 | 上下文组装 | 压缩触发 | token 预算 | 记忆作用域 |
|---|---|---|---|---|
| @grok on X | 每次 mention 单独执行；线程状态在 X 平台，bot 通过 X tools 按需拉取 [G1][G2] | 未公开 | 未公开 | 以线程为单位；Grok app 的 memory 是用户级抽取事实，可查看、可 forget [G3] |
| Meta Muse（2026-09-08 发布的个人 agent，底层模型 Muse Spark） | 对话入口是 WhatsApp / app；执行在每个用户独占的云 VM；凭证放在 agent 看不到的安全存储；出站经 Sentinel 审批 [M1] | Muse Spark 1.1 自行管理 1M 上下文并压缩 [M2] | 未公开 | 用户级 memory，可 forget [M1] |
| ChatGPT | 线程内全量历史 | 未公开 | 未公开 | saved memories + 按需检索的 chat history；支持 project-only 作用域 [C1] |
| Claude app | 线程内全量历史；搜索过往聊天以 tool call 形式呈现 | — | — | 分主题的 memory；每个 project 独立 [A1] |
| OpenAI Responses / Conversations | 持久化 conversation 或 `previous_response_id` [O2] | 服务端 token 数超过 `compact_threshold` 时触发，另有 `/responses/compact` [O1] | 服务端度量；`/responses/input_tokens` 可选 [O3]；超窗默认直接报 400 [O4] | conversation 级 |
| Anthropic API | 客户端每轮发送全部历史 | on-demand compaction（推荐）或 threshold 触发（默认 150k）[A2][A3] | `count_tokens` 免费但官方原文："The token count is an estimate" [A4] | memory tool 由应用自行映射作用域，建议与 compaction 配合使用 [A5] |
| Letta / MemGPT | core memory blocks + 消息 | sliding window 汇总旧消息；溢出报错也会触发汇总并重试 [L1][L2] | 溢出后事后处理 | agent 级 blocks + archival |
| Vercel AI SDK | SDK 本身不持久化 [V1] | 在 `prepareStep` 中由应用决定 | 按 `JSON.length/4` 估算 [V2] | 由 provider 决定 |
| LangGraph | checkpointer（thread）+ Store（跨 thread） [LG1] | 按比例阈值触发，默认保留最近 20 条 [LG2] | `count_tokens_approximately` [LG2] | thread / user |
| Pi（我们的 runtime） | session 内 | 超过 `contextWindow − 16384` 触发；溢出时压缩并重试一次 | 上一轮 provider usage + 之后新增内容按 chars/4 估算 | session |
| Codex CLI | session 内 | `model_auto_compact_token_limit` | provider 返回的 usage [K1] | session |

结论：
- 调研到的系统没有一个把"每轮向 provider 精确预计数"当准入硬门。通行做法有两类：服务端度量 + 超窗报错；或者上一轮 usage + 本地估算，再配合 overflow 处理。
- 长对话产品一律把 compaction 当一等能力。
- "精确计数"本身站不住：Anthropic 官方称其为 estimate；z.ai tokenizer 文档没有 coding 端点 [Z1]；计数路由与推理路由是否等价，我们自己也没证明（`docs/spec.md` counting 章节）。
- BYOK 下每个用户的 provider 和凭证都不同，Host 没有凭证，而且多数 provider 没有 tokenizer 接口（例如 DeepSeek 只提供离线 tokenizer，并明确以 usage 为准 [D1]）。如果启用条件是"provider 有 tokenizer 端点"，那么能支持哪些 provider 就被 tokenizer 的覆盖面卡死了。
- 静默溢出确实存在：pi-ai 维护者在注释里记录 z.ai 超窗不报错，需要用 `usage.input > contextWindow` 来检测（未经官方文档证实）。所以"不静默截断"这条不变量是对的，而且可以靠事后 usage 检测出来。

## 2. Owner 批准的方向

1. **准入改用可证明上界。** readiness 接受设备基于冻结 artifact 字节计算出的 `byte_bound`，作为生产证据。
   - 前提：byte-level BPE / byte-fallback 分词器中每个 token 至少覆盖 1 个字节，所以 token 数 ≤ 请求字节数 + Host 裁定的模板常量。
   - 这个上界不联网、不需要凭证、结果确定，出错时只会往安全方向偏。
   - `test_fixture` 保持"永远不算生产"。
2. **live provider 计数降为可选的收紧器**，用来提高可用容量和做校准，不再是启用门。
3. **事后校验**：`usage.input > bound` 说明上界失效，fail closed 并禁用该 target；`usage.input ≥ window` 或截断类 stop，这一轮不接受，报 typed `context_overflow`。
4. **首发限定纯文本**（多模态不适用字节上界）。线程满时显式进入"clear epoch"状态，fail closed，长期信息靠 MEMORY 延续。
5. **SummaryJob 提前到 1:1 首发后的第一刀**，排在 Routines 和协作之前。按阈值触发，不做每轮滚动，以保持前缀缓存稳定。后台执行，最近几轮保留原文。
6. **H5 真机链**（sealed install、grant ledger、live tokenizer 首呼）转为不阻塞首发的验证轨。H5-F grant ledger 保留，继续约束可选的 tokenizer 调用。

容量核算：glm-5.3-flash 窗口 1M、最大输出 128K [Z2]。1,048,576 − 131,072 = 917,504 字节的请求都在字节上界之内，折合约 23 万–30 万真实 token，按每轮 1–2KB 可以撑几百轮。首发时真正的约束是成本、延迟和长上下文下的质量，窗口不是瓶颈。

## 3. 权威划分

- **Host**：canonical transcript、epoch、不可变 Summary 工件、memory 的查看与 forget 策略、每个 target 的预算策略（窗口、输出预留、模板常量，通过 accounting ruling 表达）、准入决定、压缩调度。
- **SDK / 设备**：编译精确请求；计算上界（provider 计数可选，并标注计数方法）；采集事后 usage；输出 typed `context_overflow`；以 fresh result-document 方式执行 SummaryJob；管理 agent-home MEMORY。prepared lane 保持关闭 Pi 自动压缩，压缩权威在 Host。
- **Provider**：提供分词与计费真相（usage）和超窗报错。provider 原生 compaction 在 BYOK 下无法跨 provider 移植，只能作为某个 runtime 上的可选优化。

## 4. 未核实风险与改判条件

- GLM 分词器是否属于 byte-level、coding 端点是否注入隐藏 prompt：未核实，由事后校验兜底。
- z.ai coding 端点返回的 `usage.input` 是否可靠：未核实。第一刀要先用一次真实推理调用核实。
- 出现以下情况就改判：真实流量里 `usage.input` 持续高于上界加常量；拿不到可信的 usage；产品需要贴近窗口上限而 Summary 迟迟不能上线；Owner 因计费或合规必须事前拿到精确计数。

## Citations

- [G1] https://raw.githubusercontent.com/xai-org/grok-prompts/main/ask_grok_system_prompt.j2
- [G2] https://techcrunch.com/2025/03/07/x-now-lets-you-query-grok-by-mentioning-it-in-replies/
- [G3] https://finance.yahoo.com/news/xai-adds-memory-feature-grok-021115965.html
- [M1] https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- [M2] https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/
- [C1] https://help.openai.com/en/articles/8590148-memory-faq
- [A1] https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- [O1] https://developers.openai.com/api/docs/guides/compaction
- [O2] https://developers.openai.com/api/docs/guides/conversation-state
- [O3] https://developers.openai.com/api/docs/guides/token-counting
- [O4] https://github.com/vllm-project/vllm/issues/38132 （二手来源）
- [A2] https://platform.claude.com/docs/en/build-with-claude/compaction
- [A3] https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- [A4] https://platform.claude.com/docs/en/build-with-claude/token-counting
- [A5] https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- [L1] https://docs.letta.com/guides/core-concepts/messages/compaction/
- [L2] https://github.com/letta-ai/letta/issues/2541
- [V1] https://ai-sdk.dev/docs/agents/memory
- [V2] https://ai-sdk.dev/resources/recipes/guides/agent-context-compaction
- [LG1] https://docs.langchain.com/oss/python/langgraph/persistence
- [LG2] https://reference.langchain.com/python/langchain/agents/middleware/summarization/SummarizationMiddleware
- [K1] https://github.com/openai/codex/issues/16068
- [Z1] https://docs.z.ai/api-reference/tools/tokenizer
- [Z2] https://docs.z.ai/guides/vlm/glm-5.3-flash
- [D1] https://api-docs.deepseek.com/quick_start/token_usage/

## 5. 设计裁定（2026-09-23，dual-track 综合）

Opus（deep-reasoner）和 Codex 两轨独立作答，下面是综合后的裁定。两轨一致的部分直接采纳；有分歧的，逐条写明取舍理由。

**两轨一致**
- 上界证据由 SDK 从冻结的 D 内生计算，不接受 Host 注入的 bound counter adapter。adapter 可以报任意数字，而且会误扣 `maxCounterCallsPerScope`。
- 数值预算归 Host：窗口、模板常量 C、输出预留，以及最终的 fit 判定。SDK 的 accountingPolicyRef 继续只做 applicability 比对，不放第二套数值权威。
- live provider 计数改为可选；fixture 永远不能 ready。
- Salesko 只保留一条预算路径：`prepareContextPack` 的 budget 接真实 receipt，删除 Host 自造的计数（`countSerializedRequest` / `inputTokenUpperBound`）和 `fixtureBudgetMatches`。
- usage 取自 Pi 的原生 `message_end`（`adapters/pi/events.ts:112` 目前把它丢了）。

**分歧与裁定**
1. **上界的表示：采纳 Opus。** receipt wire 上已经有 `artifact.requestBytes`（`packages/protocol/src/input-preparation.ts:626-627`），它就是上界证据，不再新增 `byteBound` 字段，避免同一事实有两个载体。C 由 Host 通过 ruling 绑定 `toolManifestDigest`，覆盖工具前导段、tool schema 的渲染差和端点的隐藏 prompt。每条消息的模板 token 由 D 里该消息自身的 JSON 结构字节覆盖（按 GLM 公开模板推断，2–6 token 对 26–35 字节）。这个推断靠事后校验兜底。Codex 主张的逐项系数暂不采用；将来事后校验真的被证伪，再作为升级路径。
2. **readiness：采纳 Opus。**
   - 删除 `counter_missing` 和 counter 结果里的 `kind:'bound'`。
   - 有 counter 时照旧评估 `counter_authority_not_production` / `counter_coverage_incomplete`：fixture counter 在场就不能 ready。
   - 成功终态 `counted` 改名为 `prepared`，`not_counted` 改名为 `not_prepared`。
   - 首发要求 D 是纯文本；出现非文本内容给出 typed reason，不能 ready。
   - record/wire 一次切换版本，旧 record fail closed，不做双读。
3. **事后校验只比首次调用：采纳 Opus，Codex 的"每次调用都比上界"不成立。** 一个 prepared turn 会发多次 provider 调用，只有第一次调用的请求是 D，之后的 tool 续调走普通路径。另外，Pi 的 `usage.input` 已经减去了 cacheRead/cacheWrite，所以口径必须是 `input + cacheRead + cacheWrite`，否则前缀缓存一命中就永远触发不了校验。终态新增 prepared 专用观测 `{requestDigest, initialPromptTokens, maxPromptTokens}`。之所以不复用 `TerminalInferenceUsage`：spec 规定它只是 telemetry，不承担 task-state 权威。
4. **谁判定上界被证伪：采纳 Opus。** Host 判 `initialPromptTokens > requestBytes + C`：这一轮不接受，对应的 ruling revision 标记为 falsified 并持久化，所有并发 admission 都检查这个状态；要恢复只能重出 ruling。Codex 提出的设备端 quarantine 不采用，因为被证伪的是 Host 的 ruling，由 Host 持有这个状态才是唯一权威。
5. **`context_overflow`：采纳 Opus。** SDK adapter 做纯数值判定：任一调用的 prompt ≥ D 里的 `model.contextWindow` 即判 overflow；缺 usage 报 `usage_unavailable`，fail closed。不复用上游 `isContextOverflow`：它是一张正则表，带 generic fallback 和 0.99 启发式。
6. **Host fit 判定**：lane 读回 ready 之后只算一次 `requestBytes + C + max_tokens ≤ window`，超限写现有的 `preparation_context_too_large`。
7. **顺序：取两轨折中。** SDK 的代码不依赖 C 的具体数值，所以探针和 SDK WP 并行进行。C02 amendment 冻结需要 C 的实测值，所以必须排在探针之后。Host WP 排在 SDK 发版之后。
   - 探针内容：1–3 次普通推理（不走 tokenizer）。发裸 "hi" 请求得到 C 的底数；发一次带 Salesko 工具集的 prepared 形状请求，确认流式 usage 是否返回，以及 prompt_tokens ≤ requestBytes 是否成立；重复发一次，看 cached token 的口径。
   - 另外离线读 GLM 开源 tokenizer.json，确认是 ByteLevel BPE 且 normalizer 为 null。

**Trace 纠错（Opus）**：0078 表里 readiness_reasons、counted_tokens、counter_authority、receipt_ref 属于 mutable 段（0078:44），write-once 触发器只约束 request 段。
