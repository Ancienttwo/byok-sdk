# Plan: Official Pi Migration（退役 BYOK Pi fork，切换官方发行依赖）

> **Status**: Executing
> **Created**: 20260919-1603
> **Slug**: official-pi-migration
> **Artifact Level**: work-package
> **Planning Source**: owner 提供的执行方案 `plans/Official_Pi_Migration_Execution_Plan_2026-09-19.md`；本文件是其规范化、已注册的权威执行副本（main checkout 那份为历史输入，不是权威）
> **Promotion Reason**: owner_ruling_2026-09-19（终止自维护 Pi 发行线；OP0–OP8 责任包 + G1–G4 实质验收门）
> **Verification Boundary**: OP0 证据面（发行基线 + fork delta map）与 OP1 五项 probe；产品实现刀按各自 slice contract 独立验证
> **Rollback Surface**: 见文末 `## Rollback Surface`
> **Task Profile**: migration
> **Source Ref**: `byok-sdk@79f6a0d35952392c37652cb2f7fecaf6dcc255a6`（origin/main）；官方参考 `earendil-works/pi@36b60d2e…`（GitHub main，非 npm 产物）；Host 参考 Draft #241@`32cfcd49`
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260919-1603-official-pi-migration.contract.md`
> **Task Review**: `tasks/reviews/20260919-1603-official-pi-migration.review.md`
> **Implementation Notes**: `tasks/notes/20260919-1603-official-pi-migration.notes.md`

## Agentic Routing

- Selected route: main-agent 主导 + 只读 explorer 并行取证（fleet `explorer`，`fork_turns: none`）
- Routing reason: OP0/OP1 是跨仓证据面（npm registry + 本仓消费面 + 官方 tarball 公共接口），写入面小、研究面宽；按 AGENTS.md Research Delegation 拆只读研究，写入串行由 main agent 执有
- Due diligence:
  - P1 map: 见 `docs/researches/2026-09-19-official-pi-fork-delta-map.md`（OP0 产物）
  - P2 trace: 见 `docs/researches/2026-09-19-official-pi-fork-delta-map.md` §Trace
  - P3 decision rationale: 见 `docs/researches/2026-09-19-official-pi-fork-delta-map.md` §Decision

## Workflow Inventory

- Active plan: `plans/plan-20260919-1603-official-pi-migration.md`
- Sprint contract: `tasks/contracts/20260919-1603-official-pi-migration.contract.md`
- Sprint review: `tasks/reviews/20260919-1603-official-pi-migration.review.md`
- Implementation notes: `tasks/notes/20260919-1603-official-pi-migration.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260919-1603-official-pi-migration.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` 选择本 worktree 的活动计划；`.ai/harness/active-worktree` 记录归属 worktree。本 plan 执行于独立 worktree `byok-sdk-wt-official-pi`（branch `codex/official-pi-migration`，基线 `79f6a0d`），不接管 main checkout 的 recursive-s2 活动计划与用户 WIP。

# BYOK SDK：迁移至官方 Pi 的详细执行方案

日期：2026-09-19  
方案标识：`official-pi-migration-v1`  
目标：官方未修改的 Pi 发行依赖 + 现有 BYOK 小型适配层；终止自维护 Pi 发行线。  
状态：已由实施负责人注册（plan + contract 落位 `codex/official-pi-migration` worktree）；本文件是执行权威。方案本身不是实现完成、测试通过或生产启用证明。

## 0. 执行结论

采用一个目标架构：由 BYOK 管理自己使用的官方 Pi 安装，在受控子进程中通过公开 SDK 接口运行；继续维护 BYOK 的身份、工具桥接、预算、消息恢复与 custody。不另发 bridge npm 包，不改用户个人的全局 Pi，不长期提供 fork/official 两条可自由切换的产品线。

先证明替代接口，再开发适配，再切换产品。不直接替换根依赖，不用一轮普通聊天成功代替 prepared-input 与安全等价性证明。

真正的发布阻断项是：官方公开能力能否满足现行 task-free preparation、授权历史注入、计量、最终请求消费及装载约束。缺接口时，实施最小上游接口改进；不能用 private deep import、安装后 patch、复制 Pi serializer 或伪造历史元数据填补。上游修复尚未进入受支持官方发行包时，该能力保持不可启用，其他无依赖的迁移工作继续。

建议整项分为 OP0–OP8 九个责任包、四个实质验收门。小切片各自验证，最终同一组产物一次组合验收；不为每个文档更新重跑全仓。

## 1. 本轮事实基线与证据限制

| 对象 | 固定读取对象 | 本轮确认 | 不代表 |
|---|---|---|---|
| BYOK SDK | `main@79f6a0d35952392c37652cb2f7fecaf6dcc255a6` | client 仍通过 alias 使用 `@byok-sdk/pi-coding-agent@0.85.1006`、`@byok-sdk/pi-ai@0.85.1005`；已有 runner 和身份 gate | 该 SHA 全仓/发布/native 验收通过 |
| 官方 Pi | `earendil-works/pi@36b60d2e8985899743c4cf5bd5f8929832a3f05d` | 有公开 Session SDK、ResourceLoader、工具及 provider 层接口；当前 SessionOptions 不直接声明 `fetch` | GitHub main 等于 npm 已发布 tarball，或全部调用链已验证 |
| Salesko | Draft PR #241，head `32cfcd499c0acb92efd4868ebd683b8b2cfa9daf` | 候选包含 canonical/epoch、D2、H1/H2a 和安装权威；PR 仍说明本地候选依赖与 registry 依赖的差别 | 已合入 main 或已上线 |
| 当前输入契约 | `runtime-input-preparation-contract.md` | 要求执行前准备、无业务执行、真实计量、Host CAS、冻结请求消费 | 文首历史 checkpoint 是最新所有模块状态 |

本轮重新读取当前 refs、client/root manifests、runtime wrapper、release identity gate、输入契约、官方公开选项与 Host PR。没有安装官方替代包、运行新测试或调用真实模型。下文的工作包及通过条件均是待实施要求。

来源见文末 S1–S13。原始官方文档仅用来确认可探索的公开能力；最终支持版本必须由 OP0 绑定 npm 发行包及其实际 exports。

## 2. 目标、非目标与度量

### 2.1 必须交付

1. 新发布的活动运行依赖图中，`@byok-sdk/pi-*` 为零，包括直接依赖、传递依赖、alias、bundledDependencies 和最终 bundle 内嵌模块。
2. Pi 内核来自官方发行源，未被 patch；官方包版本与 integrity、官方包文件清单、实际构建产物身份均可追溯。
3. BYOK 仅保留必要适配：运行生命周期、显式配置、工具桥接、消息接出、身份与预算执行点。不得复制官方的模型循环、provider serializer 或 session 管理器。
4. 已有 Host/SDK 用户可见语义保持；不能以换依赖为由取消 D2、required-message、未知执行对账、custody 或完整历史要求。
5. 干净 checkout + 锁文件 + 不可变候选包可以复现 Host 集成；开发 symlink 不算交付。
6. 用户可看见官方 Pi 来源、版本、自有 bridge 版本、所启用的资源/工具与凭证使用边界。

“零 fork”只约束活动代码与依赖，不要求删除历史报告、旧锁文件证据、已发布历史包或恢复所需旧产物。所有第三方扩展仍需如实披露；退出 Pi fork 不等于仓库从此没有其他第三方/vendor 代码。

### 2.2 本阶段不做

不改 Bot/canonical Conversation/epoch 的产品模型；不增加 Routine、群聊或多 Bot inbox；不另建 scheduler；不增加 `pi-official` 与 `pi-fork` 两套长期用户模式；不恢复自动 resume/fresh fallback；不接入任意 PATH 上的 Pi；不新造通用 sandbox 平台；不修改用户 `~/.pi` 全局配置、认证文件或既有个人会话。

官方升级后遇到的非必要 TUI 功能差异不默认成为本阶段需求；但当前已承诺的 scripted workflow、递归、工具与发行形态不能被静默删除。

### 2.3 维护成本验收

冻结 OP0 基线并在 OP8 对比：自维护 Pi 包数量、fork-only 符号数量、复制的 serializer/agent-loop 文件数、fork gate 数量、自有适配代码改动量、安装包大小、冷启动与每轮 preparation/计数调用数。

不虚构延迟目标。先在同设备、同输入、同工具集合、同模型/transport 的可比条件下测量；阈值在数据出来后冻结。不能以删掉错误检测获取性能改善。

## 3. 不变语义与需要显式修订的机制

### 3.1 不得回退的不变量

| 编号 | 不变量 |
|---|---|
| INV-01 | Host 仍唯一拥有 transcript、输入、Turn、Execution 关联、接受/取消仲裁和 Summary 业务 |
| INV-02 | task-free preparation 不创建 Execution、task claim、业务工具 grant，不执行模型或业务工具 |
| INV-03 | 纯编译与外层发现/存储/计数分离；计数的必要认证和网络不在纯函数内 |
| INV-04 | Host 网络准备在 PG 锁外；短事务重验 source/epoch/head/model/policy 后才同时提交 Execution 与派发意图 |
| INV-05 | 同一 Execution 使用同一冻结输入与 runtime 身份；artifact 缺失/漂移不自动重建 |
| INV-06 | 预算包含实际 framing/history/tools/授权附加内容；未知覆盖不填经验比例、事后 usage 或假 token 数 |
| INV-07 | required chat 必须有精确 accepted 正文；Host commit、SDK disposition、设备终态、资源释放独立 |
| INV-08 | D2 的调用身份来自实际 task context 与 SDK 签名；Host 撤权 commit 后新调用拒绝 |
| INV-09 | unknown 先对账；传输重放不等于重新执行模型，不承诺模型/外部副作用 exactly-once |
| INV-10 | 原生 session 不是 Host transcript；Bot fresh 对话不借用户其他 session |
| INV-11 | 同 home 单写者、fanout、session 排他、permit、root/parent 绑定继续有效 |
| INV-12 | 递归 depth：`rpc→runner`、`rpc→print`、`print→runner`、`print→print` 各 1；`runner→print` 为 0 |
| INV-13 | credentials/nonce 不进入 argv、prompt、云端历史或诊断日志；授权 counter 的输入披露也有单独边界 |
| INV-14 | 已允许的功能不因去 fork 静默降级；不支持时显式报告 |

### 3.2 应当修订的实现要求

从新版本契约里移除“必须为 BYOK fork alias”“必须有 byokFork 标记”这类实现绑定，替换为：官方发行来源 + 精确依赖闭包 + 自有 adapter 身份 + 实际可验证 capability。

涉及 prepared 编译器实现、身份字段形状、能力版本、source bundle 布局时，通过新 revision/amendment 明确修改；旧 FROZEN 文件及 hash 保持不变。纯替换实现且语义相同，不制造一个新的产品模式或 API。

以下变化不能被当作普通 refactor：

- 把创建 Execution 前预算保证降为创建后的发送 gate。
- 把纯编译改成会加载任意 extension/运行 session side effect 的 CLI 探针。
- 把模型可见的取消/End 语义、省略历史等行为隐式改变。
- 把原 S2 单 bundle/装载限制换成新的多文件依赖布局，却仍沿用旧 PASS。
- 因上游 API 不支持而删除 scripted workflow 或既有平台能力。

默认不批准这些语义变化。必要时给出最小差异与失败用例，作为独立 amendment，而不是让所有工作回到总体架构评审。

## 4. 目标运行结构

Host 仍组装对话、准备预算并提交 Execution。BYOK daemon 使用既有 RuntimeAdapter 生命周期，启动一个 BYOK 控制的子进程。该子进程调用官方 Pi SDK；工具代理仍连接既有 MCP/D2/消息通路；运行结果回到原 outbox 与终态通路。

代码结构采用已有 `packages/client/src/bin/pi-*` 与 `adapters/pi/`，不是新增一整层通用 RuntimeHost 框架。新辅助文件只在确有独立生命周期时建立。

### 4.1 选择规则

- 首个验证目标沿用 `pi / zai / glm-5.3-flash`；本机 macOS arm64 是优先验收环境，不据此取消 Linux/Windows 既有支持。
- 首个完整计数支持面沿用受限文本/HTTP 路径；WebSocket、多模态及其他 provider 不继承此保证。
- Session 必须显式指定 model、settings、agentDir、session manager、ResourceLoader 和 tools；缺值拒绝，不触发默认模型或用户目录发现。
- 不自动读取全局/project 扩展。允许资源清单包含授权的 BYOK extensions/skills/notes 时按明确规则加载、计量；“禁默认发现”不等于删除合法私有记忆能力。
- 禁止在同一进程混载 fork 与官方 Pi 后用模块缓存巧合获得通过；对照实验使用独立安装和独立子进程。

### 4.2 信任层次

官方来源只解决来源可解释性，不证明隔离。确定加载闭包只解决代码身份/装载，不证明任意执行内容安全。D2 解决 Host 副作用授权，不限制一个拥有本机 shell 的进程能读什么。真正声称 OS 文件/网络隔离时必须提供进程外边界证据。

本阶段先按已有部署威胁模型保持保护，不引入新的云代理传输正文/凭证，也不将 local fetch wrapper 宣称为所有进程网络的沙箱。

## 5. 工作包与依赖总表

| 包 | 内容 | 负责人建议 | 前置 | 交付性质 |
|---|---|---|---|---|
| OP0 | 固定发行基线、fork 增量清单、契约/写范围登记 | SDK owner | 无 | 证据与实施输入 |
| OP1 | 官方替代的五项有界 probe | SDK adapter engineer | OP0 | 可行性 gate G1 |
| OP2 | 预算/prepared 接口替代；必要时最小上游改进 | SDK owner + upstream contributor | OP1 | 关键语义接口 |
| OP3 | 现有 runtime、工具、消息、凭证迁移 | SDK adapter engineer | OP1；准备路径依 OP2 | 产品实现 |
| OP4 | 五边递归、custody、workflow 等价接线 | custody engineer | OP1 + OP3 接口冻结 | 产品实现 |
| OP5 | 官方依赖、身份、安装与来源证明 | release engineer | OP0；最终闭包依 OP2–OP4 | 可分发候选 |
| OP6 | Host C07-H2b 与正式包消费 | Host engineer | OP2 + OP3 + OP5 候选 | 跨仓集成 |
| OP7 | 固定组合故障/平台/真实目标验收 | 独立 gatekeeper | OP4–OP6 | G3/G4 |
| OP8 | 准入切换、旧工作排空、fork 退役 | release/operator owner | OP7 + 操作授权 | 发布与运营 |

关闭依赖，不是全串行排期：OP5 的发行来源核对可与 OP1 并行；OP3 中不依赖 prepared 接口的功能、OP4 现有状态机回归与 OP6 的纯 schema fixture 可以先做。不能把未满足前提的产品启用混入并行工作。

## 6. OP0：固定基线与真实 fork 增量清单

### 6.1 操作

以本轮 SDK SHA 建独立 migration worktree。检查当前 active contract；如 stale，通过 repo-harness 正式 supersede/update，登记明确 allowed_paths。不在 plan 附录长期规避 research 路径 guard，不在主 checkout reset/stash/clean 用户 WIP。

从真实 fork 包元数据取得仓库、upstream base 和构建来源。清点 coding-agent、pi-ai、agent-core 及扩展的直接/间接依赖；不能只 grep 顶层 package.json。

固定一个官方正式发行候选：核对 npm 名称、版本、tarball integrity、发布仓库/commit 对应、实际 exports、engine 要求、完整传递依赖和安装脚本。GitHub main 的 manifest 不是已发布包证明。缺 provenance 要如实说明，不伪造 attestations。

### 6.2 fork-delta-map 必填列

`delta_id | upstream_base | changed_symbol/files | SDK consumers | reason | required behavior | official public substitute | remaining gap | evidence | owner`

类别仅四种：直接删除、迁入既有 BYOK 自有职责、官方公开接口替代、最小上游接口缺口。禁止出现“复制进 vendor 后算无 fork”。

重点定位：

- `packages/client/package.json`、根 manifests/overrides、`bun.lock`。
- `adapters/pi/input-preparation.ts`、`resolve-bin.ts`、runtime identity/binding。
- `bin/pi-prepared-host.ts`、`pi-rpc-host.ts`、`pi-session-runtime.ts`、print/runner helper。
- provider 编译、host-canonical assistant history、请求消费。
- export/clipboard/jiti/asset 调整与 agent-core 传递依赖。
- `scripts/release/pi-runtime-identity.mjs`、client adapter gate、sealed-host 构建及 metadata。

### 6.3 交付与通过条件

`official-pi-baseline.json`（仅工程证据，不自动成为产品配置）和一份 delta map。所有 fork-only 入口有消费者；官方安装隔离于当前根依赖；旧资料不改字节。OP0 不直接切换产品依赖，不执行实际模型。

建议 PR：`audit(pi): freeze official package baseline and classify fork deltas`。

## 7. OP1：五项有界 probe——必须先证明的替代能力

Probe 放在一个已登记的实验目录，使用真实官方 npm tarball、临时目录和独立子进程；默认只连接受控测试服务。先利用已有 preparation spike 和测试夹具，不从头造另一套测试平台。每个探针保留实际网络与工具调用计数，以及失败案例。

| Probe | 要证明什么 | 合格证据 |
|---|---|---|
| P01 Session/工具/回复 | 官方 public SDK 能显式创建 fresh Session、挂载 D2/消息代理、取消和 dispose | 官方 artifact 真正执行；实际 Host 消息代理往返；无默认模型/用户配置发现 |
| P02 历史投影 | Host canonical assistant 文本、无回复 input、Summary 标记、Unicode/CRLF 等可原样进入请求 | 实际模型请求内容/顺序相符；无伪造历史 usage、reasoning 或 provenance；不从 stdout 恢复 transcript |
| P03 task-free 准备 | 同一个官方 serializer 能在 Execution 前生成完整输入证据 | 无 task/claim/business grant/模型调用；纯阶段无 I/O；后续消费不走另一套复制 serializer |
| P04 发送强制点 | 公开注入路径覆盖最终 HTTP body，拒绝/超时/取消后不会发往模型 | 从 Session 到 provider 到 transport 的实际追踪；远端监听确认 0；不是只验证一个孤立 fetch 函数 |
| P05 装载/递归兼容 | 明确 ResourceLoader、现有 extension、print/runner/workflow 可在所需闭包内运行 | 子进程与实际资源访问证据；违禁装载负控能失败；保留功能未悄悄删掉 |

### 7.1 必须防止的误报

官方 `CreateAgentSessionOptions` 不直接声明 fetch；provider 层有 fetch 类型，并不能单凭这一点保证能注入高层会话。必须证明从受支持公共入口可达实际请求，不得 monkey-patch 私有对象、全局 fetch 或 Undici 来宣称正式支持。

`before_provider_request` 不能作为唯一预算门：顺序上的后续 handler 仍可改 payload，且读到的实现会捕获异常。抛错、提前退出进程、伪造 SSE、给假 apiKey 的实验，不等于生产 pure prepare/consume API。

probe 使用的假响应必须标 synthetic；禁止把空字符串凭证等 fixture 作为生产实现。正式 counter 可以按授权单独使用真实认证，但它不是模型 generation。

### 7.2 G1 裁定规则

- 全部必要公开能力有实证：推进 OP2/OP3。
- 基础执行可行，缺 pure compile/consume 或历史导入：推进 OP2-U 最小上游接口工作；OP3/OP4/OP5 的独立部分继续；相关生产路径保持禁用。
- 只能靠 private import、patch、复制 serializer、关闭预算/S2 才能通过：该技术路径拒绝，不构建第二个私有 Pi 分发方案。

probe 沿用已登记的有限修复轮数；同一缺口不反复写总方案。结束时输出可运行最小反例、精确缺失符号/行为、责任归属及下一补丁位置。没有实现证据时，不许写 `official_supported=true`。

建议 PR：`test(pi): verify official runtime substitution through public APIs`。

## 8. OP2：准备、计量与发送的严格替代

### 8.1 目标结构

沿用现有 SDK preparation service/store、receipt、pin、Host CAS 与 TaskRunner 消费入口。只替换 Pi-specific 编译/消费实现，不另建“官方 preparation service”。

保留三层独立证据：

1. 来源与编译：已授权 snapshot → 完整 request D → counter projection P(D)。
2. 计量：N + U + O <= W，且实际 target/serializer/tool surface 匹配。
3. 消费：Execution 已提交，并在最终发送点使用冻结 D；身份或内容漂移则拒绝。

### 8.2 OP2-U：最小上游改进包

若 OP1 证明官方缺少必要入口，只向上游提出通用能力，不要求 Pi 认识 tenant、Turn、BYOK receipt 或 custody。

候选接口职责（不是声称上游已有这些名字）：

- 无业务执行的 request preparation：显式消息/工具/模型/options → 稳定 payload + 序列化版本描述。
- 原会话/模型循环消费对应冻结首请求；校验不通过在 transport 前拒绝。
- 可传播拒绝的 final-send boundary 或受支持的 scoped transport 注入。
- 如有需要，明确导入 host-owned assistant text，且不要求虚构历史模型 usage/provenance。
- 仅当实际阻断相关入口时，补 public resource/export/lazy-native 初始化接口；不附带整套 BYOK 打包策略。

优先提交最小复现 + 公共入口测试 + 保持普通 CLI 行为的补丁。必须等进入可验证官方发行包才算新生产依赖；临时 fork、Git branch 或本地 modified package 只能作候选证据。

### 8.3 发送 gate 行为

通过已证实的 scoped public transport 接口，检查 method、精确授权 origin/endpoint、model/options、body bytes、artifact/policy 绑定、取消及请求序号。请求体先按实际最终形式获得，避免流读取后又序列化产生不同内容；不支持的流式 body/encoding 明确拒绝。

不要将只校验首请求的 guarantee 外推到后续 tool-result 调用。新 Execution 的每个模型调用各自有请求序号及合法预算证据；生成结果后的下一请求不能借用首轮 receipt。与现有契约的逐请求/首请求支持面对应，不借迁移偷偷扩大保证。

梳理原生/HTTP 客户端的自动 retry、redirect、compaction、catalog refresh。隐式重试不能绕过 gate；发生已发送但结果 unknown 时遵守当前恢复策略，不默认重复 generation。重定向不转发认证到未授权目的地；请求取消后不自动建立替代通道。WebSocket 等未验证 transport 保持不支持。

真正的 counter 请求与 generation 分开记录；receipt、日志只存必要身份/计数/hash，完整正文按现有受授权保留策略处理。不能把 provider auth headers/nonce 收进共享 artifact。

### 8.4 接受条件

同一输入分别经过 prepare/consume，在真实 transport 边界比较字节；改变一个工具 schema、模型、resource、profile revision 或 body 就失败。计数超时、未知 coverage、上界不成立、CAS 失败和 artifact 缺失均没有模型请求。对正常 MCP tools/list 的潜在启动副作用，要保持已批准的只读观察边界，不将其宣称纯函数。

接入类型后由源码/协议 owner 决定是否确需版本变更；不为了隐藏 break 复用旧 format version，不建立双 hash/双 parser 修复历史记录。

建议 PR：`refactor(pi): replace fork prepared-input seams with supported official interfaces`；依赖 OP2-U 时显式标注，不先承诺上游接受。

## 9. OP3：runtime、工具、消息与凭证适配

### 9.1 复用与修改面

优先复用 `pi-session-runtime.ts` 的 session/services 组合、`pi-rpc-host.ts` 的显式配置与启动绑定、`mcp-server-pool.ts`、`mcp-extension.ts`、现有消息与内存工具、TaskRunner/outbox。删掉 fork 专有入口，不复制其内部实现。

官方版型不匹配现有 imported public functions 时按 OP0 清单替代；不得自动 deep-import dist 内部模块。必要类型从官方 public exports 推导，候选临时类型最终删除。

### 9.2 资源与权限

loader 只返回批准的 extensions、tools、prompt/skill/context 资源。默认全局/项目资源、自动安装、自动网络刷新关闭；该限制通过实际读取/网络负控验证，不只设置一个 flag。

工具集合分两类：必须的 SDK reserved lanes，及 Host 已授权的业务工具。业务权限不足不能靠注入 message/memory grants 间接扩大；D2 assertion 来自 daemon 注入的 task context，而非模型给的 taskId。

首个对话 fixture 可以只用最小工具验证，但最终要还原既有支持策略。不能给模型 unrestricted bash 来替代未接好的安全工具通路。

### 9.3 消息与生命周期

显式消息工具路径、最终 assistant 文本路径分别覆盖。一旦 canonical message 已冻结，后续 final text 不成为第二条正文。进度、思考和 tool-result 不作为用户最终回复补写。

提前 accepted 后模型继续执行、后续失败、cancel 与 finalize 丢响应，都保留原 accepted 事实。dispose/close 未确认不提前释放 home lease；abort ACK 不等于原生进程已退出。

凭证继续由已有 keys/local authority 提供到最小需要的作用域；不复制用户全局 auth.json，不在 manifest 填凭证，不创建新的云 key 代理。上游 ModelRuntime 的默认认证/模型发现必须被显式输入替代；无法做到即返回具体缺口。

### 9.4 验收

空 HOME、恶意 global/project 配置、缺 model、错误工具 grant、旧 nonce、跨 Agent assertion、晚到文本、重复回复、取消风暴和重启恢复。官方 runtime 本身来自真正发行包，工具/服务器 fixture 可以受控，但不能将整个 runtime mock 掉。

建议 PR：`refactor(pi): run the official SDK through existing BYOK task and tool boundaries`。

## 10. OP4：递归、custody 与 scripted workflow

不重写预算/permit 状态机；官方 Pi 负责模型执行，BYOK 自有代码负责授权的子任务创建与 root/parent/lease。

每一条已支持边经过同一启动校验，且消费冻结官方 runtime/bridge/资源身份。`runner→print` 的零额外 depth 不表示免于 spawn 校验、permit 或工具准入。

必须覆盖：最后一个 fanout 名额竞争；同一 session 的跨进程双写；spawn 前失败的可证明回滚；spawn 后 unknown 不退款重试；父任务取消后禁止新 child；伪造 parent/sibling config；print→print 多层；清理期间原进程仍存活；正式上下文投影不重复扣 depth。

现有 scripted workflow 已决定保留，先在官方入口验证真实语义。若其实现只能通过违禁动态编译/装载才能成立，给出具体兼容差异及上游/适配替代，而不是跳过 workflow 测试换绿。不得把动态执行迁到 VM/Worker 后宣称它不再需要纳入闭包。

建议 PR：`refactor(custody): bind five-edge recursion to the official Pi runtime`。

## 11. OP5：官方依赖、身份与安装产物

### 11.1 包来源

最终以官方 exact version/integrity 安装 coding-agent，以及实际需要的官方 ai/agent-core；用锁文件记录完整解析边。不同包允许官方支持的不同版本，不机械要求全家版本相同。直接依赖和每个实际消费方的解析结果都要核对。

优先发行“BYOK 自有产物 + 官方未修改的依赖闭包”的受控安装单元；不依赖用户 PATH/global Pi。构建时可以生成组合 manifest，不能声称官方包签名等于组合产物可信。

若现有 S1/S2 packaging 不能容纳官方包闭包：将所需布局改动作为明确、最小的新版本安装契约，证明完整文件集、interpreter、资源、load commands/loader 环境与运行输入；不能继续沿用旧 S2 的名称和验收范围而不重验。不能为迁移同时新开两种长期官方安装形态。

### 11.2 重写身份 gate，不删除 gate

`pi-runtime-identity.mjs` 应从 fork alias/marker 转为官方发行名、固定版本、tarball integrity、实际 exports/contract compatibility、自有 bridge digest 与实际依赖闭包。保留“预期身份 != 实际身份就拒绝”。

完整组合清单必须能够说明：官方模块、桥接模块、工具/extension、runtime/interpreter、resource、编译产物之间的对应关系。构建后再检查最终 artifact；顶层 lock 没有 fork 不足以证明 bundle 未内嵌旧代码。

### 11.3 安装与更新

复用 Host immutable release record/finalizer/pointer update；保持旧版本留存、幂等/碰撞/中断处理、enrollment 不变。运行进程不以 root 身份执行；特权仅用于已经批准的固定安装动作。

首次安装和更新使用同一发行输入。设备离线/部分下载/校验失败/指针切换中断时明确失败或回到旧激活指针，不重写存量 task。取证 cleanup 不能遍历树外 symlink/junction。

### 11.4 用户可验证信息

安装诊断至少展示 runtime source、official package/version、BYOK bridge version/digest、验证平台、开启工具和资源清单、artifact identity、policy revision。官方包 integrity 验证与 BYOK 自有签名/更新信任分别报告；不存在的 provenance 不伪造。

保留上游 LICENSE/NOTICE；再编译进 Salesko 二进制时用“包含官方未修改源码的 BYOK 构建”口径，不称整个 binary 为官方发行。

建议 PR：`build(pi): replace fork aliases with provenance-bound official packages`。

## 12. OP6：Host 消费与 C07-H2b

从已确认的 Host adoption 分支建立独立 worktree，不能假设 #241 已合入 main；与原负责人确认同文件写入所有权。只做 SDK 官方迁移所需消费和 C07 既有缺口，不混入 UI 大改或新的 Bot 功能。

### 实施步骤

1. 按不可变 tarball/integrity 消费通过 SDK gate 的候选；不使用 live symlink 冒充正式组合。
2. 将 H2a 的本地候选 types 替换成实际 SDK public types；验证 Summary 标记、assistant 原文、shared-input 去重和非交替消息序列，不补造 user/assistant 行。
3. 同一 source snapshot 独立枚举 epoch membership，再与实际取回的 Turn/messages 比对。
4. 在 PG 锁外执行 authenticated preparation/request/status；重试复用原 preparation identity。
5. 在短事务里重验 epoch、transcript revision、队首、model selection、policy/receipt、Execution cap 和 outbox 状态；一次提交 frozen Execution 与 dispatch intent。
6. counter unknown/失败或 receipt invalid 时保留已准入输入，但不创建 Execution；admission 层未配置真实预算仍维持当前拒绝语义，原 receipt 重放优先。
7. 现行 prepareContextPack 签名等 pending amendments 集中对账，不直接修改旧冻结正文。
8. 完整 tool-result 后继计数范围与 first-request 保证分别记录；不因官方迁移误报全对话预算完成。

### 接受条件

计数调用时无 PG 行锁；CAS 冲突无 Execution/outbox 半提交；callback 丢响应后原消息一次物化；Host commit/SDK finalize 跨进程恢复；迁移后旧 task 仍按原身份回读。所有证据绑定 Host SHA + SDK tarball + 官方 Pi package + interpreter + policy。

建议 PR：`feat(host): consume the official-Pi SDK candidate through the existing preparation CAS path`。

## 13. OP7：验收矩阵

这是语义族矩阵，不要求全参数笛卡尔积。测试模式分 L（真实官方 runtime + 本地受控响应）、I（安装包/独立进程/持久 DB）、N（受批准真实目标）。纯函数测试用于辅助，不替代 L/I/N。

| ID | 场景 | 通过条件 | 层 |
|---|---|---|---|
| T01 | 官方来源与嵌套依赖 | 活动解析和最终 bundle 均无 BYOK Pi fork | I |
| T02 | 未导出/private API | 构建只引用支持的 public surface | I |
| T03 | 干净用户环境 | 无 global Pi 也能按受控官方安装启动 | L/I |
| T04 | 全局/project 注入 | 恶意资源、自动安装/cfg 不被隐式加载 | L/I |
| T05 | 身份漂移 | 修改 runtime/bridge/resource/interpreter 后启动被拒绝 | I |
| T06 | 明确模型与认证 | 缺失/漂移不选默认，不泄露 secrets | L/N |
| T07 | fresh 多轮 | Host 历史进入新 session，没有旧 session 偷渡 | L/I/N |
| T08 | canonical assistant history | UTF-8 原文/role/顺序保持，无伪造 usage | L/I |
| T09 | cancelled/ended 历史 | 内容与已批准投影相符，语义差异显式记录 | L/I |
| T10 | preparation 纯度 | 无 task/claim/grant/模型/业务工具；纯阶段无 I/O | L/I |
| T11 | 完整请求覆盖 | framing/history/tools/options 全计；未知 coverage 拒绝 | L/N |
| T12 | prepare/consume 字节 | 实際 transport body 与冻结 D 一致 | L/I |
| T13 | 计数/发送负控 | 故意预算拒绝/超时/钩子失败后 generation 请求为 0 | L/I |
| T14 | 实际监测链负控 | 拔掉主请求 gate/观察点时对应测试必须失败 | L/I |
| T15 | 后继工具结果请求 | 第二次模型调用不借用首请求预算身份 | L/N |
| T16 | retry/redirect/transport | 不绕 gate、不换模型/endpoint、不扩大重试语义 | L/I |
| T17 | 显式消息和最终文本 | 每个 required task/Turn 只有允许的 canonical body | L/I |
| T18 | accepted 后失败/取消 | 已交付正文保留；终态和资源仍独立 | L/I |
| T19 | Host COMMIT 后 finalize 前崩溃 | 重启精确重放不重复正文，不新启动模型 | I |
| T20 | D2 身份/撤权 | 跨 task/Agent/tenant/旧 nonce 拒绝；撤权后无新副作用 | L/I |
| T21 | 五条递归边 | 真正 child 经过冻结 binding，不靠 stub graph | L/I |
| T22 | charge-once | 1/1/0/1/1 计数表成立，双扣 mutation 被检测 | L/I |
| T23 | fanout/session/permit 并发 | 跨进程争最后名额/同 session 只准一方 | I |
| T24 | parent cancel/unknown | 无新委派；未证实没启动的不退款自动重跑 | I |
| T25 | print/workflow/资源 | 已承诺语义执行，不能跳过功能避开动态装载 | L/I |
| T26 | S2/加载约束 | 按本次精确布局重验，原违规尝试不能静默豁免 | I |
| T27 | 初装/更新/回退 | 实际 record/pointer/enrollment 保持一致 | I |
| T28 | Windows/Linux/macOS | 现有承诺平台各自运行到真实断言；unsupported 不计 PASS | I |
| T29 | 树外 cleanup canary | 内容和权限不变；断链失败停止递归 | I |
| T30 | Host epoch/CAS 并发 | 独立成员枚举；clear/append/模型漂移不误派发 | I |
| T31 | 旧新任务迁移 | 旧 task 不换 runtime；同 home 不双 writer | I |
| T32 | 同一正式组合真实目标 | 有界 generation/counter、多轮/取消/重启证据齐备 | N |

### 四个实质 gate

- G1：OP1 官方替代能力与明确缺口。不能把“启动成功”写成去 fork 完成。
- G2：OP2–OP4 语义等价，活动生产实现不再需要 fork-only 接口；所有 critical 负控有效。
- G3：OP5–OP7 干净安装/持久恢复/平台/Host 固定组合通过，无 test skip 冒充。
- G4：经批准的真实目标与迁移演练、用户信任披露通过后，才允许安排启用。真实 provider 权限/成本缺失时只阻断 N 与启用，不阻断 provider-free 工程。

## 14. CI 和证据组织

### 14.1 验证分层

每 PR：受影响类型、定向测试、关键 mutation、scope/workflow。集成候选冻结后：root build/typecheck/API surface/release graph、全仓和必要平台安装矩阵。官方版本变动必须重跑相关 conformance；只改说明文字可复用同一产品字节的有效证据。

源码审查器扫描活动 import、patch 配置、alias、lock 与最终构建图；历史归档的 fork 名称不是失败。不能依赖一个 grep 退出 1 就证明没有 fork。

“Bun/Node 缺失而跳过”“零测试匹配”“预期红项”均不得产生发布 PASS。Windows 管理员拒绝负控和非管理员正向运行分别保留。

### 14.2 已存在的根命令

以下名称已在本轮 SDK package.json 核实；只在实施工作树、依赖完整时运行，不表示本轮已经执行：

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run check:api-surface
bun run check:version-authority
bun run check:release-graph
bun run test:scripts
bun run test
bun run check:release-pack
bun run check:task-workflow
```

定向 Pi conformance 尚需 OP1/OP7 正式注册脚本；不要在报告中列不存在的命令并标 PASS。Host 采用其已登记 check 命令及本次有界测试，不照抄 SDK 目录运行。

### 14.3 每个 gate 的证据最小集

固定 source SHA、官方 registry package/integrity、SDK tarball hashes、Host SHA、platform/arch/interpreter、具体 scenario、执行数/pass/fail/skip、实际 send/model-start/tool-call 计数、产物/source/policy 绑定、故障注入位置、日志 hash、未覆盖项。

日志不得含 token、nonce、真实用户全文；必须保留正文的故障证据使用授权 fixture 或现有受限存储。PASS 只对对应组合有效，不能将各旧 PR 的单独 PASS 相加成新组合 PASS。

## 15. OP8：切换、恢复与退役

### 15.1 默认切换：先排空，再启用；不建双 runtime 路由

1. 确认是否存在真实 fork 在途 task、pending message、prepared artifact、home lease 和需要恢复的旧记录；不能因“未正式发布”就推断没有。
2. 保持 callbacks、message replay、cancel/reconcile 可用，暂停将要切换目标的新输入/新 Execution 分配。
3. 旧消息投影与尚未结算工作按原 runtime/输入身份恢复；unknown 不能被当作零任务。
4. 需要继续原 Execution 时保留完整旧 runtime/SDK/interpreter/资源产物，不只保留一个包名；不改 taskId，也不读取新默认配置重建。
5. 旧任务和资源释放收敛后，激活已通过 G4 的官方组合。
6. 对批准的设备/Agent 开始新任务；同一 home 不允许旧新 writer 并行。
7. 再逐步扩围。没有副作用的录制 fixture 可对照；不得让两条运行线同时执行一条真实用户指令作为 A/B。

旧任务长期 unknown 时，提供具体身份、最后观察和可用恢复操作；不能为赶退役自动重试模型或删除 pins。空历史环境可在证明无在途事实后省略排空，不引入没有需要的兼容层。

### 15.2 回退边界

- 官方尚未产生新 Execution：可回退新准入激活指针，持久记录不变。
- 官方已经产生任务：先停新准入，保留官方产物恢复这些 task；回退只影响未来任务，不将它们改交 fork。
- 数据/schema 变化：不能靠回退二进制宣称回退 DDL。通过明确兼容清单/迁移策略处理；本项目优先避免非必要产品 schema 变化。
- Credential/enrollment 不因 runtime 回退被重建；恢复 grant 与新模型执行权限仍按各自原契约。

### 15.3 fork 退役条件

活动依赖与 bundle 无 fork；新任务只使用官方组合；受支持平台/功能通过；没有必须由 fork 完成的未决执行/消息/资源；历史可读与必要恢复产物保留；官方包来源和 adapter 用户披露完整。

之后停止 fork 功能更新，维护窗口只覆盖必要安全/排空修复，不能由此继续开发功能分支。不可 unpublish 历史包破坏复现。旧产物清理由明确 retention + live references 驱动，不拍脑袋设一个日期或 TTL 强删。

建议 PR：`chore(pi): retire active fork dependencies and publish the official-runtime migration record`。

## 16. 与当前工作和 issues 的关系

| 既有事项 | 本方案处理 |
|---|---|
| custody/五边已经投入的实现 | 复用；只替换实际 runtime binding 并重验执行点 |
| Windows CI、reparse cleanup、安装恢复 | 继续独立完成；不要等 upstream pure compile 才修 |
| SDK input-preparation service、receipt/store、Host H1/H2a | 保留；替换 Pi adapter 和完成 H2b，不再造第二套 |
| #194 输入计量 | OP2/OP6/OP7 提供后续证据；official 能运行不自动关闭 |
| #195 ContextPack/Summary 完整链路 | 保留原分阶段边界；SummaryJob 不因去 fork 自动完成 |
| #196 packed recovery | OP7 的正文持久副作用恢复复用；receipt 读回不等于 Host 正文恢复 |
| #197 文档权威 | 收敛到官方运行目标与新版本契约；旧草案作历史 |
| native1006、fork 后继扩展 | 停止新增非必要专有接口；本轮只做保现有/安全/迁移所需工作 |
| C08 Bot UI | 可按独立稳定协议推进，但不以 UI 完成代替 runtime 启用 |
| Routines/Inbox/Summary 生产 job | 仍按原产品阶段后置，不混入迁移 PR |

本次未创建或修改 issues。上表是复用关系，不是当前 issue 状态查询或关闭决定。

## 17. 多 agent 派工与文件所有权

建议由现有 Claude supervisor 负责该 work package 的范围和证据整合；SDK、Host 各指定一个实现负责人，独立 gatekeeper 不批准自己写的核心补丁。pane 名仅是操作标识，不是长期权威或本轮可控工具。

- SDK runtime engineer：OP1–OP3，主要持有 `adapters/pi/`、`bin/pi-*`。
- Custody engineer：OP4；共享 runner 文件只交 runtime owner 串行整合，不同时写。
- Release engineer：OP0 来源核对和 OP5；manifest/lock/API goldens 由单一 integrator 写入。
- Host engineer：OP6，独立 Host worktree，避免与现有 adoption 负责人同文件并发。
- Gatekeeper：G1–G4 的证据复核与关键负控复跑；不把 CI 绿灯直接当产品批准。

任务 PR 按责任包堆叠，每个 head/base 明确。公共接口/协议变化单 owner 串行；协议冻结后可在不同路径并行实现。分支更新先核对 upstream 是否已含相同修复，不能重复开发已经合入的工作。

## 18. 风险与默认处置

| 风险 | 默认处置 |
|---|---|
| 官方缺少 pure compile/consume | 最小上游接口工作；停该能力启用，不引入第二 fork/serializer |
| provider fetch 无法沿 public Session 注入 | 证明受支持 provider 注册/transport 包装路径；无路径则同样 upstream，不用私有 monkey patch |
| 官方默认 discovery/auth/compaction 改输入 | 全部显式控制并实际验证；无法控制则不声明强保证 |
| 官方消息类型要求不存在的历史字段 | 公开历史导入接口或最小上游补丁；不得编造历史 usage |
| 官方升级破坏工具/proxy/递归语义 | 固定已验版本，维护 adapter conformance，不追着 main 自动升级 |
| 去 fork 变成大型 bridge | 代码差异按职责 review；若开始复制 provider/session 核心即停止该做法 |
| 供应链来源可验但运行不安全 | 分别验证代码身份、资源/工具授权、OS 保护；不宣称同一件事 |
| 旧未知任务阻止退役 | 保留最小精确恢复集合，停止新 fork 功能；不删除数据假排空 |
| 多仓候选不一致 | 固定组合 manifest，不以相同 semver或同一目录名推断字节一致 |

## 19. 给执行负责人的启动指令

> 目标是官方 Pi SDK + 现有 BYOK adapter，退出 `@byok-sdk/pi-*` 活动依赖。先从 `byok-sdk@79f6a0d35952392c37652cb2f7fecaf6dcc255a6` 做 OP0 和 OP1：固定真正的官方 registry 包、清点所有 fork delta、建立五项公开接口 probe。官方源码参考 `earendil-works/pi@36b60d2e8985899743c4cf5bd5f8929832a3f05d`，不将它冒充 npm 产物。Host 参考 Draft #241@32cfcd49，不假定 main 已有这些代码。
>
> 复用现有 Session runner、D2、消息恢复、custody 和安装权威。不得改主线依赖以制造半成品；不得 private deep import、patch-package、复制 serializer、全局网络 monkey patch 或放宽预算/S2；不得改用户全局 Pi。task-free preparation 与 final-send gate 分别证明。
>
> G1 通过的能力进入后续适配；缺失的必要能力给最小上游接口补丁及失败用例，其他独立工作继续。最终同一组 SDK/Host/官方 Pi/解释器产物通过故障和平台测试后，才讨论正式启用。源代码有界实现不包含生产安装、发布、迁移或无上限真实 provider 调用授权。

## 20. 来源索引

以下是本轮或同一固定 ref 已读取的事实入口；设计建议与待验收要求不伪装成这些来源已经实现的功能。

- S1 — SDK client manifest：<https://github.com/Ancienttwo/byok-sdk/blob/79f6a0d35952392c37652cb2f7fecaf6dcc255a6/packages/client/package.json>
- S2 — SDK root scripts：<https://github.com/Ancienttwo/byok-sdk/blob/79f6a0d35952392c37652cb2f7fecaf6dcc255a6/package.json>
- S3 — 现有 runtime assembly：<https://github.com/Ancienttwo/byok-sdk/blob/79f6a0d35952392c37652cb2f7fecaf6dcc255a6/packages/client/src/bin/pi-session-runtime.ts>
- S4 — 现有 RPC wrapper：<https://github.com/Ancienttwo/byok-sdk/blob/79f6a0d35952392c37652cb2f7fecaf6dcc255a6/packages/client/src/bin/pi-rpc-host.ts>
- S5 — 输入准备/消费契约：<https://github.com/Ancienttwo/byok-sdk/blob/79f6a0d35952392c37652cb2f7fecaf6dcc255a6/docs/researches/runtime-input-preparation-contract.md>
- S6 — 当前 fork 身份 gate：<https://github.com/Ancienttwo/byok-sdk/blob/79f6a0d35952392c37652cb2f7fecaf6dcc255a6/scripts/release/pi-runtime-identity.mjs>
- S7 — 官方 Session public options：<https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/sdk.ts>
- S8 — 官方 ModelRuntime：<https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/model-runtime.ts>
- S9 — 官方 provider transport options：<https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/ai/src/types.ts>
- S10 — 官方 extension hook runner：<https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/extensions/runner.ts>
- S11 — Salesko 候选与证据边界：<https://github.com/Ancienttwo/salesko-new/pull/241>；固定源码 <https://github.com/Ancienttwo/salesko-new/tree/32cfcd499c0acb92efd4868ebd683b8b2cfa9daf>
- S12 — 当前 bot-centric 冻结语义：<https://github.com/Ancienttwo/salesko-new/blob/32cfcd499c0acb92efd4868ebd683b8b2cfa9daf/docs/researches/20260912-byok-018-authoritative-contract-draft-3.md>；冻结收据 <https://github.com/Ancienttwo/salesko-new/blob/32cfcd499c0acb92efd4868ebd683b8b2cfa9daf/docs/researches/20260912-byok-018-c02-owner-freeze.md>
- S13 — 官方文档（本轮查询，执行时以选定发行包为准）：<https://pi.dev/docs/latest/sdk>、<https://pi.dev/docs/latest/extensions>、<https://pi.dev/docs/latest/security>、<https://pi.dev/docs/latest/custom-provider>

---

## Task Breakdown

状态图例：`[x]` 已闭合且证据落位；`[ ]` 未闭合。执行切片按依赖推进，非全串行排期。

- [x] OP0 固定发行基线 + 真实 fork 增量清单 + 契约/写范围登记（2026-09-19 完成）
  - [x] OP0-a 官方正式发行候选：`@earendil-works/pi-coding-agent@0.85.1`，integrity/shasum/sha256 本机复算一致，gitHead `d981de12…`，SLSA v1 provenance（`refs/tags/v0.85.1`，subject digest 与 tarball 逐字节一致），engines `node>=22.19.0`，无生命周期脚本，自带 `npm-shrinkwrap.json` 闭包（165 条目）
  - [x] OP0-b fork 包溯源：三个 fork 包 registry 元数据均**无 gitHead、无 provenance attestation**；从 `byokFork` manifest 块读到声明的 `upstreamBase=0.85.1` / `upstreamCommit=d981de12…`，与官方 `gitHead` 一致；文件级比对证实 fork = 官方 0.85.1 + 有界增量
  - [x] OP0-c fork-delta-map 落位 `docs/researches/2026-09-19-official-pi-fork-delta-map.md`（20 条 delta，四种类别，含 §6.2 必填列）
  - [x] OP0-d 官方安装隔离验证：`/tmp/pi-official-install` 独立安装 132 包成功、无全局 Pi、根入口 151 导出；三个 fork 专有子路径 + `/client` 实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`；**本仓 `bun.lock`、根 manifest、`packages/client/package.json` 一字未改**
  - [x] OP0-e `docs/researches/2026-09-19-official-pi-baseline.json` 落位（显式标注 notProductConfig=true）
- [x] OP1 五项有界 probe（P01–P05）：真实官方 npm tarball + 临时目录 + 独立子进程；每项保留实际网络/工具调用计数与失败案例（2026-09-19 完成，三次运行 verdict 一致）
  - [x] P01 Session/工具/回复 → **supported**（显式 session、授权工具往返 2 次请求、无 HOME 发现、dispose 正常）
  - [x] P02 历史投影 → **not-supported**（注入 host 断言 assistant 文本后请求数 0、无异常、无事件错误：静默哑掉）
  - [x] P03 task-free 准备 → **not-supported**（coding-agent 151 导出 / pi-ai 48 导出中无纯编译入口；服务构建有文件副作用）
  - [x] P04 发送强制点 → **partial**（调用方 transport 可在发送前取得最终字节并拒发，端点 0 请求；但拒绝被吞掉且触发 3 次隐式 auto_retry；`before_provider_request` 抛错拦不住发送）
  - [x] P05 装载/递归兼容 → **supported（装载面）**；递归 spawn 语义不在本探针覆盖范围（归 OP4）
  - [x] **G1 裁定：第二档**——基础执行可行，缺 pure compile/consume 与历史导入；推进 OP2-U 最小上游接口；相关生产路径保持禁用
- [ ] OP2 预算/prepared 接口替代（必要时 OP2-U 最小上游改进）
  - [x] OP2-U 定界：追加 `p03b`/`p04d` 两个探针，把「缺三样」切成可提接口的粒度，落位 `docs/researches/2026-09-19-official-pi-op2u-upstream-request.md`
    - G-A 会话首请求无法在会话外复现（会话外 248 字节 vs 会话 308 字节；系统消息被追加 cwd，顶层键多出 prompt cache 两项）
    - G-B payload 无任何覆盖证明/结构分类
    - G-C host 断言历史导致静默 0 请求
    - G-D **不需要上游**：运行归属方可自行判定「拒发且零请求」（`p04d` supported）
  - [x] OP2-U 形状可行性实测（2026-09-19，**已推翻「最小补丁」假设**）：完整 checkout 上游 main，`npm ci --ignore-scripts` + `hydrate-model-data` 后基线 `npx tsgo --noEmit` **EXIT 0**；仅在 `packages/ai/src/types.ts` 加入 `HostAssertedAssistantMessage` 与 `Message` 联合扩展，即产生 **146 个类型错误 / 42 文件 / 4 个 package**（coding-agent 75、agent 44、ai 22、evals 5；src 107 / test 28 / examples 11）。
  - [x] OP2-U 交付物成文（2026-09-19）：自包含、可直接提交的上游请求文本落位 `docs/researches/2026-09-19-official-pi-upstream-request.md`（英文、无 BYOK 内部术语；三条请求各带精确符号/位置、实测数字、最小复现、以及「我们不要求什么」）。
    - **未对外提交**：公开向上游 filing 属外部动作，需 owner 明确 go/no-go；plan §7.2 要求的交付物（可运行最小反例、精确缺失符号/行为、责任归属、下一补丁位置）已全部具备。
  - [x] OP2-U 的 G-A 实测（2026-09-19，上游 main 真实 session 路径）：一次通过的临时 vitest 实验捕获到会话首请求 = **6123 字节**，顶层键 `max_tokens, messages, model, stream, system, thinking, tools`；交给 transport 的 Context **只有 `messages`**，角色序列是 **`system, system, user`**；transport 尝试 **4** 次（`auto_retry` 在 main 上未改）。
    - 意义：G-A 从「请给一个纯编译入口」变成可检验表述——调用方要复现的不只是对话内容，还有**两条 system 消息的拆分**与 adapter 层的**选项推导**。
  - [x] OP2-U 的 G-A 逐字节比对（2026-09-19，完成）：会话交给 transport 的三条消息 = `system(调用方原文)` / `system(content="", sections, toolsAdded)` / `user`；用公开 `buildSystemPromptSections({cwd})` 在无 session 下重建，**3/5 sections 逐字节相等**（`cwd` 76、`docs` 1160、`preamble` 169），`rules`/`tools` 因会话自填输入而不同，补 `selectedTools` 后仍不变。
    - **G-A 表述再次收紧**：官方缺的不是「一个 compile 函数」，而是**会话自己的输入推导**（喂给投影的整套输入没有公开入口让调用方以同样方式得到）。请上游「暴露/文档化该输入推导」而不是「新增准备接口」。此结果也把目标版本分叉推向「重钉到下一发行版」，因为 `main` 已把提示投影做成公开纯函数。
  - [x] OP2-U 的 G-A 字段级归因（2026-09-19，完成）：按 `agent-session.ts:1081-1101` 的规则逐项搬输入后，差距收敛到**一项**——builtin 工具的 `promptSnippet`/`promptGuidelines` 来自会话自己的定义注册表（`agent-session.ts:2800-2814`），公开的 `createCodingTools()` 给不出同样的元数据（实测只有 `bash` 带 snippet）。上游请求据此缩到一句话：**暴露 builtin 工具定义（含 prompt 元数据）或 session 使用的 snippet/guideline 映射**。
  - [x] OP2-U 的 G-A 收口（2026-09-19，证据链闭合）：`toolsAdded` 的模型可见投影（`read`/`bash`/`edit`/`write` 的 `description` 与 `parameters`）**4/4 逐字节相等**，差异只在调用方对象多出的非模型可见字段（`execute`/`label`/`executionMode`/`prepareArguments`）。加上投影公开、推导规则可读，**G-A 只剩一项缺公开来源的输入**：builtin 工具的 prompt 元数据。请求定稿为一句话，不需要新接口、不需要改消息模型。
  - [x] OP2-U 的 G-B 量化（2026-09-19）：provider 请求由**单个** `buildParams`（`packages/ai/src/api/openai-completions.ts:796-1002`）产出，字面量 5 键 + 条件赋值 15 键，**顶层键集合封闭可枚举（约 20 个）且每键取值由显式输入决定**。缺口不是能力而是契约：没有带版本的「键集合 + 值类别」声明，也没有未分类键 fail closed 的路径。请求缩为一句话：公开请求形状契约并对未知键 fail closed。
  - [x] OP2-U 的 G-C 隔离实验（2026-09-19）：直接调公开 `streamSimple`，三段消息，唯一变量是那条 assistant 文本是否带 provenance —— 对照 fetch 被调用、`host_text` **fetch 从未被调用且不报错**、`full_provenance` 恢复正常。**G-C 确认为硬缺口**：原因被隔离到具体字段（缺 `api`/`provider`/`model`/`usage`/`stopReason`），失败静默，而唯一 workaround（补齐这些字段）等于伪造历史出处与用量、被 INV 与 §8.2 明令禁止。最小反例缩到三条消息 + 一个布尔观测。
    - 三条缺口形态至此统一（G-A 暴露 prompt 元数据 / G-B 公开形状契约 / G-C 三选一形状），可一次性提交给上游。
  - [x] OP2-U 的 G-A **更正并撤销**（2026-09-19）：G-A **不是上游缺口**。包根已公开导出 per-tool definition 工厂（`packages/coding-agent/src/index.ts:305-314`），它们带 `promptSnippet`；改用这组公开函数后派生提示状态 **5/5 section 逐字节相等**（76 / 1160 / 169 / 839 / 339，`sectionsEqual: true`），`toolsAdded` 也已 4/4 相等。此前两轮把缺口指成内部工厂是**用错工厂造成的假缺口**（`createCodingTools` 的 prompt 元数据不覆盖全部 builtin）。**上游请求从三条减为两条**（G-B 形状契约 + G-C host 历史），另附一条可选文档建议。
  - [ ] **目标版本重钉（owner 裁决点）**：同日只读核对发现 `main` 已重构 G-A 所依赖的同一子系统（`SystemMessage` 变为可回放的分节转录消息 + `buildSystemPromptSections`/`buildSystemPromptState`/`diffSystemPromptSections`/`forceSystemPrompt`），而 npm `latest` 仍是 `0.85.1`。
    - 分叉 A（建议）：把迁移目标重钉到「包含分节 `SystemMessage` 的下一正式发行版」，届时 `node packages/client/probes/pi-official/run.mjs --official-version <x>` 重跑 7 项后再定 OP1/G1 与 OP2-U 文本。
    - 分叉 B：维持 `0.85.1` 并按 `docs/researches/2026-09-19-official-pi-op2u-upstream-request.md` §1–§6 提接口，需同时论证「为何在即将被替换的形状上新增接口」。
    - 两分支都不改变当前判断：prepared 生产路径保持禁用，`official_supported` 不得声明。
- [ ] OP3 现有 runtime、工具、消息、凭证迁移
- [ ] OP4 五边递归、custody、workflow 等价接线
- [ ] OP5 官方依赖、身份、安装与来源证明
- [ ] OP6 Host C07-H2b 与正式包消费
- [ ] OP7 固定组合故障/平台/真实目标验收（T01–T32，G3/G4）
- [ ] OP8 准入切换、旧工作排空、fork 退役

横切（owner 2026-09-19 明确要求「更新相关架构文档」）：

- [x] 架构文档落位：ADR-036 记录「官方发行来源 + 身份以发行事实绑定 + 缺失 seam 只走最小上游改进 + G1 已裁定」的权威裁定；`docs/architecture/index.md` Decision Records 与 `sdk-architecture.md` 附录 A 帐本行同步。
- [ ] 架构文档收口：OP3/OP5 落地时把 `sdk-architecture.md` 的 runtime 状态从「fork 活动依赖」改为「官方发行包 + adapter」，并在 §11 缺口帐本与 §12.8 路线中标注 G2–G4。

## Evidence Contract

- **State/progress path**: 本文件 `## Task Breakdown`；`tasks/todos.md`（deferred ledger）；`tasks/contracts/20260919-1603-official-pi-migration.contract.md`；`tasks/reviews/20260919-1603-official-pi-migration.review.md`；`tasks/notes/20260919-1603-official-pi-migration.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`、`docs/researches/2026-09-19-official-pi-baseline.json`、`docs/researches/2026-09-19-official-pi-fork-delta-map.md`、契约 Verification Plan 内命令
- **Evaluator rubric**: G1–G4 各自最小证据集（§14.3）；PASS 只对冻结组合有效；无实现证据不得写 `official_supported=true`
- **Stop condition**: Task Breakdown 全勾 + strict 通过 + review 推荐 pass；或 G1 裁定为「技术路径拒绝」并按 §7.2 输出最小反例
- **Rollback surface**: 见下节

## Promotion Gate

- **Merge/PR unit**: OP0 独立 PR（`audit(pi): freeze official package baseline and classify fork deltas`）；OP1 独立 PR（`test(pi): verify official runtime substitution through public APIs`）
- **Rollback surface**: `## Rollback Surface`
- **Verification boundary**: OP0 = registry 元数据 + 本仓消费面只读清点 + tarball 字节比对；OP1 = 真实官方 tarball 上的可运行 probe
- **Review/acceptance boundary**: 独立 gatekeeper 复核 G1；实现者不自批
- **High-risk surface**: 依赖来源变更、身份 gate 重写、发布/安装产物（strict profile 的 release/auth/public-api 面）
- **Why not checklist row**: 跨仓（SDK + 官方上游 + Host）证据面与独立验收门，超出单一 checklist 行承载能力

## Rollback Surface

- OP0/OP1 阶段不改产品依赖：回滚 = 放弃本 worktree，main 依赖与 lock 不变。
- OP3 之后（产品依赖已切）：按 §15.2 回退边界执行——官方尚未产生新 Execution 时回退准入激活指针，持久记录不变；已产生任务时只停新准入，回退仅影响未来任务。
- 本 plan/contract 的登记回滚：`repo-harness run switch-plan --plan plans/plan-20260917-1459-byok-next-stage-recursive-s2.md`（main checkout 的活动计划从未被本 worktree 改动）。
