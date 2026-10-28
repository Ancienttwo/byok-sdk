# #1061 Agent task 工具边界设计

> 已被 [2026-10-28-1061-auth-auto-all.md](2026-10-28-1061-auth-auto-all.md) 取代：工具白名单与 `inherit` 默认路径已删除，产品只保留 `auto` | `all`。以下为历史记录。

状态：D1–D6 已获 owner 批准，S1 获准实施；S2/S3 尚未实施，不宣称隔离已生效。
基线：`494e92217f518bf9e9455b5f31180a36433efa5c`。
需求：https://github.com/Ancienttwo/byok-sdk/issues/1061
Owner 已选顺序：先完成设计与边界评审，再实施。

2026-10-28：独立 gatekeeper 对设计快照 SHA256 `c262a721ebf7b119809a606785902c68ecf8f7e663f739e8478f2b854f53f34c` 给出 PASS，仅限设计边界。随后 owner 明确回复「批准 D1–D6，先实施 S1」。本记录不把设计 PASS 当作实现或真实 runtime 验收。

## P1 — 现有边界

- `RuntimeOperationManifest.agentRef` 标识 Agent task；`cwd` 是工作目录，lease 的 `canonicalHome` 才是 daemon 授权的 home。远端 task 不能自行指定本机工具策略。
- `packages/client/src/adapters/pi/pi-adapter.ts` 的普通 RPC lane 写入 digest 绑定的 `byok.pi.rpc-launch` v5。`bin/pi-rpc-host.ts` 固定加载 web、MCP、subagent、todo，并保留用户资源。
- `bin/pi-session-runtime.ts` 已接受 `tools`、`excludeTools`、`noTools` 与资源加载选项。prepared lane 和 team operator 使用不同契约，不应当作普通 Agent lane 的替代实现。
- `bin/pi-session-runtime.ts` 的 `resetResumedPiTools` 恢复当前工具集；现有 `__tests__/pi-resumed-tools.test.ts` 覆盖 transcript 中 pending 工具。这条路径不能在新 allowlist 下被跳过。
- Claude 已有 `agentUserContext`；它不等于工具限制，也不排除所有 settings/hooks。Grok 的 terminal 由 client 回调执行。Codex 已有 sandbox，但不意味着 Agent home 是完整的 sandbox 根。
- `docs/spec.md` 的 fresh Pi 规定保留默认 native tools 和用户扩展；`docs/architecture/sdk-architecture.md` §9 明确 Agent home 只是 cwd convention，不保证 filesystem/network/tool 隔离。实现必须在同一切片更新这些承诺。

## P2 — 输入到执行

普通 Agent offer → daemon 验证与 lease → manifest + 本机 adapter options → Pi adapter 计算有效策略 → digest 绑定 launch 文件 → RPC helper 校验 → resource loader + session tool registry → 首次模型请求 → tool executor。

当前压力点是 adapter 没有传递限制、helper 无条件加载扩展。只在模型请求中删 schema 不够：恢复会话和 executor 也必须使用同一工具集合；禁止工具不能通过旧 transcript 恢复。策略必须由本机 Host 设置，不能从 prompt、模型输出或 tool description 推导。

## P3 — 建议的保证与代价

先交付可独立验收的 runtime 工具选择；完整 home 文件边界是后续单独切片。不能把前者记作 #1061 全部完成。默认保持现状，限制显式 opt-in；不新增旧 launch 格式的兼容 parser。

已批准决策如下：

| 决策 | 建议 | 保证与限制 |
| --- | --- | --- |
| D1 默认行为 | 不设选项时 `inherit` | 避免改变已有 Host；限制开启才承诺 allowlist |
| D2 Pi native tools | `agentBuiltinTools: 'inherit' \| readonly PiBuiltinToolName[]` | 仅选择 read/grep/find/ls/edit/write/bash；空数组禁用全部 native tools；MCP 另行准入 |
| D3 用户资源 | `agentUserContext: 'inherit' \| 'excluded'` | excluded 禁用用户 extensions、skills、templates、themes、外部 context；保留登录能力。Agent home 内指令文件是否加载必须用显式 home loader，不能恢复全局扫描 |
| D4 SDK 扩展 | 用独立 `agentExtensions` 明确 web/subagent/todo 的集合；MCP 桥不在可关闭集合 | 不把 excluded 隐式解释成所有扩展都关闭。受限推荐配置显式选空集合，避免 web/subagent 绕开 native allowlist |
| D5 文件访问 | 单独设计 `agentFileAccess: 'inherit' \| 'home'` | home 模式拒绝 bash、subagent、任意用户扩展；承诺仅涵盖 SDK 托管的 native 文件工具，不涵盖 Host MCP、同 user 进程或网络 |
| D6 Claude/Grok | Claude 独立 native allowlist；Grok 独立 terminal 禁用开关 | 各 runtime 明确能力，不用一个抽象选项暗示相同安全保证 |

`agentUserContext: excluded` 的认证与资源来源须拆开：不能复制整个用户 agent 目录，也不能为此把 subscription token 放入一般进程环境。若 pinned Pi 不能独立指定凭据 store 和资源目录，S1 必须停在不支持的清晰错误，先定认证桥方案，不能静默回到全用户目录。

规模扩大十倍时，先遇到文件搜索遍历与 helper RPC 成本，而非工具集合大小。S1 只在 session 创建/恢复时构造有限集合；文件访问切片须单独规定遍历数量、返回字节和取消预算，不用递归全量收集来实现 grep/find。

## 交付切片与写入范围

### S1：Pi 普通 RPC 的工具与资源选择

范围：`adapters/pi/pi-adapter.ts`、`bin/pi-rpc-host.ts`、`bin/pi-session-runtime.ts`、恢复工具逻辑、对应测试与文档。

1. 本机 adapter 边界校验 options 并冻结有效策略；有 `agentRef` 才应用。prepared/durable lane 如不能执行所选限制，启动前明确拒绝，不静默忽略。
2. launch 升 v6；新 policy 参与现有 digest，helper 只接受 v6。不要双读 v5/v6。构造与消费的策略只有一个类型/校验权威。
3. user resource loader 与 SDK extension set 分开。有效 registry 包括选中的 native tools、选中的 SDK extension tools、task-admitted MCP 与 SDK helper。若保留用户 extensions，它们注册的工具也在能力面内，不能宣称严格的总工具白名单；要求严格集合时必须同时 excluded 用户资源并显式选定 SDK extensions。未知工具名报错，不推断近似名称。
4. 新建与 resume 都重建有效 registry；pending transcript 不能恢复被禁工具。若 pinned runtime 不能清空旧 pending 集合，拒绝这次 resume，并给出新建 session 的错误指引。
5. 明确本切片不限制所选 read/write 的路径；不能向下游声称 home-only，也不能关闭整个 issue。

### S2：Pi home 文件工具

范围：独立文件访问 authority、Pi 文件工具接入、native helper 平台实现与测试。必须先有 descriptor/API 设计，不能直接把 memory helper 改成任意命令执行器。

- 根来自有效 lease 的 `canonicalHome`，不是 cwd 字符串；lease 失效后拒绝所有访问。
- read/edit/write/grep/find/ls 均通过根绑定的文件 authority。拒绝外部绝对路径、`~` 外部展开、`..`、symlink/reparse traversal；新建路径也要验证父目录，不能仅对存在目标 realpath。
- 不能以 `realpath` 后普通 open 保证无竞态。必须复用或扩展 root-pinned descriptor/native helper 机制；缺 helper（包括 issue 指出的 macOS 打包场景）时 fail closed，并把所需 helper 纳入打包，不降级到不安全文件工具。
- 文件 authority 也必须拒绝多链接文件（在已打开 descriptor 上检查 link count），否则 home 内的 hard link 仍可能读写 home 外的同一 inode。该策略会拒绝合法 hard link；同 user 对手可并发建立链接的防护不属于本模式承诺，需要 OS 隔离才能覆盖，不能声称仅靠 link count 检查解决它。
- SDK memory authority 当前有专用目录、操作、审计与 CAS 规则；需设计通用文件 operations 的独立授权域，不能借 memory API 越权读写所有文件。
- Host MCP 工具由 Host 承担自身副作用授权；home 模式不能限制一个 Host 自己批准的任意文件/terminal MCP。产品说明必须陈述此边界。

### S3：Claude 与 Grok

- Claude：针对 qualified CLI 验证 native tool selection、MCP 保留和 resume；逐个列出仍可执行的 settings/hooks，不把 `agentUserContext` 当成防止本机代码执行的承诺。
- Grok：能力通告与 terminal callback 两处一致拒绝；若 ACP 不能从模型工具面移除 terminal，必须明确拒绝这一不受支持的契约，不能仅隐藏测试观察。
- Codex 维持现有 sandbox API，补明确其 root 与追加目录行为的说明；不在本 issue 引入新的 Codex 工具选项。

## 验收

每个切片使用 pinned runtime 和零费用 loopback provider；fake-only 测试不构成完整验收。记录版本、revision、策略 digest 和实际首次 tools 清单，不保存凭据。

- S1：在用户资源 excluded 且 SDK extensions 为空的受限配置中，Agent 首次请求只有选中的 native tools、task MCP、SDK helpers；禁止 bash/web/subagent 的调用无法执行。另测显式保留 extension 时增加的工具集合，不能仍宣称同一个严格集合。新建与 resume 均验证。无选项行为保持原样；非 Agent operation 不受影响；畸形配置、digest mismatch 与 unsupported lane fail closed。
- S2：每种文件工具覆盖正常 home 内操作、外部绝对路径、`~`、父路径、新建文件、symlink/reparse、hard link、根替换和取消。外部 sentinel 内容未改且目标文件不存在；三平台分别验证。helper 缺失、lease 失效时不得执行普通 fs fallback。
- S3：真实 Claude/Grok 协议证明禁用工具不会执行，MCP 仍按任务准入，resume 不恢复被禁能力。
- 公共 option/type 变更走 API surface 审核；不为通过检查改旧断言。构建、typecheck、相关测试与 required checks 按最终 head 留证，已有有效证据不重复重跑。

## 开工条件

边界评审与 D1–D6 确认已完成，owner 批准先实施 S1。S1 不提供 home-only，S2 缺 helper 必须拒绝这一取舍已明确；实现与真实 runtime 验收仍须分别完成。#1058 的 SDK MCP helper 授权独立处理，不默认放行 Host MCP。
