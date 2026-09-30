# Chasen 的 Pi Coding Harness：文章整理与 byok-sdk 集成评估

> 调研日期：2026-09-30。目标仓库：`main@ede2db31ad33072965434b04743cfd7e52b93e85`。
> 范围：整理文章，并静态审查全部 10 个 package 的实际 npm 发布源码；本轮不安装扩展、不修改 SDK runtime、不宣称完成兼容性验收。

## 1. 来源与证据口径

- [作者原帖](https://x.com/chasen_liao/status/2092963119337476137)，关联 [X Article](https://x.com/i/article/2090655519673626624)，作者 Chasen，发表于 2026-08-27。
- X 直接读取返回 403；通过 [FxTwitter 的该帖 JSON](https://api.fxtwitter.com/status/2092963119337476137) 读取 article 的 title、content blocks、链接与发布时间。它是第三方转发入口，不等于直接从 X 验证；二级转载只用于定位，不作为技术裁定依据。
- [npm 发布快照](./evidence/2026-09-30-chasen-pi-packages/npm-inventory.json)：全部 10 包的 exact version、发布时间、repository、license、dependencies、peerDependencies、tarball URL、integrity、SHA-256；重新下载并验证全部 tarball 的 SHA-512 integrity。
- [发布源码定位](./evidence/2026-09-30-chasen-pi-packages/source-locations.md)。深入读取 README、manifest、extension entry 和对应调用路径；源码解包到 `/tmp/byok-chasen-packages`，未执行第三方安装脚本或 extension。
- 以下评估针对本次查到的发布版本，不冒充作者写作当天版本。npm `latest` 与宽泛 peer range 不是对本地 Pi 0.87.1 的兼容性证明；近期发版也不代表维护质量或安全审计。

## 2. 文章整理：可借鉴的是控制纪律

文章讨论作者从 Claude Code 转到 Pi 后，如何自行组织 coding harness。核心可分为三层：长期规则负责划定边界，Skills 按任务提供方法，Packages 实现调度与交互。作者主张少量常用能力常驻，其他能力显式加载，避免上下文和路由被大量插件占满。

其工作路径可以归纳为：消除需求歧义、只读调查实际代码路径、授权范围内实现、独立上下文 review、父 agent 综合证据。并行要求职责互补；多个写入者要使用隔离 worktree，而不是竞争同一目录。对较小任务，不必强行安排多 agent。

作者对长任务的观察是：子任务状态、产物和验证证据比单纯 checkbox 更有用；一个 package 是否值得加入，应由真实痛点决定。包清单涵盖 subagents、skill 管理、结构化提问、局部简化、skill mention、联网研究、持续 goal、context 可视化、旁路问答、索引搜索。

文章中的 cache 命中率和效率提升是作者个人体验，缺少 workload、模型、基准及对照，不能作为 SDK 性能收益预测。关于 Pi 权限的提醒也不能直接外推到 BYOK：SDK 有自己的 policy、custody 和实现身份检查，但这些检查同样不自动把任意第三方 extension 变成沙箱代码。

## 3. P1：本地系统边界

本地 `docs/spec.md` 定义 subscription lane 由 Claude/Codex CLI 自持登录，BYOK lane 由本机 profile 和 credential-custody launcher 选择并注入凭证。Pi 负责模型 transport 和 agent loop；SDK 管理跨 runtime 的执行准入、身份、生命周期和数据权威。

| 边界 | 当前入口与职责 | 对外部包的约束 |
| --- | --- | --- |
| Client / daemon | `packages/client/src/daemon/task-runner.ts`、`input-preparation-service.ts` | 不让 extension 自造另一套 task/Run authority |
| Ordinary Pi RPC | `packages/client/src/bin/pi-rpc-host.ts:159`、`pi-extension-factories.js` | 明确 factory 注入；已经有 web、MCP、subagents policy、vendored subagents、todo |
| Prepared Pi | `packages/client/src/bin/pi-prepared-host.ts:889` → `adapters/pi/prepared-session.ts:306` | tool names/executors 与 manifest 一致；上下文由 gate 投影；首请求须与 counted bytes 一致 |
| Credential / implementation identity | `packages/client/src/custody/`、`packages/implementation-identity/src/identity.ts` | 新依赖、native binary、spawn、凭证名必须进入现有受控 closure，而非全局 install |
| Team / operator Pi | `packages/client/src/bin/pi-team-operator-host.ts`、`adapters/pi/team-interaction-extension.ts` | 与 unattended dispatch 分开评价 UI；现有交互不等于任意 custom TUI 都可远程呈现 |
| Host-owned context | `docs/researches/runtime-input-preparation-contract.md`、`2026-09-28-prepared-agent-memory-contract.md` | Host 组装 context，设备负责 capability 准入；不能在计量后再次隐式发现/展开 skill |
| Cloud / protocol / keys | 各自独立 authority，见 `docs/architecture/sdk-architecture.md` | UI 插件不应因此扩入 cloud、wire 或 provider-secret plane |

**核实的重要差异：** 本地 client 是 `0.24.0-rc.1`，official Pi pin 为 **0.87.1**；`pi-subagents@0.60.0` 是 dev-only upstream oracle，实际 shipped factory 指向 vendor，不能读 manifest 后误判为未集成。`pi-web-access@0.24.1` 是已有运行时依赖。本地没有 `.codegraph/`，所以本次按源码调用路径定位。

## 4. P2：一条具体路径说明为什么不能批量安装

以 prepared Pi 为例：Host 申请 input preparation → daemon 按本地 authority 解析 capability、观察工具和实现身份 → 保存 counted artifact / binding → PiAdapter 比对 offer、manifest、launch 和 MCP authority → 启动 `byok-pi-prepared` → MCP initialize/tools/list 复验 → `createPreparedPiSession` 比对工具顺序和 executor identity → Pi context gate 投影 Host transcript → provider first-request byte gate → 实际 tool rounds → SDK 收集 runtime 结果。

源码压力点是 `prepared-session.ts:306–365`：resource loader 明确关闭 ambient extensions、skills、prompt templates、themes、context files，仅注入 `byok-prepared-context`；`SessionManager.inMemory`，retry、compaction、cache warming 关闭。Ordinary RPC 与 prepared 是不同路径，不能把 ordinary 已有 subagents/web 推断为 prepared 也有。

错误路径包括 tool registry drift、prepared expectation mismatch、launch/MCP implementation identity drift，以及 first-request byte drift；均拒绝，不使用另一组工具或模型重试。新增 extension 如果在 `input` 或 `before_agent_start` 改 prompt，会破坏可重放输入；如果自行 `sendUserMessage`，就产生 Host 未准入的后续工作；若注册新工具，则 counted manifest、policy 与 executor identity 必须同刀接线。异步 child 和第三方网络请求还必须受现有 cancellation、process ownership 和数据策略约束。

## 5. 全包决策矩阵

`reference` 表示借鉴局部设计，`fork` 表示需要 SDK 持有明确改造后的版本，`reject` 指拒绝直接接入 SDK 核心，不评价插件对个人 Pi 的价值。

| Package / 查验版本 | 发布日期 | License | Verdict / 适配结论 |
| --- | --- | --- | --- |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) 0.73.1 | 09-27 | MIT | **已集成受控 vendor；保留**。升级需要独立差异与 custody 验收，不能新装一份 |
| [pi-skillful](https://github.com/jvm/pi-mono/tree/main/packages/pi-skillful) 0.4.0 | 07-28 | MIT | **reference**。借鉴显式 selection 与渐进加载；不引入祖先扫描和 ambient settings |
| [@eko24ive/pi-ask](https://github.com/eko24ive/pi-ask) 1.2.0 | 08-16 | MIT | **reference，优先候选**。借鉴结构化 clarification；原包不能直接适配 unattended RPC |
| [pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) 0.2.3 | 07-17 | MIT | **reference**。用已有 review Skill/workflow 表达，通常不需要 runtime dependency |
| [@zigai/pi-mention-skill](https://github.com/zigai/pi-tweaks/tree/main/packages/pi-mention-skill) 0.10.4 | 09-22 | MIT | **reference，Host UI 可选**。与 skillful 功能重合，不同时接入两套展开器 |
| [@tavily/pi-extension](https://www.npmjs.com/package/@tavily/pi-extension) 0.1.2 | 05-19 | 未声明 | **reject 直接 dependency；reference 服务接口**。已有 web 能力，先由本机 MCP toolset 集成特定需求 |
| [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal) 0.54.8 | 09-20 | MIT | **reject 核心集成；reference 停止语义**。与 SDK Run/continuation 权威相冲突 |
| [pi-context-usage](https://github.com/championswimmer/pi-context-usage) 2.1.0 | 09-29 | ISC | **reference，低耦合优先候选**。抽只读投影，不拿估值替代 token admission |
| [@narumitw/pi-btw](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-btw) 0.61.1 | 09-25 | MIT | **reject 直接集成；reference Host 侧旁支 Session**。存在额外模型调用和独立侧线程 |
| [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) 0.11.0 | 09-21 | MIT | **fork / bounded PoC，有条件候选**。性能尚未证明，native closure 与 workspace 隔离先过关 |

日期均为 2026 年；具体时间见证据 JSON。Tavily 发布包没有 LICENSE 文件且 manifest 未声明 license，本轮未建立可再分发许可依据；不能把其服务可用或其他 Tavily 项目许可当作该包许可。

## 6. 各包深入分析

### 6.1 pi-subagents：维护已有边界，不重复建设

当前上游 entry 为 `index.js`，提供 foreground child sessions、background runners、workflow orchestration、artifacts 和 fleet。0.73.1 README 描述 lazy `subagents_enable`，新 session 初始不暴露完整 schema，授权 delegation 后再启用。它的文档还提供 per-run fanout 限制，说明“并行 agent”不仅是 Promise.all，而是进程/Session/预算和产物协议。

BYOK 的 `pi-extension-factories.js:4` 静态导入 `vendor/pi-subagents/0.60.0/index.ts`，`pi-rpc-host.ts:159` 同时注入 policy extension。vendor 的 `PROVENANCE.md` 和 source manifest 记录上游来源、SDK delta、sealed backend 的 refusal；部分早期 provenance 叙述具有历史性，递归现状必须以 `custody-five-edge-dispatch.test.ts`、runner/print entry 与当前实现判断，不能照抄旧注释当现状。

收益已存在。新包升级会影响 lazy schema、child tool admission、background lifecycle、workflow closure 和 SDK patches；直接 npm install 会出现两个版本/两份状态。最小方案是单独 upstream delta inventory，保留唯一 vendor authority，运行现有 official workflow 与 five-edge custody 验收。这里没有本轮升级的授权需求或验收证据。

### 6.2 pi-skillful：选择机制有价值，发现机制不适合原样带入

`src/extensions/progressive-skills.ts` 在 `resources_discover` 从 git parent 一直向根目录发现 `.agents/skills`，以 first-wins 处理冲突；`inline-skill-invocation.ts` 在 `input` 读取 Skill 文件并 transform prompt；visibility/toggle 扩展在 `before_agent_start` 改 system prompt。全局与可信 project settings 共同决定隐藏与 slot，package-bundled skills 不受隐藏规则影响。因此“hide skill”是 advertisement 控制，不是 capability 禁用或权限撤销。

还有实际附带行为：`extensions/index.ts` 调用 `reportInstallTelemetry`；`src/install-telemetry.ts:61–98` 在非 CI/offline 且未显式禁用时向 `mocito.dev/api/report-install` 报 package/version 与 runtime/platform User-Agent，并写 agent-dir 状态。不能在 SDK 中悄然继承它。

建议只参考其显式 selection UX：Host 在 preparation **之前**解析唯一 skill ID、读入受控来源、形成 deterministic context；如需本机 skill resolver，另裁信任目录、hash、同名冲突、symlink 和 bounded bytes。不能先 counted 再从父目录装入指令；也不建议为普通 SDK task 继承 `~/.pi` 配置。

### 6.3 pi-ask：最需要的是 clarification contract

真实路径为 `src/index.ts` → `registerAskTool` → schema normalization / validation → append ask payload → 检查 `ctx.mode` → TUI `runAskFlow` → normalized result。`ask-tool.ts` 明确 `ctx.mode !== 'tui'` 时返回 nonInteractiveResponse，**不会自动变成远程问答**。`remote-ask.ts` 虽定义 started/submit/completed event 与 flow/request ID，但这是进程内 bus；不能把它当作带身份认证、持久化和重连语义的 SaaS transport。

其他功能包含恢复悬而未决表单、replay 和 `/answer` extraction；后者通过 modelRegistry complete/getApiKeyAndHeaders 发额外模型请求。整个包还在 `before_agent_start` 附加配置提示。一次 clarification 可以因此牵入 UI、额外消费、会话恢复和 prompt mutation。

适合萃取：question ID、单/多选、选项说明、推荐提示、自由回答、显式取消和最终提交。推荐标记不能等价于用户提交。SDK 应把 clarification 与 tool approval 区分：前者提供意图，后者授予操作权限；不要复用 approval 状态而混淆两者。

要落地，先证明 existing operator UI 能否支持简单问答，再裁 unattended Host 方案。问题应绑定 tenant/Agent/Session/Run/Attempt、question ID 和 revision，防迟到答案与旧 Attempt 回放；取消/重启有明确状态。此处是**设计建议**，不是当前 SDK 已有该契约的断言。

### 6.4 pi-simplify：是 prompt workflow，不是代码改动强制边界

`src/simplify-command.ts:31–47` 解析 staged/ref/files → `git-diff.ts` 用 git diff 获取文件和 hunk → `prompt-builder.ts` 生成 review prompt → `sendUserMessage(... followUp)`。限制编辑到改动行，是对模型的指令，不是 filesystem write gate 或机器证明；“跑测试”同样取决于 agent 执行。

适合放在 repo/Host review Skill 或现有 subagent workflow，按固定 base SHA、scope 与 acceptance 提供 fresh reviewer。避免在 SDK runtime 自动续一轮会写文件的 simplify；也不能把不完整 git diff 当作包含全部 untracked 文件、rename 和任意文件名的正确 scope。若移植 parser，先验含空格/tab 的路径、untracked、binary、deleted 和 rename。MIT 保留归属，不为少量 prompt logic 引入完整 dependency。

### 6.5 pi-mention-skill：输入便利属于 Host

`src/index.ts` 经 `@zigai/pi-mention-anything/api` 注册 `skill` mention provider，从 Pi commands 解析 skill candidates，再读取与缓存展开内容；UI 依赖 autocomplete，伴随 `@zigai/pi-extension-settings`。它不是 skill 执行隔离层，也不保证展开内容来自 SDK 准入的来源。

可给 Host 输入框实现 `$` 搜索/选择与 content preview，提交前完成展开，记录 selection 与 source hash。与 skillful 一起接会有两套 marker/缓存/展开时机，容易重复内容或产生 stale bytes。保持一个解析入口，优先解决有真实产品消费者的需求。

### 6.6 Tavily：用 existing MCP seam 避免扩第二个网络 authority

`index.ts:201–218` 直接读取 `TAVILY_API_KEY` 并缓存 client；两个注册工具为 `web_search` 与 `web_fetch`。search → Tavily Search；fetch → Tavily Extract，后者通常意味着把 URL 交给第三方抓取，而非本机抓网页。两条调用都传 `ctx.sessionManager.getSessionId()`，若使用需明确原生 Session 标识外发的数据策略。

本地 ordinary Pi 已有 `webExtension`。只有需求明确要求 Tavily search depth、news/domain filters、managed extraction 或 credits 信息时，才有理由引入另一服务。更合适的是本机拥有 executable/secret 的 read-only MCP toolset：先 observation/admission，随后走相同 prepared manifest；prepared 当前没有 generic web factory 不意味着可以隐式注入它。

接入服务仍需明确 timeout/cancel、结果 bytes 上限、URL/redirect 与私网策略、query 隐私、citation 数据和失败码；服务费由宿主决定。包的 license/repository metadata 不足是另一个 direct dependency 阻塞，不由 @tavily/core 的许可消除。

### 6.7 pi-goal：借鉴有限停止条件，不接管 SDK 调度

`src/tools.ts` 注册 complete/blocked/wait；`lifecycle.ts` 订阅 agent_end/settled、input、context、compaction 等；`runtime.ts:426` 发 followUp，`:1168` 将 goal state append 到 Pi session。它是有 persistence、预算和 continuation 的控制循环，不只是提示词。

直接启用会让 Pi-native goal 与 SDK Run/Attempt/Host admission 同时决定“何时继续、何时完成”。等待 deadline、自动 followup 与恢复尤其容易产生已 terminal Run 仍有新模型工作的问题。已有本地 session ownership 和 cancellation 不能仅靠将 goal 状态复制到 task 字段解决。

参考显式完成/阻塞/等待、token/time budget 和避免 busy polling；若产品需要长期 goal，应由 Host 把它编排成有准入的 Runs，Pi 只执行获准的一次工作。不要引入第二套 goal persistence 或以 `goal_complete` 冒充 SDK durable terminal result。

### 6.8 pi-context-usage：最适合先做只读萃取

`src/context/index.ts:608` 观察 request prompt/context 并注册 `/context`；`tokens.ts` 用 ContextUsage、上一条成功 assistant usage、model limits 构造 buckets；breakdown 对可见 system/tools 使用字符比例估算，对 turns 使用 Pi estimateTokens。UI 命令展示 summary/details，细节视图依赖 custom TUI。

具体误读风险：`getCachedSystemToolsTokens` 返回 `cacheRead + cacheWrite`，不能据此精确分离 system/tools；cache 命中不只属于这两类。`computeUsageBuckets` 某些路径用固定比例推估 system/tool 开销，unknown 也不能在远程 UI 变成“0 token，完全可用”。extension-load order 同样影响观察到的 prompt。

适合先萃取纯只读投影：区分 provider-reported usage、visible estimates、context window、configured output reserve、unknown；保留来源与方法标记。不得用 chars/4 做 prepared admission、计费或自动 compaction，不上传 prompt/tool body。prepared 当前关闭 native compaction；不能照文章一概建议满了自动 compact。

入口为 SDK 已有 runtime usage/events 和 Host UI，首先验证当前公开观测是否已经足够；无需默认安装 TUI 包，也无需先新增 wire 字段。这是低耦合候选，不是已证明用户最紧急的需求。

### 6.9 pi-btw：侧问题也要有正式执行权威

`src/btw.ts:82–85` 通过 modelRegistry.streamSimple 创建 completion；`side-thread.ts:96` 构造单独 messages 并完成 side-thread turn。它使用官方 Pi 模型路径，并不意味着绕过 Pi provider registry；冲突在于这些额外请求没有自动成为 SDK 准入的 Run。交互依赖 custom fullscreen UI、side-thread settings 和 transcript 管理。

适合参考“主线程上下文不自动污染”。如 Host 产品真的需要旁支，创建明确的独立 Session/Run，用户显式选择带回摘要；上下文复制、凭证 scope、预算、取消与 side-thread retention 均按 SDK 既有 authority 管。不能把 UI 上 `/btw` 当成无副作用的只读按钮：模型请求仍耗费 tokens，并可能向 provider 发送主线程 context。

### 6.10 pi-fff：唯一值得性能 PoC 的候选，但先补 native 边界

0.11.0 README 与文章有重要差异：默认 `tools-and-ui` **新增** fffind/ffgrep 等并替换 autocomplete；只有 `override` 才替换 built-in find/grep。`src/index.ts:715` 更新 active tool names，lifecycle 初始化/销毁 finder。运行源码静态导入 `@ff-labs/fff-node`，manifest 同时依赖 fff-bun 与 fff-node；下层 native 实现未在本轮逐行审计，不对 SIMD 或速度作实测承诺。

配置包含 LMDB frecency/history；默认允许 home scan、默认 follow symlinks，root scan 默认关闭。git/frecency ranking 有利于交互定位，但不能替代 exhaustive grep：top-k fuzzy search、分页 cursor 与严格找全 symbol references 是不同语义。全局 cache 和跨 worktree symlink 也会把 scope 扩到 Workspace 之外。

仅在大仓库搜索被测为瓶颈时做 fork/PoC：固定 SDK Workspace root；禁 home/root scan 和越界链接；cache 放本机独立受控目录；保留确定性 grep；只开放 read tools，不启 autocomplete 或全局 mode。验证 native artifact 在 macOS arm64/x64、Linux、Windows 与 sealed/SEA 包装中的闭包和加载行为，禁止缺件后自动换实现。

基准必须覆盖 cold/warm、index RSS、startup、取消、变更后 freshness、ignore/symlink、find-all recall，以及并发 worktrees。建议预先确定性能和内存阈值再跑，不把作者体感当 gate。10x 仓库规模时先失败的可能是 index build/RSS、watcher 和 native packaging，未必是单次 query。

## 7. P3：最小一致决策与集成顺序

现有设计刻意将交互式 Pi 配置与 SDK execution authority 分开，prepared 更通过封闭资源加载和首请求 bytes 保证测到什么就执行什么。这换取了确定性与可追溯性，代价是不能随意安装全局插件。应保留这个核心不变量。

建议顺序：

1. **保留并维护已有 subagents/web**：先查清 upstream 升级与现有 closure，避免重复依赖。本轮不给新集成承诺。
2. **只读 context projection**：若现有 Host observability 不足，先从已有 usage 提供来源明确的展示；不增加调度权或 raw-body telemetry。
3. **clarification contract**：有实际远程问答消费者时，以 pi-ask 为参考，先做 question/answer lifecycle 与 stale Attempt 拒绝，再做 UI。
4. **Host skill selection / scoped simplify workflow**：按需组装 context 和 review，不嵌入 ambient runtime extension。
5. **FFF bounded PoC**：只有已测搜索瓶颈才启动；Tavily 同理，先明确服务差异与许可。

pi-goal、pi-btw 不宜成为核心依赖；确有产品需求时，分别转为 Host goal→Runs 编排和旁支 Session，走已有 authority。这是设计参考，不是装一个插件就完成的功能。

10x 并发下最先受压的通常是 subagent fanout/取消与排队、clarification pending state、额外 provider calls、FFF index/cache，以及大 tool schema/context；因此最小切片应一次只新增一个可验证边界。不要为了文章的三层表达再建一个通用 SDK plugin registry。

## 8. 验证与局限

本轮完成文章内容读取、10 包 exact registry/tarball snapshot、integrity 验证、entry/关键执行路径静态分析、本地 ordinary/prepared/operator 路径对照。没有执行第三方 extension、没有真实 provider 消费、没有 native FFF benchmark；宽泛 peer dependencies、近期发布和 MIT/ISC 许可都不能代替实际 runtime / policy 验收。

仓库 required checks 已实际尝试：build、typecheck、test 因本 checkout 未安装 tsup/tsc/vitest 返回 127；API surface 因 9 个 public package 的 dist 缺失返回 1；version-authority 通过。task-workflow 通过（exit 0）；文档相对链接、10 包数量与本地关键入口存在性检查通过。逐项 exit code 见 [验证 receipt](./evidence/2026-09-30-chasen-pi-packages/validation.json)。本次文档调研没有为这些环境缺件安装 dependencies 或改 lockfile，也没有把未跑起来的检查写成 PASS。

**下一刀**

建议切 `context usage 只读观测差距核对`。理由是当前候选中它不需要增加模型调用、修改上下文或新增执行权威，而静态分析已证明上游估值不能直接充当 SDK 精确计量。入口是 `packages/client/src/adapters/pi/events.ts`、`packages/client/src/adapters/pi/prepared-session.ts` 与宿主现有 usage 展示；范围仅核对现有公开字段是否足够，并输出一份 provider-reported / estimated / unknown 的映射。字段足够就交由 Host 消费，不改 SDK；不足才提出一个最小观测增量，因此这一刀有明确停止条件。
