# #1061：显式授权的文件范围（设计 / 威胁模型）

> 状态：**design-only，decision-complete proposal，等待 owner 决定接口**。本文件不是 owner 已确认的合同，也不宣称任何实现、验收或隔离已经生效。本轮不修改产品代码、协议、docs/spec.md、测试或版本号。
>
> 基线：**origin/main@94d6fa5a9e182e9ef5429b4a25c80cffb527e621**（worktree **lane/1061-file-scope-design**）。
>
> 范围：issue #1061 的 suggestion 3「显式授权的文件范围」。suggestion 1（工具选择）、2（用户上下文、skills、扩展隔离）、4（各 adapter 的工具控制）不在本包内；本文件只在必要处说明它们的边界，不替它们做决定。

## 0. 结论摘要

1. **策略形状推荐 per-offer，而不是 adapter-wide。** 文件范围必须能随任务选择：同一个 Agent 的闲聊/资料整理任务默认只能读写 Agent home，用户显式授权的代码/自动化任务再加入 workspace。adapter-wide 选项会让共用 adapter 的所有 bot 任务一起被收紧，无法满足 issue 中「同一 Agent 的不同任务应能选择不同策略」。
2. **有效策略默认 inherit。** 未配置 fileScope 时行为完全不变；配置后，受限范围的默认值是 canonical Agent home 的读+写，额外 workspace 用独立的 read/write 授权表达，write 隐含 read。
3. **文件范围只在 auto 任务上有效。** all 的既有合同是「不阻止任何工具调用」；文件越界是硬拒绝，不能与 all 同时成立。两者同时出现应在准入前报错，不静默忽略。
4. **只有 SDK 自有的 scoped file tools 才能称为文件边界。** 用 Pi 的 tool_call hook 对原生 read/write/edit/find/grep/ls 做路径检查，能提供有用的 advisory gate，但它是 check-then-open，存在 TOCTOU 与 symlink 置换窗口，不能宣称「目标文件未被创建」这类保证。要满足 issue 的验收语义，应把六个文件工具换成 SDK 实现、使用 descriptor-relative 文件 authority（Linux /proc/self/fd，macOS/Windows 使用已发布 helper；参照 daemon/agent-memory.ts 的既有做法）。
5. **文件工具范围不是 shell sandbox。** 保留 bash/powershell 时，命令仍可读写宿主任意路径；MCP server、用户扩展和子代理的 shell 也一样。能力名、文档与错误信息不得暗示「home 隔离」「只读」「无法访问外部」。需要强隔离时，必须另配工具选择与 OS sandbox，不在本设计内假装提供。
6. **Pi 只支持 ordinary RPC lane。** prepared lane 没有 native file tools；durable Pi 未验证。两者遇到文件范围必须在 claim 前 decline，而不是丢掉范围继续跑。Claude/Codex/Grok/Hermes 本轮不设计实现，遇到策略同样 fail closed。
7. **子任务不得扩大父任务权限。** 原生 pi-subagents 的 foreground/background/nested/resumed child 必须加载同一份文件范围扩展并重新验证根身份；做不到就拒绝启动 child 或不提供 subagent，不能退回未 scoped 的内置文件工具。

## 1. 现状与问题

### 1.1 已观察到的代码边界

- packages/client/src/adapters/pi/pi-adapter.ts 的 **PiAdapterOptions** 只有 agentUserContext、agentSkillPaths、agentExtensionPaths、runtimeEnvironment 等资源/环境选项，没有文件范围选项。agentUserContext: excluded 的注释明确写着 isolates user resources; it never removes a tool。
- packages/client/src/bin/pi-rpc-host.ts 固定加载 web、BYOK MCP、subagent、todo 扩展；runPiSessionRuntime 接受 tools、excludeTools、noTools，但没有路径范围概念。
- packages/client/src/tool-authorization.ts 的 classifyToolCall 只做词法路径分类；workspace 是 daemon 的 grant，不是文件边界。文件头与 spec 都明确写着它是 tool gate，不是 sandbox，也不是 file-scope boundary。
- packages/client/src/agent-home.ts 已经提供 canonical home、homeIdentity（dev/ino）、writer lease 与 symlink/containment 校验；这是文件范围应复用的根身份来源，不是新的 home 设计。
- packages/client/src/daemon/agent-memory.ts 已有 descriptor-relative 文件访问：Linux 用 /proc/self/fd/DIRFD/child 逐段打开，O_NOFOLLOW；macOS/Windows 使用 SDK release helper；打开后拒绝 symlink、nlink > 1、非普通文件。这证明 canonical path + symlink + TOCTOU 在 Pi 文件工具层是可以被认真处理的，但 memory API 只能服务 memory 路径，不能直接改成通用文件 API。
- packages/client/src/adapters/pi/prepared-tools.ts 的 prepared lane 只注册 MCP 工具；packages/client/src/bin/pi-subagent-gate.ts 只把 auto gate 带进 child，没有文件范围。
- docs/spec.md 的 Tool authorization 末尾已声明：file-scope grants（additional workspaces、canonical-path enforcement）仍 open under #1061。

### 1.2 要防止什么

本设计把「模型可以决定工具参数」视为不可信输入。恶意或注入后的模型可以：

- 读取 Agent home 之外的绝对路径，例如 ~/.ssh/id_rsa、~/.aws/credentials、其他 Agent 的 home、宿主项目目录；
- 写入 Agent home 之外的路径，例如 ~/Library/LaunchAgents 下的 plist、~/.zshrc、/tmp 之外的持久位置；
- 用 ~、..、绝对路径或 symlink（包括悬空 symlink、mid-path symlink）绕过只看 cwd 的实现；
- 在 home 内创建 symlink 指向外部，再让后续 write/edit/read 穿过它；
- 读写 .byok 内部状态（lease marker、run 目录、结果暂存、审计），破坏 SDK 的权威记录；
- 在 Windows 用大小写、8.3 短名、junction/reparse point、UNC、ADS 或尾部点/空格绕过字符串比较。

### 1.3 不防止什么（必须写进产品说明）

- **不防止 shell。** bash/powershell 仍以 daemon 的 OS 用户身份执行，能访问该用户能访问的一切文件、网络与本地资源。
- **不防止 MCP server 与扩展。** Host MCP toolset、SDK web/todo/subagent 扩展、用户扩展可以有自己的文件副作用；文件范围只覆盖 SDK 接管的六个 native file tools。
- **不防止同 UID 进程。** 同一用户的其他进程可以读写、替换目录、注入或 ptrace；这不是 OS identity 边界。
- **不防止被攻陷的 runtime 进程。** 如果 Pi 进程本身执行攻击者代码，进程内检查没有意义；这需要 OS sandbox/容器。
- **不提供网络、凭据、进程或内核隔离。** 这些不在 #1061 suggestion 3 内。

### 1.4 为什么默认 home-only 仍然有价值

AiphaBee 的 bot 聊天、研究 pass、consolidate 都以 Agent home 为工作目录；它们需要 MEMORY.md、notes/ 和普通文件工具，但不应该因为网页/MCP 内容注入就读写用户主目录。默认 home-only 把「模型可触达的文件集」收缩到任务真正需要的工作集；授权代码任务再加入 workspace。它不是沙箱，但它把最常见的越界读写从「静默成功」变成「有类型错误、可审计、目标不产生副作用」。

## 2. 策略形状：A/B 与推荐

### 2.1 方案 A：adapter-wide 选项

在 **PiAdapterOptions** 增加一个全局文件范围（例如 agentFileScope），由创建 adapter 的 Host 固定；Pi host 读取后对所有任务生效。

- 优点：实现小，不需要 daemon 的每 offer 解析；不需要把新策略穿过 **RuntimeOperationStartInput**；只影响 Pi。
- 缺点：
  - 不能按任务区分。同一个 Agent 的闲聊与代码任务共用 adapter 时，只能全收紧或全放开；这与 issue 的「同一 Agent 的不同任务应能选择不同策略」冲突。
  - 下游明确说过「所有 bot 用同一个模式」，adapter 级开关会把所有 Pi bot 任务一起改变。
  - 直接构造 adapter 的 Host（#1095 场景）会形成第二个策略 authority，与 **DaemonConfig.toolAuthorization** 的本地策略分裂。
  - resume 仍然是 adapter 级，无法表达「这次 resume 换成当前任务的范围」。
- 结论：不推荐作为产品合同；只适合作为纯本地测试/单任务产品的快捷方式，且不应进入公共 API 的长期形状。

### 2.2 方案 B：per-offer 策略（推荐）

在现有本地策略文档上增加可选的文件范围，由 daemon 在 claim 前按 offer 解析、校验、复制冻结，并随 start input 交给 adapter；adapter 再把它写入 digest 绑定的 Pi launch 配置。运行中的任务与其 native subagents 使用同一份快照；每个新 offer（含 resume）重新解析当前策略。

- 优点：
  - 与 #1091/#1092 的规则同一条 authority、同一个 admission 时机、同一个「每次 offer 重新解析」语义。
  - 同一 Agent 的不同任务可以用不同范围；Host 不需要为每个任务创建新 adapter。
  - resume 可以收紧或放宽，且不会恢复历史授权。
  - 远端 offer 不能选择范围，避免 server/模型请求本机目录。
- 代价：需要新的 start input 字段、launch 版本、adapter/runtime 校验、审计与测试；这些正是本设计要锁定的内容。

**推荐 B。** 若 owner 认为 native helper/工具替换的成本不可接受，退路是 B'（per-offer + 仅 hook），但 B' 必须被命名和文档为 advisory gate，不能宣称文件边界，也不能用「目标文件未被创建」作为安全验收结论；issue 应保持 open。

### 2.3 候选类型（仅为讨论稿，命名与落点由 owner 决定）

以下形状用于把语义讨论清楚，**不是 owner 已确认的 API**：

~~~ts
type ToolFileAccess = 'read' | 'write';

interface ToolFileScopeRoot {
  /** 仅用于本地审计/展示；唯一、非空，不写入 wire；Host 不应放入秘密或真实路径。 */
  readonly id: string;
  /** 本机绝对路径；admission 时 canonicalize + 校验存在性，不是模型输入。 */
  readonly path: string;
  /** write 隐含 read。 */
  readonly access: ToolFileAccess;
}

interface ToolFileScope {
  /** home 始终是 read+write；workspaces 模式再追加显式 roots。 */
  readonly mode: 'home' | 'workspaces';
  /** 仅 workspaces 模式；至少一个，唯一 id，路径不得重复。 */
  readonly roots?: readonly ToolFileScopeRoot[];
}

interface ToolAuthorizationPolicy {
  readonly default: 'auto' | 'all';
  readonly byRuntime?: Readonly<Record<string, 'auto' | 'all'>>;
  readonly rules?: ToolAuthorizationRules;
  /** 仅当该 offer 解析出的有效 mode 为 auto 时合法。 */
  readonly fileScope?: ToolFileScope;
}
~~~

per-offer 解析器需要看到 lane，不能只看 runtimeId：

~~~ts
interface ToolAuthorizationTask {
  readonly taskId: string;
  readonly runtimeId: string;
  readonly agentRef?: AgentRef;
  /** 新增：同一 runtime 的 ordinary/prepared/durable 不能共用一个选择。 */
  readonly lane: 'rpc' | 'prepared' | 'durable';
  /** 新增：memory-reader 的 cwd 在 .byok/runs/TASKID，文件范围语义不同。 */
  readonly homeAccess: 'writer' | 'memory-reader';
}
~~~

这里有一个需要 owner 明确的产品/API 点：**现有 DaemonConfig.toolAuthorization 是纯数据策略**，配置文件只能表达 default、byRuntime、rules；它不能让配置文件按 taskId 写规则。若要真正实现「同一 Agent 的不同任务不同范围」，需要：

- B1：只提供静态 fileScope + byRuntime。实现简单，但同一 runtime 的所有任务共享范围，不满足 issue 的完整语义。
- B2（推荐）：保留静态 toolAuthorization 作为配置文件 fallback，另提供 embedded-only 的 per-offer resolver（函数；类似现有 providerProvisioning 的函数字段先例），在 claim 前返回 { mode, rules?, fileScope? }。配置文件不能设置函数，因此远程/纯配置文件 Host 仍得到静态语义。
- B3：把范围放进 offer/wire。**不推荐**：远端或模型可控的输入不能决定本机文件范围。

无论 B1/B2，解析出的对象都必须在 admission 复制并递归冻结；运行中的任务不读 Host 后续修改。

### 2.4 默认值与范围语义

- 未配置 fileScope：inherit。不改变现有行为，不改变 Pi 工具集，不新增拒绝。
- { mode: 'home' }：canonical Agent home 读+写。home 的路径与 identity 来自本次 offer 的 writer lease，不是 cwd 字符串，也不是 workspaceHint。
- { mode: 'workspaces', roots: [...] }：home 仍读+写；每个 root 按其 access 授权。write root 同时可读。
- 用户主目录 ~ 不会自动成为 root。~ 按 OS user home 展开；只有显式 root 覆盖时才允许。把 ~ 映射成 Agent home 会造成语义混淆，不采用。
- .byok 始终是 SDK 内部 namespace，文件工具在任何模式下都拒绝读写；memory helper、result helper、lease/audit 有各自 authority。MEMORY.md 与 notes/ 仍可读写（它们不在 .byok 下）。
- memory-reader 的 cwd 是 HOME/.byok/runs/TASKID。第一版建议对 reader offer 直接 decline file_scope_unsupported，直到单独设计 reader 的「run dir 可写、home 可读」语义；不要用 .byok 一刀切后让 reader 的相对路径全部失效，也不要悄悄把 reader 提升为 writer。
- 额外 workspace 必须在本机存在且是真实目录；这是 admission 条件（见 §3）。不提供「以后会创建」的 root，因为无法 pin identity。
- roots 可以嵌套（例如 home 下的某个项目）。若嵌套，宽范围授权不会被窄范围撤回；重复路径去重，冲突的 id 拒绝。若 owner 希望支持「父目录 read、子目录 write」这类降级，需要另定 most-specific-match 语义；本设计不引入。
- root 的 id 只用于审计和 Host 展示；真实路径不进 audit，root 路径也不进 wire。

### 2.5 优先级

从高到低：

1. **策略/admission 失败**：配置非法、root 不存在、root 身份无法确定、all + fileScope 冲突、lane 不支持 → 在 claim 前 decline（或构造期 DaemonConfigInvalidError，取决于失败点）；不启动 runtime。
2. **file scope 越界**：任何文件工具调用先过范围检查；越界是硬拒绝，不进入审批，不产生文件副作用。
3. **Always Ask**：范围允许后，按现有规则要求审批。
4. **sensitive-path floor**：范围允许后仍生效，例如显式 root 覆盖了 ~，读 .ssh 仍需人批；Allow 不能压掉它。
5. **Allow without Asking**：不能越过 file scope，也不能越过 floor。
6. **built-in classifier**：其余行为不变。

这条顺序意味着 **file scope 不是 ToolRule 的一种**，也不是可以被审批升级覆盖的 floor。需要临时访问范围外路径时，Host 改的是下一个 offer 的策略，而不是放行当前调用。这样可避免审批等待期间目标被替换/创建，也避免「一次放行」变成隐式持久授权。

如果 owner 希望 out-of-scope 调用也能走一次性审批，那是另一个产品决定；它会把「边界」降级为「默认拒绝的审批提示」，并重新引入 TOCTOU 与持久授权问题，本设计不推荐。

## 3. 路径安全

### 3.1 两个阶段，不能混为一谈

**Admission（daemon，claim 前）**：

- parseToolAuthorizationPolicy 只做纯语法校验：fileScope 对象形状、未知字段、mode、roots 数组、id 唯一/非空/长度上限、path 是绝对路径、无 NUL/换行、无 ~、无相对段。此阶段**不读文件系统**，保证 config check/embedded 解析无副作用。
- 单独的 resolveFileScopeGrant（daemon）在每次 offer 解析后执行：
  - 对 home：取本次 writer lease 的 canonicalHome 与 homeIdentity；路径必须等于 manifest 的 lease.canonicalHome。
  - 对每个 workspace root：realpath 规范化；必须是已存在的真实目录（root 自身不能是 symlink）；拒绝非本地卷/UNC（见 §3.4）；记录平台身份（POSIX dev+ino；Windows volume serial+fileId）。
  - 生成不可变 grant：{ mode, home: { path, identity }, roots: [{ id, path, identity, access }] } + policy digest。
  - 任一 root 不可用 → file_scope_unresolved pre-claim decline；不把范围降级成 home-only，也不把缺失 root 当成空 root。
- grant 随 **RuntimeOperationStartInput** 传给 adapter，adapter 校验 home.path === manifest.lease.canonicalHome；adapter 写入 launch 配置；Pi host 在创建 session **之前**重新打开并比对 identity，不一致就失败启动。

**Runtime（Pi host / SDK file tools）**：

- 不采用「先 realpath 再普通 open(path)」。这是 check-then-open，目标/父目录可以在两次调用之间被替换。
- 复用 agent-memory.ts 的 descriptor-relative 模式：先打开 root 目录并持有 descriptor，逐段用 /proc/self/fd/DIRFD/COMPONENT（Linux）或 helper 的 openat 等价物（macOS/Windows）打开下一段，每段 O_NOFOLLOW。最终文件同样 O_NOFOLLOW；读要求普通文件、单链接、字节上限；写用目录 fd 下的临时文件 + renameat（或平台 helper 的等价原子替换），不通过路径重新打开。
- 所有路径参数先做语法归一：string、非空、无 NUL/换行；~ 展开为 OS home（然后按 root 检查，通常会拒绝）；相对路径按 context.cwd 解析；path.resolve 后计算相对 root 的段；任何 .. 逃逸拒绝。不要相信模型给出的「已经在 home 内」。
- 写入前先确认父目录在 root 内，打开父目录 fd；目标已存在且是 symlink → 拒绝（不 follow）。创建新文件用 O_CREAT|O_EXCL|O_NOFOLLOW；临时文件失败时清理，目标文件保持原字节或不存在。
- edit 的 read-modify-write 必须基于同一个已打开 fd / 同一目录 fd；在替换前后校验 inode/mtime/size，避免把外部替换当成原文件。若平台 helper 无法提供原子的替换语义，就报 file_scope_unavailable，不退回 path-based 写入。

### 3.2 symlink、hard link、mount

| 情况 | 建议决定 | 理由/代价 |
| --- | --- | --- |
| root 自身是 symlink | 拒绝 file_scope_root_invalid | 配置歧义；canonical target 可以显式写出 |
| 目标或任一路径段是 symlink | scoped 模式一律拒绝 symlink | 简单、可证明；不会出现「先解析到内、再被换到外」；代价是 home 内合法的 symlink（如某些 node_modules/.bin）不可用 |
| 悬空 symlink | 拒绝 symlink | 不能把「不存在」当成新写入目标；父段悬空同样拒绝 |
| 目标 hard link（nlink > 1） | 写拒绝；读建议也拒绝 | 阻止 home 内 link 指向外部 inode；代价是合法 hard link 被拒。参照 memory authority 的既有选择 |
| root 内挂载点/跨设备 | 显式目标拒绝 cross_device；递归遍历跳过并审计 | 防止通过 mount 把范围扩到另一文件系统；跳过要可解释，不静默跟随 |
| 网络卷/UNC root | 拒绝 file_scope_root_unsupported | 身份、权限、原子替换和平台 helper 保证不足；需要时另立设计 |
| Windows reparse point/junction | 逐段以 reparse 语义打开并拒绝 | 不能只比较字符串；用最终 handle 的 volume/fileId 判定 |
| Windows 8.3 短名 | 用 handle 的最终路径与 fileId，不比较用户输入字符串 | 短名可以别名同一文件；字符串比较会漏 |
| Windows 大小写/尾点/尾空格/保留设备名/ADS | 拒绝非法组件；比较用 fileId（大小写不敏感） | 防止 file.txt.、file:stream、CON 等别名 |
| macOS 大小写/Unicode 规范化/Data 别名 | 比较 handle identity，admission 只用 realpath 做根规范化 | APFS 默认大小写不敏感；NFD/NFC 不能靠字符串 |
| Linux procfs 不可用（非 Linux、无 /proc） | 没有 helper 就不提供 scoped 模式，报 file_scope_unavailable | 不退回普通 fs 路径操作 |

### 3.3 TOCTOU 的明确立场

- **有 helper/descriptor authority 时**：从 root fd 到目标 fd 的解析与打开是一个受控序列；symlink 置换不能把后续操作重定向到 root 外。仍不防同 UID 进程在打开后修改同一 inode 的内容，也不防 runtime 进程被攻陷。
- **没有 helper 时**：不提供 scoped 模式。不允许「先 realpath 检查，再普通 fs 操作」作为降级；那会在文档上制造一个不存在的保证。
- **hook-only（B'）**：明确标注 check-then-open；在目标被并发替换时不能保证目标未被创建/未被写。验收不得把该场景当作 pass。

### 3.4 错误码与审计字段

建议把文件范围错误与现有 tool authorization 错误分开，Host 才能区分「范围拒绝」「adapter 不支持」「普通执行失败」：

~~~ts
type FileScopeDenialCode =
  | 'file_scope_denied'       // 调用被范围拒绝；turn 继续
  | 'file_scope_unavailable'; // 运行时 authority 不可用；fail closed

type FileScopeReason =
  | 'outside_scope' | 'symlink' | 'hardlink' | 'not_regular_file'
  | 'cross_device' | 'path_syntax' | 'cwd_outside_scope'
  | 'internal_path' | 'root_identity_changed' | 'unsupported_platform';

// pre-claim / 构造期：
type FileScopeConfigError =
  | 'file_scope_policy_invalid'
  | 'file_scope_unresolved'
  | 'file_scope_unsupported'
  | 'file_scope_conflicts_with_all';
~~~

语义：

- file_scope_denied：工具结果错误；不执行操作；任务/turn 继续。错误文本建议包含 code + reason + 模型自己给出的请求路径（不回显 canonical 路径或 root 路径），例如 file_scope_denied: path is outside the authorized file scope (outside_scope)。
- file_scope_unavailable：helper 不可用、root identity 在启动时变化、平台不支持、无法完成 descriptor 操作；fail closed，不产生副作用。
- file_scope_unsupported：adapter/lane 不能执行该策略；pre-claim decline 或 start 前失败，不创建进程、不落到未 scoped 的工具。
- file_scope_policy_invalid / file_scope_unresolved：配置或 root 解析失败；pre-claim decline，固定 wire reason 可沿用 tool_authorization_unresolved，若 Host 需要区分则新增 file_scope_unresolved: local file scope policy could not be resolved。
- file_scope_conflicts_with_all：all + fileScope；构造期报 DaemonConfigInvalidError，per-offer resolver 返回时 decline。

审计（本地，不进 wire、不进模型 prompt）：

~~~ts
interface FileScopeDecision {
  readonly taskId: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly decision: 'allow' | 'deny';
  readonly scope: {
    readonly source: 'host' | 'default';
    readonly mode: 'home' | 'workspaces';
    readonly digest: string;            // policy/grant digest
  };
  readonly rootId?: string;             // 命中的 root；home 用固定内部 id
  readonly access?: ToolFileAccess;
  readonly code?: FileScopeDenialCode;
  readonly reason?: FileScopeReason;
}
~~~

- 只记录 tool name、call id、task id、命中 root ID、access、code/reason、scope digest、decision；**不记录原始路径、canonical 路径、命令、文件内容或规则正文**。
- 允许的调用建议也记录（与现有 tool-authorization decision 的粒度一致）；若担心日志量，至少记录 deny 与 session 启动时的 policy adoption。owner 决定 D12。
- 新增本地 DaemonEvent（例如 kind: file-scope）与 daemon record；Host 可据此区分范围拒绝与普通工具失败。不要让 Host 只能靠错误文本猜。
- 子代理的审计字段带 nativeAgentId/parentToolCallId 时沿用现有 tool authorization 的约定；不新增 wire 字段。

## 4. 执行层边界

### 4.1 三层，不要混称

| 层 | 内容 | 本设计 |
| --- | --- | --- |
| 1. 工具面 | 哪些工具出现在模型请求里（shell/web/subagent/native file tools） | 不在本包；suggestion 1/2 与 #1103 |
| 2. 文件工具范围 | SDK 接管的 native file tools 能访问哪些根 | 本包 |
| 3. 执行层 sandbox | OS/容器/VM 对进程的文件、网络、内核约束 | SDK 不提供；Host 自备 |

- 文件范围只对第 2 层负责。保留 shell 时，第 2 层不能替代第 3 层；不要用「home-only」描述一个仍然能 cat ~/.ssh/id_rsa 的会话。
- 能力命名建议用 fileScope，不要放进 isolation 的既有字段里自动被读成「用户上下文隔离」。可新增 RuntimeCapabilities.fileScope?: { enforcement: 'scoped-file-tools' | 'advisory' }；省略 = 不支持。prepared/durable lane 明确不声明。
- 若 owner 选择 B'（hook-only），能力值只能是 advisory，文档和 UI 不得显示为「文件隔离」。

### 4.2 保留 bash/terminal 时的明确声明

- bash/powershell 不包装、不审计路径、不阻断命令；它们仍可访问文件、网络和宿主资源。
- auto 模式的高风险命令审批仍然存在，但那是 tool authorization 的 classifier，不是文件范围；Allow 规则、审批和 file scope 不互相替代。
- Host 若需要「任务不能读写 home 外任何文件」的产品承诺，必须同时：
  1. 通过工具选择关闭 shell/powershell 及任何文件能力的扩展/MCP；
  2. 提供 OS 级 sandbox（Landlock/bwrap/容器/VM 或平台等价物）；
  3. 不把本设计的 file scope 宣称为该承诺。
  这三步都不在本包内，不能用一个 fileScope 字段假装完成。

### 4.3 不支持的显式约束：执行前失败

- adapter/lane 不支持时，必须在 claim 前 decline（file_scope_unsupported），或在 start 前抛出非重试的 **RuntimeExecutionFailure**，且不 spawn runtime、不创建 session、不产生文件副作用。
- 不允许「忽略 fileScope 继续跑」「只把范围写进 prompt」「只从工具 schema 隐藏路径参数」。
- helper 缺失、root identity 变化、平台不支持、读取 launch 配置失败，都必须在第一个 provider 请求前失败；不能先让模型看到工具、再在第一次调用时报一个普通错误。
- 若 direct adapter 的调用方在 **RuntimeOperationStartInput** 里提供 grant，adapter 必须自己校验 lane/capability；不能相信调用方已经检查过。

### 4.4 子任务与扩展

- **原生 Pi 子代理**：pi-subagents 的 foreground/background/nested/resumed child 必须通过 registerRequiredChildExtensions 加载同一份文件范围扩展（不只是现有 byok-tool-authorization gate）。child 扩展从 0600 配置读取 scope + root identity，重新打开/验证，注册 scoped file tools；不要依赖继承父进程 cwd 或环境里的路径字符串。
- 若 child 扩展无法加载、child 的 cwd 不在任何 root 内、或 child 选择 external-cli/external-job/machine runner：拒绝启动 child；如果产品无法保证，则父 session 在 scoped 模式下不提供 subagent 工具（这是工具选择，不是静默降级）。
- **SDK 扩展**：web 不直接写文件；todo/subagent 有自己的落盘路径。它们不在文件工具范围内，必须逐个评估是否有任意文件写入能力；有则视为 out-of-scope，并在能力/文档中说明，不能靠 file scope 兜底。
- **Host MCP / 用户扩展**：它们的文件读写完全由自身授权；file scope 不拦截、也不审计。Host 若要求更强的总边界，必须同时限制这些工具，或把它们放进 OS sandbox。
- 任何 child 都不得把父任务的范围扩大；只能继承同一 grant 或更窄的 grant。子任务发起新的 offer 时按新 offer 的当前策略重新解析。

## 5. Pi 首次启动、resume 与其它 adapter

### 5.1 ordinary RPC lane：首次启动

1. daemon 解析 per-offer 策略，生成 frozen grant；校验 mode === auto、runtime pi、lane rpc、homeAccess === writer。
2. adapter 在 prepare()/start 校验 grant 与 manifest 的 lease.canonicalHome 一致，并要求 capabilities.fileScope 支持。
3. adapter 写 byok.pi.rpc-launch **version 9**（当前 v8），把 fileScope 与现有 agentUserContext/agentSkillPaths/agentExtensionPaths/toolAuthorization/mcp 一起放进 digest 绑定的 0600 配置。v8 与 v9 不双读：旧 host 遇到 v9 拒绝，新 host 遇到 v8 也拒绝；SDK 的 adapter 与 host 同版本发布。
4. Pi host 解析 v9，校验字段集合、绝对路径、identity、mode/roots 关系；在创建 extension/session 之前打开并验证每个 root；失败则 file_scope_unavailable，不创建 session。
5. host 注册 SDK scoped file tools（read、write、edit、find、grep、ls），并保证它们 shadow 同名的 Pi built-ins；bash/powershell 保持原生（是否出现由工具选择决定，不在本包）。
6. session 创建后、第一个 prompt 前，做 registry 断言：getAllTools() 的名字集合、active 名字集合、每个 scoped name 的来源必须是 SDK（不是 builtin:NAME），且不存在未知的 native file-capable tool；失败则 dispose 并报 file_scope_registry_drift（或 file_scope_unavailable），不发送 prompt。
7. 只在这些检查通过后发送初始 prompt。

**关键实现约束**：Pi 1.4.0 的 tool registry 会让 customTools 覆盖同名 built-in；但这个顺序是上游行为，必须有 pinned-version 的确认测试和上述来源断言。若上游改变优先级、或某个 file tool 无法被替换，必须 fail closed，不能接受「builtin 还在但模型没选它」这种伪保证。

### 5.2 ordinary RPC lane：resume

- 每个 resume offer 重新解析当前策略；不恢复旧 grant，不沿用旧 allow。
- 用新的 v9 launch 配置启动同一个 --session；Pi 可能从 transcript 恢复旧 tool loadout（包括 pending tools）。host 必须按 5.1 的 registry 断言重建/校正：
  - 旧 transcript 里的 built-in read/write/edit 不能被重新激活；
  - 旧 scope 的 root 不能因为历史工具闭包而继续可用；
  - 若 Pi 无法丢弃旧 pending tool 或恢复到当前期望集合，返回非重试的 file_scope_resume_unsupported，并给出「请新建 session」的指引；不能偷偷以未 scoped 状态继续。
- 缩小范围（例如上次有 workspace A，这次 home-only）必须在 resumed session 里真实生效；对 A 的调用应被拒绝，不能因为历史 session 文件而放行。
- 扩大范围也必须使用本次 grant 的新 root identity；旧 session 不会自动获得新 root。
- 首次请求与 resume 后的 provider request 都必须捕获工具集合（名字 + schema/描述 digest），不能只断言名字；见 §6。

### 5.3 prepared 与 durable lane

- **prepared**：prepared session 只注册 counted MCP tools，没有 native file tools（prepared-tools.ts）。若解析出的 fileScope 不为空，必须在 claim 前 decline file_scope_unsupported；不能把 fileScope 塞进 prepared launch，也不能让 prepared 任务在「无 native 文件工具」时假装范围生效。prepared 本来就不 resume。
- **durable Pi**：durable worker 的 respawn/frames 未验证，且 **PiAdapter** 目前只把 agent resources 限定在 ordinary RPC lane。durable + fileScope → claim 前 decline file_scope_unsupported。若以后要支持，必须单独定义 worker 的 root identity、respawn 后的重新验证与工具重放边界，不能复用本设计默认。
- 两个 lane 的拒绝必须发生在 adapter 启动前；prepare() 返回值/daemon decline 的错误码要能让 Host 区分「这个任务需要 fileScope，但该 lane 不支持」。

### 5.4 Claude / Codex / Grok / Hermes 的跨 adapter 边界

本包只设计 Pi ordinary RPC。其余 adapter 的现状不同，不能用同一个字段暗示同等保证：

| Adapter | 现状与边界 | 本设计的处理 |
| --- | --- | --- |
| Claude | 有 PreToolUse hook（auto gate），可覆盖 native/MCP/subagent；但 hook 是 check-then-execute，且 --dangerously-skip-permissions 下仍依赖 hook 合同 | 未设计 scoped file tools；若策略选中 Claude 且要求 fileScope，decline file_scope_unsupported。以后可在 hook 层做 advisory，或另行设计原生文件工具替换 |
| Codex | 有 sandbox（read-only/workspace-write/danger-full-access/inherit）与 writable roots；它不是「六个 file tool 的路径白名单」 | 不把 Codex sandbox 伪装成 fileScope；未设计映射，遇到策略 decline。以后可评估 workspace-write + writable roots 的语义，但仍需说明 read 侧与 shell 的差异 |
| Grok | 只有 client-hosted terminal 经 SDK；Grok 自有文件工具不受 SDK 控制 | 无法执行 fileScope，decline file_scope_unsupported；不能只隐藏 terminal |
| Hermes | 没有 pre-execution hook | decline file_scope_unsupported |

跨 adapter 的不变量（建议写进未来的 spec）：

- 同一个本地策略对象可以按 runtime 选择，但每个 runtime 必须显式声明是否支持 fileScope 及其 enforcement 级别；省略 = 不支持。
- 不支持时在 claim 前 fail closed，不能退回未 scoped 的执行。
- fileScope 永不由 wire/offer/model 选择；不进入 native settings 或 prompt。
- 任何 runtime 的 child/subagent 不得扩大父任务范围。

### 5.5 直接构造 adapter 的 Host（#1095）

- grant 必须走 per-offer 的 **RuntimeOperationStartInput**，而不是 **PiAdapterOptions**，这样内嵌 Host 与 daemon 使用同一条路径；省略 = inherit。
- 不给 adapter-wide 的默认文件范围；否则会出现「daemon 策略」与「adapter 策略」两个 authority，且直接构造 adapter 的 Host 可以绕过 daemon。
- #1095 的 runtime environment 策略是另一个维度（环境变量），不要把它和 fileScope 合并成一个 policy 对象；两者可以分别落在 start input / adapter 构造参数上，但语义独立。

## 6. 验收矩阵

验收使用 pinned Pi 与零费用 loopback provider；参考现有 packages/client/src/__tests__/pi-tool-authorization.test.ts 的真实 Pi 工具管线（不要用 mock 代替真实执行）。每个用例记录：Pi 版本、launch digest、scope digest、provider request 的工具集合 hash、实际文件副作用、错误码、审计字段。测试不得只断言工具名。

| ID | 场景 | 操作 | 期望 |
| --- | --- | --- | --- |
| F1 | 未配置 fileScope | 普通 Pi offer（含带 agentRef） | 工具集与行为与基线完全一致；不出现新的拒绝/审计；provider request 的 tools 集合不变 |
| F2 | home-only 首次请求 | 真实 Pi + loopback | 首次 provider request 的 tools 名字与 schema digest 等于期望集合；六个 scoped file tools 的来源是 SDK，不是 builtin；bash 是否出现按工具选择断言 |
| F3 | home 内正常读写 | read MEMORY.md、write notes/x.md、edit notes/x.md | 成功；真实字节写入；内容可由测试读取验证；不产生越界副作用 |
| F4 | 未授权绝对路径读 | read('/etc/hosts') 或 home 外 sentinel | file_scope_denied/reason outside_scope；内容未返回；turn 正常结束 |
| F5 | 未授权绝对路径写 | write('/tmp/...') 或 home 外路径 | file_scope_denied；目标文件不存在；父目录无临时残留；sentinel 未改 |
| F6 | ~ 与 .. | read('~/x')、write('../outside') | 按 OS home 展开后越界 → outside_scope；不把 ~ 重映射到 Agent home |
| F7 | symlink 越界 | home 内 link -> /tmp/outside；mid-path symlink；dangling symlink | 拒绝 symlink；不读/不写外部目标；外部 sentinel 不变；不创建目标 |
| F8 | 显式 workspace | 配置 { mode:'workspaces', roots:[{id:'repo', path:W, access:'write'}] } | W 内 read/write/edit 成功；W 外仍拒绝；真实内容写入 W |
| F9 | 只读 workspace | root access:'read' | 读成功；写/编辑拒绝 outside_scope（或专用 write_denied，owner 定），目标不创建；不进入审批 |
| F10 | .byok | read('.byok/agent-home.lease')、write('.byok/x') | 拒绝 internal_path；lease/结果文件不被改 |
| F11 | 敏感路径 floor | 显式 root 覆盖 home 后 read('.ssh/...')（合成 fixture，不读真实凭据） | file scope 允许后仍触发 floor/审批；Allow 不能压掉 |
| R1 | resume 使用当前策略 | 先 workspace A 启动，resume 时改为 home-only | resume 后的 provider request tools 与行为按新策略；对 A 的读写拒绝；旧 session 不恢复旧 root |
| R2 | resume 工具集一致 | 同一策略 resume | 首次与 resume 的 provider request tools 名字 + schema digest 一致；active/registered 集合一致；没有旧 pending builtin 复活 |
| R3 | resume 不可恢复 | 旧 transcript 含无法丢弃的 pending builtin | 启动前/首次请求前失败 file_scope_resume_unsupported，不发送 provider 请求、不执行工具 |
| U1 | prepared | prepared offer + fileScope | claim 前 decline file_scope_unsupported；不 spawn、不创建 session |
| U2 | durable | durable Pi + fileScope | claim 前 decline；不 spawn worker |
| U3 | helper 缺失/identity 变化 | 移除 helper 或替换 root | 启动前 file_scope_unavailable；不降级为普通 fs；不产生副作用 |
| U4 | 非法策略 | 相对 root、symlink root、不存在 root、重复 id、all + scope、未知字段 | 构造期/pre-claim 错误；不启动 runtime；错误可区分 |
| S1 | 原生子代理 | foreground/background/nested child 调 home 外 read/write | child 加载同一 scope；越界拒绝；外部 runner 被拒绝；不得出现未 scoped builtin |
| S2 | 子代理 cwd 越界 | child 的 cwd 不在 root 内 | child 启动被拒绝；不把 cwd 悄悄改成 root |
| S3 | 用户扩展/MCP | 保留一个能任意读文件的扩展/MCP | file scope 不声称拦截它；能力/文档明确 out-of-scope；不把其成功当作 file scope 失败或通过 |
| A1 | 审计 | 越界拒绝 | 本地 file-scope 事件含 task/call/tool、decision、rootId、access、code/reason、scope digest；不含原始路径/命令/内容 |
| A2 | Host 区分 | 三种失败 | policy deny 是 file_scope_denied；unsupported 是 pre-claim file_scope_unsupported；普通 IO/helper 失败是 file_scope_unavailable 或普通工具错误，三者不混淆 |
| B1 | shell 诚实性 | home-only 且保留 bash，bash cat /etc/hosts | 仍可读（记录为已知边界），不得把该用例写成 file scope 通过；若工具选择关闭了 bash，则断言不出现/不能执行 |
| B2 | 平台 | macOS/Linux/Windows（或 CI 对应 runner） | 大小写、短名、junction/reparse、UNC、ADS、尾点等按 §3 拒绝；不能只跑 win32 路径函数模拟就宣称平台验收 |

验收命令（实现 PR 使用；本设计 PR 不运行产品测试）：

~~~sh
bun run build
bun run typecheck
bun test packages/client/src/__tests__/pi-tool-authorization.test.ts
bun test NEW_SCOPED_FILE_TOOLS_TEST_FILES
bun run check:api-surface
bun run check:version-authority
bun run check:upgrade-manifest
~~~

真实 Pi 用例至少覆盖：首次请求、resume、home-only 拒绝、显式 workspace 成功、symlink 拒绝、目标不存在、审计字段；并用实际文件系统副作用（目标文件是否存在、sentinel 是否变化、写入内容）证明，而不是只看工具名或 mock 调用。

## 7. Owner 决策点

以下全部**待 owner 决定**，不是 owner 已确认项。推荐列只是本设计的建议。

| 编号 | 决策 | 推荐 | 不选/替代的后果 |
| --- | --- | --- | --- |
| D1 | 策略形状：per-offer vs adapter-wide | per-offer（§2.2） | adapter-wide 无法按任务区分，所有 bot 任务一起变；direct adapter 形成第二 authority |
| D2 | 执行层：SDK scoped file tools vs hook-only | scoped file tools（B）；hook-only 只能叫 advisory | hook-only 有 TOCTOU/symlink 置换窗口，不能承诺「目标未创建」；issue 应保持 open |
| D3 | 与 all 的关系 | fileScope 只在 auto 有效；all + scope 报错 | 若允许 all + scope，就改变了「all 从不阻止」的既有合同，需要改 spec 与所有 adapter 的语义 |
| D4 | scoped 的默认范围 | home 读+写 | 若默认空（只允许显式 workspace），聊天任务无法读写 MEMORY/notes，需要下游额外授权 |
| D5 | 额外 workspace 形状 | id + path + access（read/write），write 隐含 read，root 必须存在 | 允许不存在的 root 会无法 pin identity；read/write 不分开无法表达只读 workspace |
| D6 | .byok 与 reader | .byok 永久拒绝；reader 首版 decline | 放开 .byok 会让模型改 lease/结果；强行为 reader 设计会扩大本包 |
| D7 | symlink 策略 | scoped 模式一律拒绝（含 in-root） | 允许 in-root symlink 需要 resolve+pin，增加竞态面；代价是合法 symlink 不可用 |
| D8 | hard link / 跨设备 / 网络卷 | 写拒绝 nlink>1；显式跨设备拒绝；网络卷 root 拒绝 | 不拒绝会给出可绕过的路径；拒绝会牺牲部分合法布局 |
| D9 | 越界是否可审批 | 硬拒绝，不走审批 | 可审批会把边界降级为提示，并引入等待期间的目标置换与持久授权风险 |
| D10 | 不支持 lane/adapter | claim 前 file_scope_unsupported | 静默忽略会让 Host 以为范围生效；运行中失败会浪费已 claim 的任务 |
| D11 | 子代理继承 | 必须加载 child scope 扩展；否则不提供 subagent | 不继承则子任务成为明确的越权路径 |
| D12 | 审计范围 | deny + policy adoption 必记；allow 可配置/采样 | 只记 allow 或只记 deny 都会让 Host 无法解释行为；全量 allow 可能有日志量 |
| D13 | per-task 选择入口 | embedded-only resolver（B2），配置文件仍静态 | 只做 byRuntime 无法满足「同一 Agent 不同任务」；把函数放进 JSON schema 不可行 |
| D14 | launch 版本与 helper | v9；helper 缺失 fail closed；不双读 v8 | 不升版本无法把 root 身份带到 runtime；双读会让旧配置绕过新校验 |
| D15 | 类型落点/命名 | ToolAuthorizationPolicy.fileScope 或独立 DaemonConfig.fileScope，由 owner 定；本设计不锁定 | 落点影响 config schema、api-surface 与 upgrade-manifest；先定一个 authority |

## 8. 迁移与 upgrade-manifest 影响

本设计本身不改版本、不改生成物。若 owner 选择 B 并按本设计实现，预计影响：

- **配置 schema**：若把 fileScope 加进 toolAuthorization，packages/client/daemon-config.schema.json 的 config:toolAuthorization 项 digest 变化；若独立成 DaemonConfig.fileScope，新增 config:fileScope 项。旧配置不带新字段 → 行为不变，**additive**。
- **公开类型**：ToolAuthorizationPolicy、ToolAuthorizationTask、RuntimeCapabilities（若新增 capability）、可能的 ToolFileScope/FileScopeDecision 会改变 api-surface golden；对应 export:@byok-sdk/client#... 项。若 ToolAuthorizationTask 新增必填 lane 会破坏自定义 resolver 的类型兼容；建议做成可选或新增独立字段，owner 定。实现 PR 必须同时跑 check:api-surface、check:upgrade-manifest。
- **Pi launch**：byok.pi.rpc-launch 从 v8 到 v9；它是 SDK 内部 digest 绑定格式，不进入 server wire；adapter 与 host 同版本发布，不提供 v8/v9 双读。旧 daemon + 新 host 或反之都不应被支持；升级说明要写「同版本升级，不混装」。
- **协议/能力**：若新增 RuntimeCapabilities.fileScope，RuntimeCapabilitiesSchema 与 conn.hello/task.claim/presence 是 additive；按 #1103 的 runtime × lane 能力矩阵公开。旧 daemon 省略该字段 = 未知/不支持；Host 不能把未知当支持。若 owner 不想改 wire，也可先只做本地 capability/descriptor，但 Host 就无法在派工前选择，建议至少本地暴露。
- **helper/打包**：B 需要通用文件 authority 的 native helper（macOS/Windows），并可能新增发布二进制/资产条目（bin:、native asset pin）；Linux 可复用 procfs 路径。若产品（例如 macOS 打包版）不带该 helper，scoped 模式必须报 file_scope_unavailable，不能降级；这会直接影响该产品是否能启用本功能。owner 需要决定是否把 helper 纳入打包与 release 资产。
- **store/DB**：无新 store、无 SQLite/Postgres schema 变化；不需要 acceptance 迁移。策略只在 daemon 内存与 launch 配置中存在，不写入 Agent home。
- **版本 authority**：本设计不改 package.json/版本；实现若为 additive，按 release authority 走 MINOR；不要在本分支改版本号。
- **upgrade manifest 条目建议**：id: tool-file-scope-policy，impact: additive，summary 描述「可选 fileScope；默认 inherit；仅 auto；Pi ordinary RPC；prepared/durable/其它 adapter 遇到时 fail closed」，migration 指向未来的 spec anchor（实现 PR 再写），items 由生成器按实际 changed 项列出（至少 export:@byok-sdk/client#ToolAuthorizationPolicy、RuntimeCapabilities，以及 config 项）。不要现在手写 manifest。

## 9. 剩余风险与不声称

- 即使 B 落地，**shell/MCP/扩展/子代理 shell 仍可越界**；file scope 只保护六个 SDK 文件工具。不能对外说「home-only 任务不能访问外部文件」。
- **同 UID 进程**可以替换目录、制造 symlink、修改已打开文件；descriptor authority 防的是路径重定向，不是同用户攻击。
- **runtime 进程被攻陷**后，进程内检查无效；需要 OS sandbox。
- **Pi 上游工具面变化**（新增 file-capable builtin、名字冲突、customTools 覆盖顺序变化）需要 pinned-version 的 conformance test；升级 Pi 时必须重跑，否则 fail closed。
- **平台 helper 的证明范围**：Linux procfs、macOS/Windows helper 各有部署/卷/恢复限制；本设计只要求「fail closed 或可用」，不把 helper 的既有安全声明扩展到任意文件系统。
- **Windows 文件身份**：必须用 handle/volume file ID，不能用字符串大小写折叠冒充；没有 Windows runner 的本地 probe 不能当作平台验收。
- **reader lane**、**prepared/durable**、**Claude/Codex/Grok/Hermes** 的 fileScope 能力本轮明确不实现；不要让 Host 误以为所有 runtime 都支持。
- **本设计没有运行真实 Pi、没有跑产品测试、没有修改 spec**；所有验收条目是实现 PR 的目标，不是本 PR 的证据。

## 10. 参考

- issue #1061（suggestion 3、验收、AiphaBee 更新）：https://github.com/Ancienttwo/byok-sdk/issues/1061
- #1091（ToolRule 设计）与已合入的 #1092（rules 实现）：https://github.com/Ancienttwo/byok-sdk/issues/1091
- #1095（runtime environment）：https://github.com/Ancienttwo/byok-sdk/issues/1095
- [Tool authorization spec](../spec.md#tool-authorization-auto-and-all-1061)
- [Durable Agent homes spec](../spec.md#durable-agent-homes)
- [Layered architecture](../architecture/layered-architecture.md)
- 代码：packages/client/src/adapters/pi/pi-adapter.ts、packages/client/src/adapters/pi/prepared-tools.ts、packages/client/src/adapters/pi/subagents.ts、packages/client/src/bin/pi-rpc-host.ts、packages/client/src/bin/pi-session-runtime.ts、packages/client/src/tool-authorization.ts、packages/client/src/agent-home.ts、packages/client/src/daemon/agent-memory.ts
