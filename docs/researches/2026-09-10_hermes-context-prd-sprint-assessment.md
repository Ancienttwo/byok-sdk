# Hermes context 机制对 Fresh MVP 的萃取评估

日期：2026-09-10。结论为建议，未修改 PRD、canonical Sprint、产品代码或任务状态；不构成实现或运行验收。

## 输入与证据

- [研究时 PRD 输入快照](./2026-09-09_conversation-turn-fresh-mvp-prd.md)：SHA-256 `ce4d3a1abd90d4857da761177255c1476c8741687559fa4e1530917200706fe5`。
- [研究时 Salesko canonical Sprint 输入快照](../../../salesko-new/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md)：SHA-256 `35673bc5210100bcc24929e7d531d30b17083aab4823b5ef0322e9c9d7cee716`。它是唯一任务状态账本；本报告不建立第二账本。
- Hermes 本地基线 `a871948d8d4b0f774d4ec40467bab1078a9f28d5`，源码只读检查；不是最新上游研究，也不是模型行为实测。
- [既有 Hermes 研究](./2026-08-12_hermes-buzz-extraction-assessment.md)已区分 runtime 所有权与可复用模式。

## P1 / P2 / P3

**P1：**Host 拥有 Turn、accepted 正文、Summary 与冻结 instruction；BYOK 拥有执行、结果传输及 home admission；native runtime 拥有模型请求组装与 working memory。不能从 Hermes 单体 runtime 的实现推导 SDK 需要拥有压缩、todo 或后台记忆 writer。

**P2：**按 PRD §9 追踪目标链：已结算 Turn 因果前缀 → 冻结旧 Summary/新增历史及内部 job → 普通 BYOK task/result-document → 输出验证与来源/覆盖 CAS → 有效 Summary + 全部未覆盖历史 + 本轮输入 → 实际 instruction 字节冻结 → fresh 执行。当前文档明确这条内部路径仍受 G4 核验约束；此处是契约 trace，不宣称运行实现通过。压力点在摘要生成前后的内容边界和两种模型的独立输入预算。

**P3：**维持单一 transcript authority、完整覆盖与 B1-A。最小优化是补 S0/S5 现有验收，不新增 Sprint、ContextEngine 插件或长期记忆后端。十倍历史量首先放大重复输入、Summary lag 和小摘要窗口耗尽；缓存不能解决容量上限，增加并发也不能解决同 home 依赖。

## 建议纳入的有界修订

| 修订 | 落点 | 应新增的验收 |
|---|---|---|
| 版本化结构化 Summary，明确历史数据语气 | PRD §9.4；S0-09 / G4；S5-02、07 | 模板冻结；区分目标、约束、历史决策及其撤销、已接受回答、未决事项、指代/实体和关键引用。缺段是结构错误；关键约束保留、撤销不复活、指代正确是独立质量验收。多次更新需验证信息漂移。 |
| 摘要持久化与重注入的信任边界 | PRD §9.2、9.4；S5-02、05、07 | 原 transcript 不变；明确允许的脱敏类型、投影规则版本与原始来源关联。测试合成 credential 不进入提交的摘要，历史文本不获新执行权限；不以 regex 删除自然语言“指令”并声称语义未变。 |
| 主执行与摘要执行分别做预算预检 | PRD §9.3；S0-05、09；S5-02、05、06 | 分别登记目标模型窗口、输出预留、实际 runtime 固定开销、token 计量来源、Summary 与新增正文上限；每个实际 job 在模型投递前校验完整输入。unknown 不冒充足够，超限显式失败，不临时换模型或丢正文。 |
| 稳定序列化与可观测缓存收益 | PRD §9.1、12；S5-04；S9-04 | Host 稳定 framing 在前，Summary 版本不变时保持相同字节，随后为连续历史和当前输入；保持同 Execution 恢复字节不变。实际 runtime/provider 缓存命中需独立观察，无法观察就不承诺收益。 |

模板不必照抄 Hermes 十段。特别是 `Completed Actions`：当前 Host transcript 只证明用户文本与已接受回答，不能把“模型说发了邮件”提升为邮件已发送的外部事实。摘要应保留来源语气；Host generation、取消和队列资格仍从结构化事实取值，不能由摘要文字反推。没有权威 todo 数据时，不另建一个从摘要提取的计划 store。

## 对原五条建议的必要修正

1. **模板引用有误差。** Hermes `agent/context_compressor.py:3773–3817` 是 deterministic fallback 模板，包括 `Last Dropped Turns`；正常 LLM 模板在 `4084` 起，包含额外的历史任务和 pruned-skills 要求。`4048` 起是 summarizer preamble，`4140` 起进入 previous-summary 增量更新分支。值得借鉴的是结构与历史语气，不是固定复制那十个标题，也不是复制失败时的本地摘要 fallback。
2. **UPDATE 不等于原地持久化。** 上一版 Summary + 新覆盖原文可作为新输出的输入；Host 仍应产生新版本并经现有 CAS 提交。旧字节与来源可追溯要求不变，也不承诺 LLM 只修改增量部分。
3. **脱敏与任意指令剥离不是同一件事。** Hermes `826–850` 的 `MEDIA:` 过滤对应其具体附件协议，`force=True` 对应 credential redactor。Salesko 不能据此删除代码示例或用户约束；只对已定义协议控制字段做校验/拒绝或明确授权的投影转换。历史数据 framing 与少量对抗样例也不等于彻底解决 prompt injection。
4. **不要照抄百分比。** Hermes `800–820` 的 75% 下限和 10% middle skip 有自身条件，后者还依赖此前低收益观察，并使用 deterministic dropping。Fresh MVP 禁止由此省略未覆盖原文。token 预算和 UTF-8/JSON bytes 必须分别满足。
5. **缓存不是零成本保证。** Host 只能冻结自己的 instruction；SDK guidance、tool schemas、Agent home 与 native runtime 的实际请求仍影响 prefix。不能为缓存而推迟必要的 Summary 更新或改变 working-memory 刷新语义。Hermes MEMORY 启动快照的机制，不直接证明 Salesko 每轮 fresh 命中缓存。
6. **辅助模型预检的调用时点须看调用链。** `conversation_compression.py:2281` 在首次实际 compression 时 lazy 调用 feasibility check；模块说明的 startup probe 不能单独证明构造时已执行。Salesko 的配置预检与每个 job 投递前完整预算校验是建议新增的要求，不能写成直接继承 Hermes 的验收。

后台 review 与 memory provider 保持本 Sprint 范围外。Hermes 普通 chat 的 review 按 cadence 触发，并非每轮必跑；外部源码中 Codex app-server 路径 `agent/codex_runtime.py:904` 的触发条件未检查 `skip_background_review`，这里只记录路径差异，不修复或扩展调查，不把“默认前四层开启”当成跨 runtime 保证。

## 预算充分性与失败边界

用主模型 token 单位表示：完整输入 `F_main + S + H + U` 必须不超过 `W_main - O_main - M_main`；摘要模型独立满足 `F_summary + S_old + Delta` 不超过 `W_summary - O_summary - M_summary`。F 包括实际 framing、guidance/tool schema 等开销，O 是输出预留，M 是冻结余量。不同模型不能共用未经验证的 token 计数。UTF-8 instruction、完整 JSON 和 blob 限制另行校验。

固定开销不可观察时，这些不等式只是预算模型，不能作为实际容纳证明。启动配置预检也不替代每个 job 的输入预检。阈值须留出新增完整 Turn 的增长空间；极长单轮或底座本身超限时必须显式 blocked/rejected。低回收收益时，完整原文仍装得下才可延后摘要；否则阻塞。不能承诺任意长输入永远可继续。

## 最小验证样例

- 连续多次 Summary 更新后仍保留关键约束、否定、撤销与实体指代；历史待办不能因摘要重新获得执行授权。
- assistant 自述成功但缺外部证据时，摘要保留“助手报告”的来源，不升级为已证实操作。
- 含合成 credential 与合法 `MEDIA:` 代码示例：按冻结安全规则生成投影，源记录不变，不误删普通正文。
- 主模型装得下但摘要模型装不下；固定底座过大；一次长 Turn 越界；全部在模型投递前可见失败，无截断/换 provider。
- 旧 Summary 晚到、事实修订与重复提交继续复用现有 S5 CAS 验收；稳定字节与真实缓存指标分别报告。

本次只核验文档与指定源码，不跑产品测试或真实 provider。建议下一实施前置切片为 S0-05/S0-09 的双预算草表与 Summary 内容/安全契约候选，关闭 G3/G4 对 S5 的具体未决输入；本报告不把这些参数或政策记为已批准。
