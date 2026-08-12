# Hermes Agent 与 block/buzz 功能萃取评估

> 2026-08-12。外部产品源码研究，评估哪些机制值得萃取进 byok-sdk。姊妹研究：[`raft-architecture-reference.md`](./raft-architecture-reference.md)（RAFT 静态拆解）。本文不是 byok-sdk 架构文档，不修改 `docs/architecture/` 的结论。

## 1. 方法与证据等级

两个仓库均为 2026-08-12 的 shallow clone，源码开放（MIT / 开源），全程只读源码，未执行任何被研究方二进制：

| 仓库 | 位置 | 研究产物 |
|---|---|---|
| NousResearch/hermes-agent（commit `a871948`） | `~/Projects/hermes-agent` | 该仓 `docs/architecture/`（本次生成的学习文档，含 file:line 引用） |
| block/buzz | `~/Projects/buzz` | 该仓 `docs/architecture/`（同上） |

证据等级沿用 RAFT reference 的约定：未标注即 `[verified]`（有 file:line 可覆核）；`[inferred]` 为推论；`[unverified]` 无法确认。与 RAFT 拆解不同，这两家是源码可读的，所以 `[verified]` 的覆核成本低得多——引用直接指向 clone 下的源文件。

byok-sdk 侧的对照基线：9 个 workspace 包（core/protocol/client/server/cloud/cloud-postgres/keys/testkit/conformance + umbrella），凭证隔离铁律（`@byok-sdk/keys` 不进 dispatch 依赖图；runtime CLI 凭证边界不可触碰，sprint non-goals 明确拒绝 generic `credentials.get`），capability-flag 增量协商模式（ADR-010，`approval_resolved`、`result-document` 先例），RuntimeAdapter 扩展点，device assertion broker（进行中）。

## 2. 两个产品与 byok-sdk 的可比面

- **Hermes Agent**：自改进单体 agent 运行时（Python）。它自己拥有 turn loop、工具注册表、记忆与技能。byok-sdk 不拥有 turn loop（runtime 属于 vendor CLI，经 RuntimeAdapter 适配），所以 hermes 里凡是钩在 turn loop 上的机制（技能自主创建、记忆 nudge、programmatic tool calling）都只能作设计参考，不能作萃取对象。**可萃取面在数据格式与分发管线**——这些是 runtime 无关的。
- **block/buzz**：agent-Slack（Rust + Nostr）。产品语义与 byok-sdk 的任务派发模型不同类（与 RAFT reference 第 2 节的判断同构），可比面在**身份/信任协议与并发纪律**——这些正好落在 byok-sdk 的 core/protocol/server 层。

## 3. Hermes：技能子系统（重点评估对象）

### 3.1 机制五层拆解

| 层 | 机制 | 关键证据 | 对 byok-sdk 的可移植性 |
|---|---|---|---|
| 格式 | `SKILL.md` YAML frontmatter + body，兼容 agentskills.io；hermes 私有字段收敛在 `metadata.hermes.*`；硬校验器（name 正则、desc ≤1024、100KB/1MiB 上限） | `tools/skill_manager_tool.py:566-620`, `:513-517` | **高**。纯数据格式，TS 侧只需 YAML frontmatter 解析 + 同套校验规则 |
| 生命周期 | 三层目录（bundled → hub 安装 → 用户本地）+ external_dirs；manifest 化单向同步保留用户自定义（`.bundled_manifest` content-hash 三路合并）；命名冲突标注而非静默覆盖 | `tools/skills_sync.py:1-160`, `agent/skill_utils.py:582-589` | **中**。分层 + hash 合并的模式可移植，路径/配置解析需 TS 重建 |
| 注入 | 无 embedding 匹配。渐进披露三级：系统提示只放 name + 60 字符 desc 索引 → `skill_view` 加载全文 → references 按需 | `agent/prompt_builder.py:1713-1852`, `SKILL_PROMPT_DESC_LIMIT` | **不适用**（注入属 vendor CLI runtime 职责），但模式值得记录 |
| 自主创建/自改进 | 每 10 轮触发后台 review fork；patch 优先于 create；保护名单 + 读后才能写 + 只归档不删除；**无版本历史**（仅 content-hash 与 `.archive/`） | `agent/background_review.py:182-305`, `tools/skill_manager_tool.py:60-95` | **不适用**（深耦合 turn loop）。版本历史缺口是我们如果做技能通道时要补的课 |
| 分发 | `SkillSource` ABC（9 个源：GitHub/ClawHub/URL/…）→ quarantine → 信任分级扫描（builtin/trusted/community/agent-created 四层 × verdict → allow/block/ask 决策矩阵）→ 安装 → content-hash `lock.json`（记 source/trust_level/scan_verdict/files）→ 审计日志；SSRF-safe fetch | `tools/skills_hub.py:482-502, 3678-3745, 3835-3886`, `tools/skills_guard.py:44-65, 787-826` | **高**。整条 fetch→quarantine→scan→install→lock 管线源无关，是教科书级的三方内容安装安全设计 |

### 3.2 萃取判断

**值得萃取的是「技能分发与管理」，不是「技能运行时」。** byok-sdk 的产品位置是 SaaS ↔ 本地 agent 的桥；下游（salesko 这类宿主）的真实诉求是把 SaaS 侧策划的指导内容（技能包）推到用户机器上的 coding agent 里。vendor CLI（Claude Code、Codex）各自已有技能加载机制——我们不需要注入层，需要的是：

1. **技能包 wire 格式**：agentskills.io 兼容的 manifest schema（zod 化进 `@byok-sdk/protocol` 或独立包），沿用 hermes 的校验规则（name 正则、尺寸上限）。
2. **安装管线**：quarantine 目录 → 静态扫描（hermes `skills_guard.py` 的 regex 扫描器是纯逻辑，可移植）→ 信任分级决策矩阵 → content-hash lockfile + 审计日志。这与我们已有的 R2 blob store、`checkResultDocument` 字节上限模式同构。
3. **能力协商**：作为新 capability flag（如 `skill-pack`）走 ADR-010 增量协商，旧 server 不声明则 daemon 明确拒绝，不静默降级——与 `result-document` 先例完全同构。

**安全红线（不可复制的部分）**：hermes plugin 的 `ctx.llm` facade（受信插件直接借用宿主的模型凭证，`hermes_cli/plugins.py:378-390`）正是我们 sprint non-goals 里明确拒绝的 generic `credentials.get` 形态。技能包通道只传**声明式内容**（Markdown/YAML），永远不引入代码执行或凭证代理语义。hermes 自己也把「skills = 声明式数据、plugins = 受信进程内代码、MCP = 进程外协议」分成三个信任层——我们只做第一层。

## 4. Hermes：其余机制速评

| 机制 | 证据 | 判断 |
|---|---|---|
| ProviderProfile 声明式注册表（auth_type 五分类：api_key/oauth_device_code/oauth_external/copilot/aws_sdk；刻意不拥有 client 构造与凭证轮换） | `providers/base.py:7-39` | **对照清单**。与 `@byok-sdk/keys` 的 `ModelProviderProfileSchema` 职责划分一致，用它的 auth_type 分类学核对我们的 schema 覆盖面即可，无需引入代码 |
| Programmatic tool calling RPC（LLM 写脚本经 UDS/文件轮询调工具，仅 stdout 回上下文；7 工具白名单 + shared-secret） | `tools/code_execution_tool.py:59, 512-712, 921` | **参考**。属 runtime 侧；若未来 Pi lane 做多步工具管线可回头看这份 spec |
| 子代理策略层（工具集与父交集、深度上限、leaf/orchestrator、父上下文隔离） | `tools/delegate_tool.py:700-739, 1380-1390` | **参考**。策略可独立于 Python runtime 移植，但我们不拥有 turn loop |
| BaseEnvironment 七后端抽象 + 休眠/快照（Daytona stop-resume、Modal fs snapshot） | `tools/environments/base.py:588-695`, `daytona.py:89-112` | **推迟**。远程执行面在 spec 之外；若日后做 remote runner，这是最干净的 1:1 TS 接口模板 |
| `build_session_key` 确定性会话键（platform/chat_type/thread 组合规则，纯函数） | `gateway/session.py:1090-1124` | **参考**。我们没有多平台消息面；若做会话连续性，这是现成 spec |
| Cron：确定性 DSL parser（NL 由 LLM 上游解决）+ fresh session + deliver-to-origin + respawn 防护 | `cron/jobs.py:612`, `cron/scheduler_provider.py`, `cron/lifecycle_guard.py` | **参考**，「LLM 解析 NL、工具层只收确定性 DSL」这个职责切分符合我们的 no-shadow-parser 原则 |
| MemoryProvider 窄 ABC（5 方法，强制单 provider 防 tool-schema 膨胀） | `agent/memory_provider.py`, `agent/memory_manager.py:364` | **参考**，留给未来 memory port 设计 |
| trajectory compressor / batch runner | 根目录 | **不相关**（Nous 内部训练数据管线） |

## 5. buzz：身份、信任与并发纪律

### 5.1 NIP-OA owner attestation ↔ 我们的 device assertion broker

buzz 的核心信任设计：agent 持**自己的**独立密钥，owner 密钥签发一个可复用的 capability（`auth` tag）授权 agent 以自己名义发布；带条件文法（`kind=<n>&created_at<t&...`）；吊销 owner 即连带吊销；agent 不是 owner 的委托代签（区别于 NIP-26），作者身份始终是 agent 自己（`docs/nips/NIP-OA.md`；`crates/buzz-sdk/src/nip_oa.rs:146,179`）。NIP-AA 再叠加「虚拟成员资格」：凭有效 attestation 在认证时继承 owner 的 membership，无需单独注册。relay 侧 enforcement 已核实存在：`crates/buzz-relay/src/api/mod.rs:60-111` `check_relay_membership()`，WS AUTH 路径 `handlers/auth.rs:216-241`，tag 从**已签名**的 AUTH event 提取而非 header，且 `allow_nip_oa_auth` 默认关闭（`config.rs:219,627,1140-1141`）。

**但条件文法是装饰性的**：`nip_oa.rs` 只有语法校验（`validate_conditions/validate_clause`）与签名验证，全仓 grep 无任何 `satisfies/check/evaluate_conditions` 调用点——`kind=<n>`/`created_at<t` 在通用路径上从未对 event 求值（唯一例外是 `handlers/identity_archive.rs:328` 自己做了局部时间窗检查）。这使 `NIP-AA.md:147` 的「有界授权窗口」论证落空。**这对 R2 是一条直接教训：条件文法必须与求值点同一 slice 交付，否则就是安全声明与实现脱节**——正是我们 no-compatibility-fallback 原则要防的那类「看起来受限、实际全通」状态。

这与我们进行中的 device assertion broker（sibling CLI 换取短时、audience-scoped、device key 签名的 assertion）是同一设计空间的两个点：

| 维度 | buzz NIP-OA | byok device assertion |
|---|---|---|
| 凭证寿命 | 可复用 capability（长期，条件限定） | 短时 assertion（一次性倾向） |
| 授权者 | owner 用户密钥 | daemon 的 device key |
| 权限表达 | 条件文法（kind、时间窗） | audience scoping |
| 吊销 | 吊销 owner 连带失效 | 短 TTL 自然过期 |

**萃取判断：评估性引入「capability 条件文法」到 assertion envelope。** 我们目前的 audience scoping 是单维的；NIP-OA 的 conditions grammar 展示了如何在不引入服务端状态的前提下做多维限权（操作类型 × 时间窗）。这是 `DeviceAssertionEnvelopeV1Schema` 的一个 additive-minor 候选扩展，不是必需——先记录，等下游出现「同一 assertion 需要区分操作权限」的真实诉求再动。

### 5.2 per-channel 单飞行队列（loop 防护）

buzz-acp 的 `EventQueue`：每 channel FIFO、**同一 channel 至多一个 prompt 在飞**、`mark_complete` 释放、in-flight deadline 兜底回收孤儿、`DedupMode::Drop` 丢弃在飞期间的重复触发（`crates/buzz-acp/src/queue.rs:230-410`）。外加 DM 硬化：即使 allowlist 模式，DM 也只对 owner + 密码学验证的同 owner sibling 开放，显式封掉 agent 发起 DM 的传递性访问漏洞（`lib.rs:192-258`）。

**萃取判断：这是 state machine 级的可移植模式，值得对照我们 server hub 的 `TASK_TRANSITIONS` 做一次差距分析。** 我们目前的任务状态机管单任务生命周期；「同一会话 scope 单飞行 + deadline 兜底」管的是**跨任务的调度纪律**。当下游出现多触发源（webhook、A2A mention）并发打向同一 daemon 会话时，没有这层就会出现放大循环。现在不实现——salesko 尚未提出 A2A 需求——但把该模式记入 todos 作为 deferred goal，触发条件是「第二个触发源接入同一会话 scope」。

### 5.3 其余速评

| 机制 | 证据 | 判断 |
|---|---|---|
| Provider wire contract：一次性 stdin/stdout JSON-RPC（Info/Deploy），部署后**零常驻控制通道**，控制流全部走 relay；PATH-only 二进制解析防注入 | `crates/buzz-backend-kubernetes/src/wire.rs:29-118`, `desktop/src-tauri/src/managed_agents/backend.rs:593-663` | **参考**。「durable 状态在 SaaS 侧、执行体可弃置、substrate 契约极窄」与我们 daemon 模型互为镜像；若做 remote runner 这是契约形状模板 |
| NIP-AE 加密可寻址 agent 记忆（HMAC 派生 d-tag 防 slug 泄漏、LWW head、tombstone、owner 恒可读） | `docs/nips/NIP-AE.md:47-133` | **参考**，冲突语义（event-sourcing + LWW）是可脱离 Nostr 的部分；关联 todos P5（keys↔TruthStore）之后的 memory 设计 |
| ACP/MCP「两根管子、两个协议、零 import 耦合」 | `VISION_AGENT.md:34-51` | **佐证**我们既有边界选择（协议契约而非共享进程 API），无行动项 |
| sprig 多调用二进制（argv0 分派多人格、单一小镜像） | `crates/sprig/src/main.rs:8-40` | **参考**，CLI 打包技巧 |
| 全量 scope 一次性授予 + rate limiting 定义但未 enforce | `ARCHITECTURE.md:369-390,823` | **反面教材**，不复制 |
| job dispatch kinds 43001-43006 | `crates/buzz-core/src/kind.rs:518-528`（仅 feed 过滤引用） | **未实现**，仅保留号段，无可借鉴的 claim 语义 |

## 6. 结论：萃取优先级

**做（有真实下游拉力，走正常 plan → contract 流程）：**

- **R1 技能包分发通道**（源自 hermes skills hub + guard）：agentskills.io 兼容 manifest schema + fetch→quarantine→scan→lock 安装管线 + content-hash lockfile/审计 + `skill-pack` capability flag。只传声明式内容，不触碰凭证边界。这直接延续 salesko upstream 方向（SaaS 侧内容资产推到本地 agent）。

**记录待触发（deferred，入 todos，写明触发条件）：**

- **R2 assertion 条件文法**（源自 buzz NIP-OA）：`DeviceAssertionEnvelopeV1` 的 additive-minor 扩展候选；触发条件 = 下游需要单 assertion 区分操作权限。
- **R3 会话级单飞行调度纪律**（源自 buzz EventQueue）：触发条件 = 第二个并发触发源接入同一会话 scope。

**只留参考，不排任务：** ProviderProfile auth_type 对照清单、BaseEnvironment/provider wire 的 remote-runner 契约模板、NIP-AE 记忆冲突语义、build_session_key、cron 职责切分、MemoryProvider ABC、sprig 打包。

**明确不做：** hermes plugin 进程内代码扩展与 `ctx.llm` 凭证 facade（违反凭证隔离铁律）；技能自主创建/自改进（耦合我们不拥有的 turn loop）；buzz 的 Nostr wire 与全量 scope 授予；trajectory/batch 训练管线。

## 7. 研究产物索引

- hermes 学习文档：`~/Projects/hermes-agent/docs/architecture/`（index + skills-system / gateway-and-sessions / execution-and-delegation / state-memory-providers）
- buzz 学习文档：`~/Projects/buzz/docs/architecture/`（index + agent-identity-and-trust / collaboration-and-loop-prevention / remote-agents-and-substrate / events-memory-moderation）
- 两仓均已 `repo-harness init --mode standard` 并建有 CodeGraph 索引，后续可直接 codegraph 查询覆核。
