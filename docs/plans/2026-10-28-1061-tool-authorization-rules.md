# #1061：用户自定义工具授权规则

状态：decision-complete；**D1–D7 已获 owner 批准（2026-10-28）**，按批准决定实施，设计与实现同一个 ready PR，不再请求设计批准。目标 **0.31.0**，取代最初的 0.32.0 / 单独设计批准 / Draft-only 要求。不合并，交协调席位按 SHA 绑定 squash。

设计基线：`671309da6cc78bebb21b660180620c431a3dc512`（#1079）。当前产品合同以 [spec](../spec.md#tool-authorization-auto-and-all-1061) 为准；本文件记录这次扩展的决定，不把历史方案作为另一份配置 authority。

## P1 — 已观察到的边界

- [#1078](https://github.com/Ancienttwo/byok-sdk/pull/1078) 把策略统一到本地 `DaemonConfig.toolAuthorization(task)`；只返回 `auto | all`，每个 offer 在 claim 前解析一次。远端 offer 和 adapter 不决定策略。
- [#1079](https://github.com/Ancienttwo/byok-sdk/pull/1079) 保证 tool approval 拒绝只拒绝该工具、turn 继续；Codex `file_change` 批量路径和移动目标进入同一个分类器。
- `packages/client/src/tool-authorization.ts` 拥有 `ToolCall`、`ToolRisk`、`classifyToolCall` 和 auto gate。`daemon/task-runner/offer-launch.ts` 拥有 admission 和 gate 构造；`event-pump.ts` 通过同一个 classifier 生成 all reminder。审批只有现有的 FIFO approval 路径。
- Pi ordinary RPC 在其他 extensions 之后注册 `tool_call` hook，原生子代理继承 gate；Claude 通过确认后的 SDK `PreToolUse` hook。Codex/Grok/Hermes、Pi prepared/durable 无完整 pre-tool coverage，auto 在 claim 前 decline。
- MCP identity 已有 `mcp/event-identity.ts` / `mcp/projection.ts` 的 admitted-name map；名字可能包含 `__`，不能拆字符串猜 server/tool。all 使用 runtime 规范化事件已有的 `mcp`；auto 从本次 admitted observation 精确映射。没有可信 identity 的个人 MCP/自定义 extension，MCP selector 不命中，可用显式 native `toolName`。
- 客户端 `engines.node >=24.22.1`，workspace `>=24.15.0`。本机 Node 24.22.1 实测存在 `node:path.matchesGlob`。无需新依赖。
- `.ai/context/capabilities.json`、`.ai/context/context-map.json`、`tasks/` 和 `.codegraph/` 在该 checkout 不存在；本切片不新增 scoped context 或索引。

## 参考来源及证据限度

2026-10-28 只读观察 `/Applications/Grok Bot.app`（Info.plist：0.77.0，bundle id `com.anysphere.sand`）Permissions 页面：Auto-Review 的说明为 “Review Grok Bot actions based on custom rules”；Always Ask 和 Allow without Asking 分别展示规则列表，并有新增、逐条编辑、删除入口。owner 提供的三个例子在 UI 可见：限定仓库的 push/draft PR、merge、standard registries 安装。没有新增、编辑或删除设置，也没有运行真实动作来推断优先级。

仅检查 app bundle 的字符串/格式：有 `allowInstructions` / `blockInstructions` / `autoReviewTeamEnforced`，以及 “Always Ask wins, whoever wrote it.” 文案。它证明 UI 与配置词汇，不能证明实际 reviewer 的模型、BYOK 来源、计费、默认规则或执行保障；不把字段 `blockInstructions` 等同于 SDK 的 deny。没有深度逆向，也没有读取凭据。

本机 `~/.grok/docs/user-guide/22-permissions-and-safety.md` 的 “How a tool call is authorized”、“Rule Matching Reference” 和 “Evaluation Order” 提供另一种参考：结构化 `Bash(...)`、`Read(...)`、`MCPTool(...)`，`deny > ask > allow`，命中不了继续走 mode；auto classifier 对复杂 shell 有额外规定。文档对 auto 先判与显式规则的叙述有路径差异，因此不照搬未经本机行为证实的执行顺序。SDK 这次明确采用 D2，且不实现 Grok 的 shell parser、managed policy、remembered grants 或 deny。

[AiphaBee 的更新需求](https://github.com/Ancienttwo/byok-sdk/issues/1061#issuecomment-6460193726)：Auto 是“默认放行，重大问题才拦”，保持安装依赖、回测、文件和网络能力。它是本设计保留 classifier fallback、避免 allowlist 默认拒绝的依据；其“本次失败，下个 turn 授权”的 Host 产品流程不替换 #1078 的现有等待审批合同。

## P2 — 一次输入到输出的路径

`offer` → 本地 resolver（包括 resume offer）→ 校验、复制并递归冻结 policy → 缺完整 gate 的 auto runtime 在 claim 前 decline → claim/start。

auto：runtime hook → 现有 gate → daemon 从 admitted observation 补 MCP identity → `classifyToolCall(call, workspace, home, rules)` → Always Ask / floor / Allow / built-in 的唯一决定 → 普通调用直接 allow；需审批调用复用 `requestApproval` → allow 或 denied tool result。gate 发本地审计；用户 reject、超时、gate 丢失均不把工具拒绝升级成 task-terminal reject。

all：没有 pre-tool gate → 规范化 `tool_use` → 同一个 `classifyToolCall` 和该 task 冻结的 rules → normal 不提醒，high 产生带规则信息的本地 reminder。它是观察，不能保证动作前提醒或阻止执行。

## P3 — 默认决定及 owner 勾选

以下 D1–D7 已获 owner 批准；保留推荐、理由、不选后果供审计。D8 是 owner 更新的交付指令。

| 确认 | 决定与推荐 | 理由 | 不选的后果 |
| --- | --- | --- | --- |
| [x] D1 | SDK 确定性结构化匹配；description 仅展示；不加 reviewer 回调 | 零模型调用、无 BYOK 需求、结果可重放，动作中的自然语言不能操纵 reviewer | 选自然语言必须另定模型、凭据、账单、超时、注入与隐私合同；不能暗中把 description 变成可执行政策 |
| [x] D2 | `Always Ask > sensitive-path floor > Allow > built-in`；不加 deny | 普通动作可升级审批；可信 allow 能覆盖 push/publish 等 classifier 风险，凭据与登录持久化路径仍需人批 | allow 优先会压掉用户明确 ask；classifier 总优先会让 allow 无法减少打扰；加 deny 会扩展产品动作及 all 语义 |
| [x] D3 | resolver 接受 mode 字符串或 policy 对象，每 offer 校验、复制冻结；resume 重取；wire/Pi launch/digest 不改 | 扩展现有任务 authority；同一 Agent 可按 task 使用不同规则，无 adapter 级双 authority | Agent 固定规则会耦合不同任务；热更新会改变已批准任务的行为；改 launch 会把本地策略复制给 runtime |
| [x] D4 | all 中 allow 压掉 reminder，ask 增加 reminder；floor 不被 allow 压掉 | 两个模式消费相同风险结果，同时 all 保持从不拦截 | 完全忽略规则会造成 Auto 与 all 提醒不一致；让 all 等审批则破坏其合同 |
| [x] D5 | gate verdict、本地 decision event 和 reminder 携带 source/命中 rule IDs；不把规则写进 wire | Host 可解释“为什么问/为什么直接执行”，并审计被 allow 压掉的提示 | 只记录 reminder 会丢失自动放行依据；外发原始规则/命令会扩大隐私面 |
| [x] D6 | Pi/Claude 复用 gate；Codex/Grok/Hermes 继续 auto pre-claim decline | UI 和部分终端 hook 不代表全量 pre-tool coverage | 冒充支持会让不经 gate 的文件工具绕过 ask |
| [x] D7 | 使用 Node `path.matchesGlob`，不加依赖 | 已满足 engines，避免自行维护第二套 glob 语言 | 换自写 matcher 必须定义不同语法并承担 Windows/转义测试；增加依赖没有已证实收益 |
| [x] D8 | 0.31.0，同一个 ready PR 交设计、实现、验证；不合并 | owner 后续明确指令优先 | 保持 0.32.0 或单独 Draft 设计会遗漏已授权交付 |

## 规则语言的精确定义

```ts
export interface ToolRule {
  readonly id: string;
  readonly description?: string;
  readonly match: {
    readonly toolName?: string;
    readonly commandGlob?: string;
    readonly pathGlob?: string;
    readonly mcpServer?: string;
    readonly mcpTool?: string;
  };
}
export interface ToolAuthorizationRules {
  readonly alwaysAsk?: readonly ToolRule[];
  readonly allowWithoutAsking?: readonly ToolRule[];
}
export interface ToolAuthorizationPolicy {
  readonly mode: ToolAuthorizationMode; // 'auto' | 'all'
  readonly rules?: ToolAuthorizationRules;
}
export type ToolAuthorizationResolver =
  (task: ToolAuthorizationTask) => ToolAuthorizationMode | ToolAuthorizationPolicy;
export interface ToolAuthorizationReason {
  readonly source: 'rule' | 'built-in' | 'floor';
  readonly ruleIds: readonly string[];
}
// classifyToolCall remains the sole decision entrypoint; ToolRisk carries authorization.
// ToolAuthorizationVerdict adds optional authorization for classified decisions;
// transport/malformed-input failures may have no classification.
```

使用例（remote 是 raw command 的字面匹配，不证明 Git 最终发往哪个仓库）：

```ts
toolAuthorization: task => ({
  mode: 'auto',
  rules: {
    alwaysAsk: [{ id: 'review-merges', description: 'Merge 前请主人确认',
      match: { toolName: 'Bash', commandGlob: 'gh pr merge **' } }],
    allowWithoutAsking: [{ id: 'push-origin', description: 'Allow push to origin',
      match: { toolName: 'Bash', commandGlob: 'git push origin *' } }],
  },
})
```

`toolName` 精确、区分大小写，保持 runtime 原名（Pi `bash` / Claude `Bash`）；其余四个 selector 是 `node:path.matchesGlob` 的完整字符串 glob，采用当前平台的 `node:path` 语义，不加 regex、字符串前缀匹配、自动大小写折叠或自然语言推断。`*` 不跨路径 separator，`**` 才跨；command 含文件路径时也遵守这个语义。description 不影响匹配。每条规则的已给字段 **AND**；同一列表内各条规则 **OR**；至少一个 selector。一个条件的字段不存在或不能表示时该规则不命中，不把缺失当作通配。

- command 来自现有 `command` / `cmd` 提取（string 或 string[] 以空格 join）。匹配整段原始 command，**不**剥 wrapper、展开变量、拆 shell chain、执行命令、解析 Git config 或证明 remote/repository。`git push origin *` 中 `*` 也能覆盖空格和额外 shell 文本；这是宽 glob 授权范围，不能当命令 AST 或 sandbox。Host 应展示完整 pattern，并用窄 pattern 或 ask 处理不确定脚本。限定 repository 的 Grok 自然语言例子不能靠本功能自动得到等价保证。
- path 使用 classifier 已有的 path keys 以及 Codex `file_change.changes`（含 move destination）；相对路径依 runtime call cwd，`~` 依 daemon home 展开并词法 normalize，不跟随 symlink。对一批路径，ask 只需任一路径命中；allow 必须所有已提取路径均命中同一条 path 规则，避免第一个安全路径替整批放行。不扫描任意 input 字段或 shell 文本猜文件访问。
- `mcpServer` / `mcpTool` 使用可信 identity map 或规范化事件的字段；不解析任意 `mcp__...` 名称。未被 task observation 识别的个人 MCP 不承诺跨 runtime server/tool 规则覆盖。
- 不实现 repository/remote selector；只有 command glob 的字面形式。增加可信目标身份需要独立 action contract，不从模型文本推断。

### admission 校验及冻结

保留原字符串返回值，是 D3 明确要求的两种公开输入形态；两者在 admission 后立即投影为唯一的 policy 对象，不保留两条执行路径。未配置 resolver 等价 `{ mode: 'all' }`。旧 mode parser 的 `auto | all` 校验仍严格，不加 legacy wording。

policy/rules/rule/match 都拒绝未知 key、错误类型、空或全空白 id、空 selector、缺 selector、非 array 列表及两个列表间重复 id。可选 description 必须 string；不存在就不生成值。拒绝 NUL 和超长输入；总规则数最多 128，id 最多 128 字符，description 和每个 selector 最多 4096 字符；不截断规则。glob 使用 Node 接受的语法，匹配器拒绝的 pattern 在 claim 前报配置错误，不吞错后放行。resolver throw、校验失败统一 `tool_authorization_unresolved` pre-claim decline，运行时不启动。

把用户数组、rule、match 逐层复制并冻结，task 内只读这个快照；Host 后续修改原对象不会改变正在运行的任务。规则不写到 Agent home、native settings 或 MCP/LLM prompt。没有磁盘规则自动发现、远端 rules、模型生成 rules 或持久 remembered grant；存储、UI 增删改和跨 daemon 分发由 Host 拥有。

## 优先级、模式与可观测性

每次先提取现有 built-in 风险与路径，再依 D2 决定最终风险；这不是两个 classifier。Always Ask 命中就 high，`source: rule`，ruleIds 为该列表所有命中项；floor 命中就 high，`source: floor`，没有获胜 allow rule；再看 allow 命中转 normal，`source: rule`；否则保留 built-in 风险，`source: built-in`。多条匹配按配置顺序报告 ID，行为不依赖列表顺序。若 ask 与 floor 同时存在，记录 rule 来源并保留 sensitive-path 风险原因，不能掩盖底线。

floor 复用 `sensitive-path`，覆盖现有 `SENSITIVE_HOME_PATHS` 中凭据和登录持久化位置的已识别 read/write/命令访问。它要求人工审批，**不是绝对禁止用户授权**。没有新秘密扫描器，也不声称识别任意编码、脚本、symlink 或外发凭据；未知间接访问仍是现有词法分类器的限制。plain read anywhere 和普通本地工具继续默认放行。

| 最终结果 | auto | all |
| --- | --- | --- |
| Always Ask 命中 | 一次现有 approval；拒绝不执行、turn 继续 | 一次 reminder，不发 approval |
| 没有 ask，floor 命中（即使 allow 命中） | 需 approval | reminder |
| 没有 ask/floor，Allow 命中 | 直接执行，无 approval | 不发 reminder |
| 无规则命中、built-in high | 现有 approval | 现有 reminder |
| 无规则命中、built-in normal | 直接执行 | 不提醒 |

gate 的 classified verdict 添加 `authorization: { source, ruleIds }`。另发本地 `tool-authorization` DaemonEvent（task/call identity、allow/deny、source、ruleIds、risk reasons；不含 input/description）；all 的 `tool-reminder` 添加同样 metadata。daemon record 投影保留 ID/source/reasons，继续不记录原始命令、路径、规则正文或 token。`ruleIds` 是 Host 自定的审计 identifier，Host 不应把秘密放进 ID。observer 异常只影响观察，不能把已决定的 deny 变 allow，也不能阻断正常工具。

ask 的 summary 要区分 custom rule、floor 和 built-in，不把普通动作强行描述成发现某种系统危险。审批仍绑定现有 approvalId；超时、withdrawal 和迟到批准不得复活动作。预算从每次 authorize 开始，包括审批排队；没有 reviewer 延迟或费用。用户一次 approve 只覆盖当前调用，不修改规则。

## scope、resume、launch 与 wire

Host 可按 resolver 的 taskId/runtimeId/agentRef 选择规则，同一 Agent 的研究、聊天、发布任务互不强制共享。规则编辑只影响下一个 offer；运行中任务、其 followUp 和原生子代理沿用快照。新 resume offer 重新调用 resolver、校验并冻结当时的规则；不恢复历史 allow，也不偷偷沿用旧 rules。

规则只在 daemon 内存 gate closure / ActiveTask 中存在。Pi launch 继续 v8，`ToolAuthorizationIpcConfig` 的 url/token/timeoutMs 及 digest 字段均不变，子代理通过原 gate 回连；不能把未传递的 rules 说成被 native session digest 承诺。新的 resume launch 使用本次 gate，runtime 旧 sessionRef 不拥有授权 authority。

server protocol、offer、progress schema、`task.await_approval` / `approve` / `reject` 不新增字段；审计只在本地 DaemonEvent/record 和本地 gate result。SDK 原生 bridge 继续只处理 approve/deny，不把规则或 description 投喂模型。API surface golden/README/entry budgets 在最终 build 后按实测更新，不加余量；不修改版本 authority，由 0.31.0 发布切片统一改包版本。

## 验收与实施切片

| 层 | 零费用验收 |
| --- | --- |
| classifier / admission unit | AND/OR、精确 toolName、command/path/MCP glob、缺字段、批量路径全覆盖、ask/allow 冲突、floor、description 不可执行、非法 shape/重复 ID/长度、复制冻结 |
| daemon task loopback | 非法规则在 claim 前 decline；两种返回形态一致；task 隔离；all ask 提醒/allow 静默/floor 提醒；本地审计 metadata；修改原规则不影响 active task；新 offer/resume 重取 resolver |
| 真 Pi ordinary RPC + 本地 provider | ask 升级普通 write，拒绝时目标不存在；allow 放行原 high write，目标真实写入；floor 不被 allow 覆盖（合成 home，不读真实凭据）；resume 后重新选定规则仍有效；原生子代理 gate 回归 |
| 真 Claude CLI + 本地 provider | 同一 ask/allow/floor 矩阵；`disableAllHooks` / native allow / bypass 不能绕过 SDK；resume 使用本次 policy gate；确认目标实际存在或不存在以及 turn 结束 |
| runtime admission | Codex/Grok/Hermes、Pi prepared/durable 仍不支持 auto，不因 rules 创建假 gate |
| API/打包 | build、typecheck、check:api-surface、check:version-authority；记录真实 exit code 与精确 entry bytes |

实现前锁定本文件与公开类型；并行 writer 各自独立 clean worktree，按 core / daemon / runtime tests 分文件所有权。parent 负责集成、所有测试、golden 和预算。新功能增量写行为测试；若发现 bug，先记录 red，再修。已有 assertion 只因公开返回值新增审计 metadata 或明确改变的新功能语义而更新，PR 逐项说明；不删除保护旧授权、失败或副作用的 assertion。

本地仅跑指定四项检查与定向测试；全量交 PR CI。权限变更执行一次独立只读实现/断言审查，复用最终检查证据。此设计交付时的调查只读，没有运行付费模型；自然语言规则引入每调用一轮 reviewer 的延迟、费用、凭据和 prompt injection 风险，在本次实现中均不存在。

10x 时先遇到人工 approval 队列（当前每 task 16 个排队上限）及逐规则匹配 CPU；匹配成本约为每调用 `rules × fields × 文本长度`，不新增网络往返。对规则数和 pattern 长度设 admission 上限，不做缓存、后台 reviewer、热更新或规则编译服务。缺少任意脚本/文件隔离保证是已知边界，不用扩大本切片来假装解决 #1061 的 sandbox/额外 workspace 工作。
