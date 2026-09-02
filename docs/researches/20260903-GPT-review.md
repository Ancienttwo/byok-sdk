# 架构审查结论

本次审查固定在：

* `Ancienttwo/byok-sdk@4cc765fe1bf0509496f298a50188476329b440cb`
* `Ancienttwo/RAFT-study@1737475a83f36127c668a4853e470530f770b0e8`

当前 `byok-sdk` 基线已经包含 Agent provider profile 精确绑定、凭证隔离、Agent-home、fresh session、可靠 egress 等较新的能力，因此下面不会把早期已经修复的问题重复当作现存缺陷。

## 总体判断

**项目方向正确，不应该推倒重写。**

当前最有价值、也最难重做的部分已经具备：

* 用户本机执行，Claude/Codex 原生登录继续由厂商 CLI 持有，BYOK 不读取或转发凭证。
* Pi 的 provider profile 与 secret custody 独立。
* Agent 是长期主体，任务只是 Agent 的一次运行。
* exact device、exact AgentRef、profile revision、session handoff 与 cwd 绑定。
* claim 前生成不可变 operation manifest。
* fresh session 与 exact resume 已拆成不同协议路径。
* egress、content read、terminal result 均有显式 policy 和 capability gate。
* hosted cloud 是 stateless handler + durable store，不靠进程内 `Running/session map` 维持权威状态。

这些都符合一个可嵌入 Local Agent SDK 应有的安全边界。

但是，目前仍然存在四个需要在 1.0 前解决的架构问题：

1. **对外领域模型仍以 Device / Task 为主，而不是你定义的 Computer / Agent / Session。**
2. **同一个 Agent home 允许不同 session 并行写入，与“单一 mutable writer”原则矛盾。**
3. **“中间态只留本地”目前只是默认 policy，不是服务端可验证的硬约束。**
4. **节省云端沙箱成本成立，但不能等价为“不再需要任何执行隔离”。**

因此，正确策略不是“大重写”，而是：

> **保留现有协议、安全、可靠性和数据平面；重组领域模型、Workspace 并发边界、数据分级与公开 SDK surface。**

---

# 一、社区调研结论

目前没有一个成熟开源方案可以直接覆盖：

> 用户设备配对 + 用户本地订阅登录 + 多 Computer/Agent/Session + 长期 Agent home + 本地中间态 + 云端结果投影 + SaaS 多租户控制面。

更现实的方案是组合多个成熟模型，而不是寻找一个完整替代品。

| 社区方案                                     | 成熟能力                                                                          | 对 BYOK SDK 的价值                                                               | 不应承担的职责                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Agent Client Protocol（ACP）**           | JSON-RPC、session new/resume、prompt、stream update、permission、cancel；当前稳定协议为 v1 | 可作为 Local Host ↔ Runtime Adapter 的标准化接口，降低 Codex/Claude/Pi adapter 差异        | 不负责 SaaS tenant、设备配对、任务租约、结果持久化                                   |
| **Microsoft Agent Host Protocol（AHP）**   | 多客户端同步同一 Agent session；immutable state、pure reducer、reconciliation            | 借鉴 Session read model、多 UI 同步、断线重放                                           | 不应成为原始 transcript 上云的理由，也不替代底层 runtime protocol                   |
| **Buildkite Agent**                      | 本地 agent 主动向云端取任务；agent token → session token → job token；短期单任务 JAT           | 非常适合借鉴 Installation session、Attempt token、lease/fencing 与 outbound-only 工作模式 | Buildkite 的 job 是短暂 runner，不具备长期 Agent memory/session 语义          |
| **GitHub self-hosted runner**            | labels/groups 匹配、任务排队、ephemeral one-job runner、outbound 连接                    | 借鉴 capability-based placement、exact assignment 和离线排队                         | 持久 runner 的安全模型不能直接复制到个人主机                                        |
| **Codex / Claude programmatic surfaces** | Codex 本地 CLI/SDK；Claude SDK 可作为 subprocess、支持 stream JSON 和 session resume    | 每个 runtime 应使用厂商原生机器接口，避免解析面向人的终端文本                                          | 不应抽取、镜像或重新托管用户登录凭证                                                |
| **MCP**                                  | tools/resources/prompts、capability negotiation、host-controlled permission     | 继续作为本地工具集和 connector layer                                                   | MCP 不是 Computer scheduler、Session store 或 workload lease protocol |
| **Development Containers**               | 开放的开发环境描述规范                                                                   | 可作为可选的 Workspace isolation profile                                           | 单独一份 `devcontainer.json` 不是完整安全边界                                 |

ACP 当前明确区分 Agent 与 Client，并提供 session lifecycle、streaming、permission 和 cancel，适合作为本地 adapter SPI。([GitHub][1])

AHP 解决的是 ACP 上层的多客户端、共享 session 状态和 reconciliation；其官方文档也明确把 AHP 定义为协调层，把 ACP 定义为一对一通信层。([GitHub][2])

Buildkite 的 agent 主动通过 HTTPS 轮询工作，不要求对本地机器开放入站端口；它的长期 agent token、连接期 session token 和单 job token 分层，以及短期、单任务 JAT，非常适合作为 BYOK `Installation → Connection → Attempt` 凭证层级的参考。([Buildkite][3])

GitHub 则明确建议自动扩缩时采用 ephemeral self-hosted runner，并警告持久 self-hosted runner 可能被不可信 workload 持久化攻陷。这个警告对“把 SaaS prompt 放到个人电脑执行”的产品尤其重要。([GitHub Docs][4])

Claude 官方 SDK 已提供 subprocess、stream JSON、AbortController 和 session resume；Codex 也已有本地 CLI/SDK、ChatGPT 登录与系统级 sandbox 能力。运行时适配应优先绑定这些原生 surface，而不是依赖终端文案。([Claude Platform Docs][5])

MCP 应继续负责 context/tools，而不是承担 workload orchestration。Dev Containers 则适合做可选的环境描述和隔离组合。([Model Context Protocol][6])

---

# 二、需求吻合度

| 你的需求                           |         当前状态 | 审查判断                                                                                              |
| ------------------------------ | -----------: | ------------------------------------------------------------------------------------------------- |
| 使用用户已经登录的 Claude/Codex         |     **基本满足** | `subscription lane` 明确由厂商 CLI 持有认证，BYOK 不读凭证，这是正确边界。                                              |
| 使用内置 Pi Agent 和用户 provider key |       **满足** | Pi、provider profile、OS secret store 与 dispatch graph 分离得较好。                                       |
| SaaS 不必为每个用户部署云端沙箱             |  **满足，但有条件** | 计算成本转移到用户设备；执行隔离、安全责任和资源治理也一起转移到了用户设备。                                                            |
| 以 Computer、Agent、Session 为单位   |     **部分满足** | Agent 已是一等对象；Computer 仍混杂于 `deviceId`、`machineId`、`MachineInfo`；Session 仍主要是 opaque `sessionRef`。 |
| 多任务并行                          | **部分满足且有风险** | 不同 Agent home 可以安全并行；同一 Agent 的不同 session 当前可以共享同一 mutable cwd 并行，存在文件竞争。                         |
| 云端有限度保存结果导向上下文                 |     **部分满足** | 已有 `TerminalResult.document/summary/artifactRefs`，但尚无有版本的 result-context reducer/CAS。             |
| 中间态只保留在本地                      |    **条件性满足** | 默认 metadata/status 比较符合，但 contentful activity、transcript/workspace read 和 memory projection 均可上云。 |
| 可集成的开源组件                       |     **部分满足** | 内部层次合理，但公开 integration surface、package 数量、版本文档和 legacy dispatch 面仍较复杂。                            |

---

# 三、P0：同一 Agent home 的并行写入边界有问题

这是当前最明确的架构风险。

当前 spec 同时声明：

* canonical Agent home 是 runtime 的唯一 cwd；
* 同一 Agent 的不同 `sessionRef` 可以并行执行；
* 只对 SDK-owned shared metadata mutation 做短暂的 per-home serialization。

但本地存储责任文档和 README 又把 Agent home 描述成“one mutable writer”边界。

实现中的 execution lease 主要按 `(agentId, sessionRef)` 排他，而不是对整个 Agent home 排他；因此不同 session 可以同时拿同一个 home 当 cwd。

这会造成几类实际竞争：

* 两个 runtime 同时修改 `MEMORY.md` 或 `notes/`。
* 两个 coding session 同时修改相同源码。
* 共用 `.git/index`、lock file、build output、package-manager state。
* 一个 session 读取到另一个 session 尚未完成的半成品。
* 两个 session 各自成功，但最终 Agent home 状态不可解释。

## 正确重组

必须把三个概念拆开：

```text
AgentHome
  长期 Agent identity、memory、profile projection
  默认单一 mutable writer

Workspace
  一次或一组代码/文档任务的实际工作目录
  每个 mutable Workspace 单一 writer

SessionState
  native provider session locator、session WAL、resume evidence
  同一 Session 的 turn 严格串行
```

建议目录：

```text
<hostStorageRoot>/
  agents/<agentId>/
    MEMORY.md
    notes/
    profile.json
    .byok/
      agent-state/
      result-outbox/
      sessions/<sessionId>/

  workspaces/<workspaceId>/
    checkout-or-project-files
```

并发规则应固定为：

| 场景                              | 行为                                                        |
| ------------------------------- | --------------------------------------------------------- |
| 同一 Session 两个 Run               | FIFO 串行，或第二个返回 `session_busy`                             |
| 不同 Session、同一 mutable Workspace | claim 前拒绝                                                 |
| 不同 Session、不同 Workspace         | 允许并行                                                      |
| 同一 repo 需要并行                    | 使用 git worktree、COW clone、container volume 或 VM workspace |
| Agent memory 回写                 | terminal 后通过显式 CAS/reducer 合并，不允许 runtime 任意并发改写          |

换句话说：

> **Agent 可以并行，Session 可以并行，但 mutable Workspace 不能多写者并行。**

目前把 Agent home 同时当“长期 memory root”和“所有任务直接 cwd”，是导致矛盾的根源。

---

# 四、P0：Computer 与 Session 还不是一等领域对象

当前云端主要权威对象是：

* `DeviceRecord`
* `TaskAttempt`
* `AgentRef`
* `TerminalResult`

`DeviceRecord` 中有 `deviceId`，另有可选的 client-hashed `machineId`；`TaskAttempt` 以 `taskId` 为主键并绑定 `deviceId` 和可选 `agentRef`。

这并不等于你的产品模型：

```text
Computer
Agent
Session
```

## 当前混淆

### Computer 被拆成了几个不完全相同的概念

* `machineId`：物理机器的 client hash。
* `deviceId`：某产品下的一次 enrollment/auth identity。
* `MachineInfo`：server 暴露的连接和 runtime observation。
* daemon process：当前常驻服务实例。
* RAFT Computer：机器、service、supervisor、update 和 readiness 的产品层对象。

其中真正适合作为 auth 和 capability 载体的是 **Installation/Enrollment**，而不是 Computer。

### Session 只是任务属性

`sessionRef` 会在 offer、handoff 和 terminal 中传递，但云端没有真正的 Session aggregate：

* 没有 Session owner。
* 没有 Session status。
* 没有 Session → Workspace binding read model。
* 没有 Session context version。
* 没有 Run history。
* 没有 Session migration authority。

Hosted cloud 明确禁止 process-local session map，这是正确的；但仍应有一个**持久化 Session store**，而不是完全没有 Session domain。

## 建议的标准领域模型

```text
Tenant
  └── Computer
        └── Installation
              └── Agent
                    └── Session
                          └── Run
                                └── Attempt
```

### 1. Computer

产品可见的逻辑机器：

```ts
interface Computer {
  computerId: string;
  displayName: string;
  platform?: string;
  ownerTenantId: string;
}
```

Computer 不直接承担 bearer credential。

### 2. Installation

一个 SaaS 产品在一台 Computer 上的 Local Agent enrollment：

```ts
interface Installation {
  installationId: string;   // 现 deviceId 应迁移到这个语义
  computerId: string;
  productId: string;
  capabilitiesRevision: string;
  connectionEpoch: number;
  status: 'offline' | 'idle' | 'busy' | 'degraded';
}
```

认证、公钥、revoke、capabilities、daemon release 都归 Installation。

### 3. Agent

长期主体：

```ts
interface AgentRef {
  agentId: string;
  profileRevision: string;
}
```

当前这一层已经做得比较好。

### 4. Session

长期对话和 Workspace binding：

```ts
interface Session {
  sessionId: string;
  agentRef: AgentRef;
  installationId: string;
  workspaceRef: string;
  runtimeRef: string;
  contextVersion: number;
  status:
    | 'idle'
    | 'running'
    | 'awaiting_approval'
    | 'interrupted'
    | 'closed'
    | 'failed';
}
```

厂商原生 session ID 可以继续只留本地；云端 `sessionId` 是 SaaS/SDK 的 opaque identity，本地保存：

```text
sessionId -> providerNativeSessionLocator
```

### 5. Run

一次用户请求或一次 Agent turn：

```ts
interface Run {
  runId: string;
  sessionId: string;
  baseContextVersion: number;
  requestedAt: string;
}
```

### 6. Attempt

Run 在某 Installation 上的一次实际执行：

```ts
interface Attempt {
  attemptId: string;
  runId: string;
  installationId: string;
  leaseEpoch: number;
  status: AttemptStatus;
}
```

重试时：

```text
同一个 runId
新的 attemptId
新的 leaseEpoch
```

这样才能区分：

* 用户逻辑请求；
* 网络或设备导致的重试；
* 哪一个 Attempt 有权写 terminal；
* 哪一个旧进程已经失去 authority。

## 当前 exact placement 的优缺点

Hosted strict Agent API 已要求调用者显式传入 `deviceId`，这一点应保留。

但 reference server 的通用 `DispatchInput.deviceId` 仍然可选，公共 `dispatch()` 因而仍保留 ambient device selection。

建议：

* 新主 API 只接受 `installationId`。
* ambient selection 下沉为显式 `placementPolicy`。
* strict Agent/Session API 不允许静默 fallback 到其他设备。
* reference server 的 legacy `dispatch()` 移入兼容 subpath，避免继续成为推荐用法。

---

# 五、P0：“中间态留在本地”目前不是硬不变量

当前设计并非严格的 local-only。

它允许：

* metadata/status activity。
* contentful trajectory。
* bounded cloud ActivityTail。
* workspace/transcript/artifact content read。
* 通过 BlobRef 上传允许的内容。
* 可选 Agent memory projection。

ActivityTail 会保存解析后的 typed Agent events，并带 TTL、capacity 和 dropped count；这不是纯 terminal result。

Workspace、transcript、artifact read 也可在显式 policy 下把允许的 bytes 上传至 blob channel。

因此需要区分两种产品承诺：

### 承诺 A：默认本地

> 中间内容默认不上传，只有显式 policy/用户授权才上传。

当前设计基本符合。

### 承诺 B：绝对本地

> 无论配置如何，服务端永远不会保存中间内容。

当前设计不符合。

## 建议定义五级数据分类

| 分类                 | 数据                                                                                  | 云端行为                                         |
| ------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `LOCAL_ONLY`       | raw transcript、reasoning、tool input/output、native session WAL、workspace、credentials | 协议层不可表达上传                                    |
| `EPHEMERAL_RELAY`  | 脱敏 progress/status、可选短文本片段                                                          | 可实时 relay；默认不 durable，或极短 TTL                |
| `RESULT_PERSISTED` | terminal summary、structured result、artifact references、next actions                 | 有界持久化                                        |
| `EXPLICIT_EXPORT`  | 用户明确要求导出的文件、transcript chunk                                                        | 每次需要 actor、policy revision、hash、size、receipt |
| `AUDIT_METADATA`   | IDs、时间、hash、drop/reject reason、usage observation                                    | 可持久化，不含内容                                    |

并提供不可变的部署 profile：

```ts
dataPolicyProfile: 'local-first-v1'
```

在该 profile 下服务端应同时做到：

* 不声明 contentful trajectory capability。
* 不挂载 transcript/workspace content-read route。
* 不配置 Agent memory projection store。
* ActivityStore 只接受无内容 status event。
* 无法由单个 task 临时放宽。
* capability readback 能证明当前部署是 local-first。

最好进一步拆分：

```text
ActivityRelay   // 实时、可丢、非持久
ActivityStore   // 明确 durable、受 retention policy 控制
```

目前两者概念过于接近，容易让 SaaS 开发者误以为“只是给前端实时看”，实际上数据已经进入数据库。

---

# 六、P0：节省云端沙箱，不代表可以取消本地隔离

这是产品定位中最容易被误解的一点。

当前 isolation matrix 已明确承认：

* Pi/Claude 没有由 SDK 提供的 OS-level sandbox。
* cwd containment 主要是工作目录约定，不是机制级 filesystem boundary。
* 多数资源限制是 daemon/cooperative enforcement，而非 kernel enforcement。

因此，你实际消除的是：

> **SaaS 为每个用户长期部署远程沙箱的成本。**

你没有消除的是：

> **不可信 Agent workload 在用户设备上的隔离需求。**

GitHub 对持久 self-hosted runner 的警告同样适用于此：不可信 workload 可能污染 runner、读取长期凭证，甚至影响后续任务。([GitHub Docs][4])

## 应增加 IsolationClass

```ts
type IsolationClass =
  | 'host-direct'
  | 'os-sandbox'
  | 'devcontainer'
  | 'vm';
```

Installation advertisement：

```ts
interface ExecutionCapabilities {
  isolationClasses: IsolationClass[];
  networkPolicies: string[];
  filesystemScopes: string[];
  maxConcurrentRuns: number;
}
```

Run requirement：

```ts
interface RunRequirements {
  minimumIsolation: IsolationClass;
  networkPolicyRef: string;
  workspacePolicy: 'readonly' | 'exclusive-write';
}
```

调度规则：

* 私人、明确可信的本地任务可以使用 `host-direct`。
* 来自网页内容、邮件、第三方文档、公开 repo 或其他不可信输入的自动执行，不应默认进入 host-direct。
* Claude/Pi adapter 没有满足所需 isolation 时必须在 claim 前拒绝。
* Codex 的原生 sandbox capability 也必须作为 runtime observation 明确上报，不能因为 runtime 名称是 Codex 就自动推断。
* Dev Container 可以成为一种实现 profile，但不能单独作为“已经安全”的证明。([Containers.dev][7])

---

# 七、P1：把 Task 重组为 Session / Run / Attempt

当前 `TaskAttempt` 已经具备 offered、claimed、running、cancel_requested、terminal 等可靠状态，但它把“用户请求”和“某次执行尝试”放在同一个 `taskId` 下。

这会在以下情况中变得含糊：

* Computer 离线后改派。
* daemon crash 后恢复。
* 同一个 Run 是否允许新 Attempt。
* 旧 Attempt 的迟到 terminal 是否还有效。
* cancellation 与外部 message side effect 谁赢。
* Session 是继续原运行，还是新建一次逻辑请求。

## 建议采用 fencing

每个 Attempt 都获得：

```text
attemptId
leaseEpoch
attemptToken
expiresAt
```

所有会产生权威副作用的消息必须携带并验证：

```text
(runId, attemptId, installationId, leaseEpoch)
```

包括：

* claim
* progress persistence
* approval
* message egress
* artifact finalize
* terminal result
* result-context commit

当新 Attempt 建立后，旧 `leaseEpoch` 的消息全部只能进入 audit evidence，不能更新产品状态。

Buildkite 的分层凭证模型可以直接借鉴：

```text
长期 Installation credential
  -> connection/session token
       -> 单 Attempt 短期 token
```

短期 job acquisition token 还强调：只绑定一个已保留任务，失败时不得退回使用长期 agent token。BYOK 同样不应在 attempt credential 失败后降级为 installation credential。([Buildkite][3])

---

# 八、P1：结果导向上下文需要版本化 CAS

当前 `TerminalResult` 已经提供：

* summary
* structured document
* artifactRefs
* sessionRef
* usage
* terminal cause

这是很好的 result projection 基础。

但它还不是“服务端有限度持久化结果上下文”的完整模型，因为并行 Run 可能同时从同一个 context 版本出发。

建议增加 SDK 中立的 envelope：

```ts
interface ResultEnvelope {
  schemaVersion: 1;

  sessionId: string;
  runId: string;
  attemptId: string;
  agentRef: AgentRef;

  baseContextVersion: number;

  outcome: 'complete' | 'failed' | 'cancelled';
  summary?: string;

  decisions?: unknown[];
  outputs?: unknown[];
  artifactRefs?: string[];
  nextActions?: unknown[];

  provenanceHash: string;
  producedAt: string;
}
```

提交规则：

```text
commitResult(
  sessionId,
  expectedContextVersion,
  resultEnvelope
)
```

结果：

* version 一致：提交并生成下一 context version。
* version 已前进：返回 conflict，不做 last-write-wins。
* 产品可选择 branch、rebase 或人工 merge。
* SDK 不自动合并自由文本 memory。
* 原始 transcript 不成为云端 context authority。

这样云端保留的是：

> “这个 Agent 在这个 Run 得到了什么结论、产出了什么、下一步是什么。”

而不是：

> “这个 Agent 中间思考和调用过什么。”

---

# 九、P1：Runtime Adapter 应逐步 ACP 化，但不能让云端下发可执行定义

当前 frozen protocol 把 runtime 限定为 `pi | claude | codex`。这对早期安全控制是合理的，但不利于开源组件未来接入其他 local agent。

不建议把它直接改成任意字符串并允许 SaaS 下发：

```text
command
args
env
executable path
```

那会让云端变成用户设备的远程进程启动 authority。

更安全的扩展方式是：

```ts
interface RuntimeRef {
  runtimeId: string;          // openai.codex / anthropic.claude-code / pi.agent
  protocolVersion: string;
  adapterVersion: string;
}
```

本地预注册：

```text
runtimeId -> locally installed adapter descriptor
```

云端只可选择本地已经声明的 logical runtime ID，不能定义其命令和凭证。

Adapter SPI 可以对齐 ACP 的概念：

```text
initialize
newSession
resumeSession
prompt
updates
requestPermission
cancel
close
```

ACP 已覆盖这些核心 lifecycle，并有现成 Codex ACP 与 Claude ACP 生态，可以降低自定义 adapter contract 的长期维护压力。([GitHub][8])

但仍应保留 native adapter：

* Codex：优先 SDK/app-server/ACP surface。
* Claude：优先 Claude SDK 和 stream JSON。
* Pi：保持直接 library integration。

ACP 是 adapter protocol，不是 BYOK 的 SaaS wire protocol；不要把 tenant、Computer placement、result persistence 塞进 ACP。

MCP 同样只负责工具和 context，不能承担 runtime adapter 或任务调度。([Model Context Protocol][6])

---

# 十、RAFT-study 应如何继续使用

`RAFT-study` 的核心判断仍然正确：

* Agent 是长期主体。
* task/job/session 是执行实例。
* 云端 Profile 是产品 authority。
* 本地只保存 revision-bound projection。
* Credential、Profile projection、Agent memory/artifacts 和 runtime session 是不同 authority domain。

RAFT 对 Computer/Supervisor 的划分也很有价值：

* Computer 管理机器、resident service、update、diagnostics。
* daemon 管理 runtime/session。
* BYOK SDK 负责 dispatch/protocol/projector，而不是把整个桌面产品都带进依赖。

不过，RAFT-study 研究的是更早期的 BYOK snapshot。其中曾经指出的 task-free Agent-home projection gap，当前代码已经通过 `enqueueAgentHomeProjection`、revision/hash 和 durable readback 补上；最新提交还加入了 exact local provider profile binding。

因此建议把 `raft-study` 定位为：

```text
Architecture rationale / prior-art evidence
```

而不是当前实现状态的唯一 truth。

最好给研究结论增加状态：

```text
ADOPTED
PARTIALLY_ADOPTED
SUPERSEDED
OPEN
REJECTED
```

目前大致可标记：

* Agent-first：`ADOPTED`
* exact device routing：`ADOPTED`
* task-free profile/home projection：`ADOPTED`
* cloud Profile authority：`ADOPTED`
* Computer first-class domain：`OPEN`
* Session first-class aggregate：`OPEN`
* same-Agent concurrency semantics：`PARTIALLY_ADOPTED`
* local/cloud data classification：`PARTIALLY_ADOPTED`
* OS isolation：`OPEN`

---

# 十一、建议的目标架构

```text
┌──────────────────────── SaaS Product ────────────────────────┐
│ Tenant / User Auth                                           │
│ Computer & Installation Registry                             │
│ Agent / Profile Authority                                    │
│ Session / Run / Attempt Store                                │
│ Placement + Lease + Fencing                                  │
│ Result Context CAS                                           │
│ Consent / Data / Egress Policy                               │
└───────────────────────┬──────────────────────────────────────┘
                        │
             outbound connection only
             frozen attempt contract
             short-lived attempt authority
                        │
┌───────────────────────▼──────────────────────────────────────┐
│ Local Agent Host                                             │
│                                                             │
│  Installation Enrollment + Capability Reporter              │
│  Connection Supervisor                                      │
│  Run Scheduler / Lease Validator                            │
│  Session Registry                                           │
│  Workspace Manager                                          │
│  Runtime Adapter Host                                       │
│    ├─ Codex adapter                                          │
│    ├─ Claude adapter                                         │
│    └─ Pi adapter                                             │
│  Agent Home Manager                                         │
│  Local Transcript / WAL / Audit / Reliable Outbox           │
│  Result & Egress Projector                                  │
└─────────────────────────────────────────────────────────────┘
```

## Authority 分配

| Authority                       | SaaS                      | Local Agent                        |
| ------------------------------- | ------------------------- | ---------------------------------- |
| Tenant、product、user permission  | 主权威                       | 只持 opaque binding                  |
| Computer display identity       | 主权威                       | 提供 observations                    |
| Installation key/auth           | 登记 public identity/revoke | 持 private credential               |
| Agent/Profile                   | versioned authority       | revision-bound readonly projection |
| native runtime credentials      | 无权访问                      | 唯一权威                               |
| native provider session locator | 只保存 opaque SDK session ID | 唯一权威                               |
| transcript/tool trajectory      | 无权访问，除非显式导出               | 唯一权威                               |
| workspace files                 | 无权访问，除非显式导出               | 唯一权威                               |
| Run intent/policy               | 主权威                       | frozen manifest projection         |
| Result context                  | bounded CAS authority     | 产出 ResultEnvelope                  |
| runtime process                 | 无权直接启动                    | 唯一启动/终止 authority                  |

---

# 十二、Package 重组建议

不必立即拆 repository，但应减少开发者需要理解的公开 package surface。

## 推荐公开层

```text
@byok/contracts
  Computer / Installation / Agent / Session / Run / Attempt
  wire DTOs
  policy and capability types

@byok/local-host
  daemon
  session registry
  workspace manager
  lifecycle
  egress projector

@byok/control-plane
  pairing
  placement
  dispatch
  cancellation
  result read model

@byok/runtime-codex
@byok/runtime-claude
@byok/runtime-pi
  optional adapters

@byok/storage-memory
@byok/storage-postgres
  durable ports

@byok/conformance
  adapter/store/protocol tests

@byok/keys
  继续保持独立，不进入 subscription dispatch graph
```

现有 `core/protocol/client/server/cloud/cloud-dataplane` 可以继续作为内部 package，不一定要物理重写；关键是开发者对外只看到三种组合：

```text
createLocalAgentHost()
createEmbeddedCoordinator()
createHostedControlPlane()
```

RAFT 的 Computer supervisor、service installation 和 updater 不应全部进入 `@byok/local-host`。BYOK 只需要暴露：

```ts
interface SupervisorPort {
  status(): Promise<SupervisorStatus>;
  restart(): Promise<void>;
}
```

具体用 launchd、systemd、WinSW、Electron helper 还是 RAFT Computer，由宿主产品决定。

---

# 十三、文档与版本 authority 必须收敛

当前 README 仍写：

```text
byok-sdk@0.8.1
@byok-sdk/keys@0.3.2
```

但当前 spec 和最新 source/release evidence 已写：

```text
byok-sdk 0.12.0
@byok-sdk/keys 0.3.9
```

这是明显的公开文档漂移。

对开源 SDK 来说，这不仅是文案问题。开发者可能根据 README 得出错误结论：

* 安装了旧版本。
* 误判 capability。
* 误判安全修复是否已经包含。
* 按旧 adapter contract 编写 integration。
* 不知道某能力只是 source candidate 还是已发布 artifact。

建议建立一个生成式 authority：

```json
{
  "dispatchVersion": "0.12.0",
  "keysVersion": "0.3.9",
  "protocolVersion": "1",
  "piRuntimeVersion": "...",
  "published": true,
  "sourceCommit": "...",
  "capabilities": []
}
```

README、package docs、release notes 和 conformance matrix 都从它生成或在 CI 中验证。

---

# 十四、实施顺序

## Phase A：先关闭 1.0 领域契约

* [ ] 冻结 Computer / Installation / Agent / Session / Run / Attempt glossary
* [ ] 写 authority matrix ADR
* [ ] 明确 `deviceId → installationId` 的语义迁移
* [ ] 明确 `taskId → runId + attemptId` 的迁移
* [ ] 明确 native provider session ID 永不进入云端
* [ ] 将 ambient device selection 标为 legacy
* [ ] 修正文档和 release authority 漂移

## Phase B：修复并发与 Workspace

* [ ] 新增一等 `WorkspaceRef`
* [ ] Agent home 与 execution workspace 分离
* [ ] 同 Session turn 严格串行
* [ ] 同 Workspace mutable writer 严格单一
* [ ] 不同 isolated Workspace 允许并行
* [ ] terminal 后以 CAS 合并 Agent memory/result
* [ ] shared mutable home 模式删除，或明确标记 experimental/unsafe

## Phase C：Session / Run / Attempt

* [ ] 新增 durable SessionStore
* [ ] 新增 RunStore
* [ ] Attempt 获得 lease epoch/fencing token
* [ ] terminal、message egress、artifact finalize 验证 current Attempt
* [ ] retry 使用同 runId、新 attemptId
* [ ] exact resume 固定原 Installation
* [ ] Session migration 作为独立显式协议，不允许自动 fallback

## Phase D：数据与隔离

* [ ] 定义五级数据分类
* [ ] 发布 `local-first-v1`
* [ ] 服务端 capability 决定哪些内容 route 根本不存在
* [ ] ActivityRelay 与 ActivityStore 分离
* [ ] 新增 IsolationClass
* [ ] Run 声明最低 isolation
* [ ] Installation advertisement 声明实际隔离能力
* [ ] 不满足隔离要求时 claim 前拒绝

## Phase E：适配器与公开 SDK

* [ ] 提取 ACP-like local adapter interface
* [ ] Codex/Claude 优先采用原生 machine-readable surface
* [ ] MCP 继续限定为工具层
* [ ] 建立 custom runtime conformance suite
* [ ] 收敛公开 package surface
* [ ] 提供 embedded/self-hosted/hosted 三套最短集成路径

---

# 十五、必须通过的验收场景

1. **Exact placement**：指定 Installation 离线时任务保持 queued 或失败，不得自动跑到另一台 Computer。
2. **Same Session serialization**：两个并发 Run 不得同时进入同一 native Session。
3. **Workspace exclusion**：两个 Session 请求同一 mutable Workspace 时，第二个在 claim 前被拒绝。
4. **Safe parallelism**：同一 Agent、不同 isolated Workspace 可以并行完成。
5. **Fencing**：新 Attempt 建立后，旧 Attempt 的 progress、message 和 terminal 只能保留为 audit evidence。
6. **Cancellation race**：cancel 先提交后，不允许启动新的外部 message side effect。
7. **Local-first proof**：在 `local-first-v1` 下，cloud database/blob store 不出现 transcript、tool content 或 workspace bytes。
8. **Explicit export**：每一次内容导出都能读回 actor、policy revision、hash、size 和 receipt。
9. **Context CAS**：两个 Run 从同一 context version 出发时，第二个提交不得覆盖第一个。
10. **Resume binding**：错误 Installation、Agent revision、runtime、cwd 或 native session evidence 均 fail closed。
11. **Credential absence**：manifest、wire、cloud store、logs 和 diagnostics 均不出现 provider credential。
12. **Crash matrix**：prepare 前、claim 后、runtime start 后、terminal 前后、result CAS 前后分别注入 crash。
13. **Isolation admission**：要求 `os-sandbox` 的 Run 不得被只有 `host-direct` 的 Installation 接受。
14. **Documentation closure**：README、package metadata、release manifest 和 npm readback 版本完全一致。

---

# 最终架构建议

这个项目真正有差异化价值的不是“又一个 Agent runtime”，而是：

> **让 SaaS 安全地调度用户控制的本地已登录 Agent runtime，同时只把经过策略约束的结果投影回云端。**

建议保留：

* 当前 frozen wire 与 fail-closed 原则。
* credential custody 分离。
* exact AgentRef/profile revision。
* immutable manifest before claim。
* fresh/resume 分离。
* reliable egress 与 explicit content read。
* stateless cloud + durable ports。
* `@byok-sdk/keys` 独立。

建议在 1.0 前重组：

```text
Device / Task
      ↓
Installation / Session / Run / Attempt

AgentHome-as-cwd
      ↓
AgentHome + Workspace + SessionState

policy-default local
      ↓
server-verifiable local-first profile

no cloud sandbox
      ↓
capability-selected local isolation
```

其中最优先的不是 package rename，而是解决：

1. **同一 Agent home 的并行 mutable writer。**
2. **Session/Run/Attempt 的权威模型。**
3. **“中间态留本地”的可验证定义。**
4. **本地执行隔离的真实能力声明。**

完成这四项以后，BYOK SDK 才会从“可靠的本地任务 dispatch SDK”真正收敛为你所描述的：

> **以 Computer、Agent、Session 为核心，可并行、可嵌入、local-first、结果导向的 Local Agent 平台组件。**

[1]: https://github.com/agentclientprotocol/agent-client-protocol "https://github.com/agentclientprotocol/agent-client-protocol"
[2]: https://github.com/microsoft/agent-host-protocol "https://github.com/microsoft/agent-host-protocol"
[3]: https://buildkite.com/docs/agent/self-hosted/tokens "https://buildkite.com/docs/agent/self-hosted/tokens"
[4]: https://docs.github.com/en/actions/reference/runners/self-hosted-runners "https://docs.github.com/en/actions/reference/runners/self-hosted-runners"
[5]: https://docs.anthropic.com/fr/docs/claude-code/sdk "https://docs.anthropic.com/fr/docs/claude-code/sdk"
[6]: https://modelcontextprotocol.io/specification/2025-06-18/architecture "https://modelcontextprotocol.io/specification/2025-06-18/architecture"
[7]: https://containers.dev/ "https://containers.dev/"
[8]: https://github.com/agentclientprotocol "https://github.com/agentclientprotocol"
