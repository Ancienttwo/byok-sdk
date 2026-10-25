# BYOK SDK 系统图

> 状态：CURRENT，人工绘制；每个节点和边都对照过源码。
> 核对基准：commit `142acbe2`（2026-10-24）。文中 `path:line` 均指这一版，路径相对仓库根。
> 与 [`sdk-architecture.md`](sdk-architecture.md) 不一致时以源码为准，已知差异由 #927 跟踪。
> 图例：实线箭头表示运行时 import 或调用；虚线表示进程边界、网络边界或可选路径；虚线框是 SDK 不提供、需要 Host 自备的部分。图中 package 名省略 `@byok-sdk/` 前缀。

## 1. 分层架构图

Host 侧分四层，L1 契约层同时被设备侧使用。设备侧 `client` 只 import `core` 与 `protocol`，和 Host 侧之间只有 HTTP long-poll 一条通道。`keys` 与 `cloud-do` 不在派工主链路上。L4 的参考实现在 `examples/`：Topology L 见 `host-execution-core`、`basic`，Topology H 见 `hosted-bot-collaboration`，Host UI 见 `live-activity-host`。

```mermaid
flowchart TB
  classDef host fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
  classDef compose fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff
  classDef kernel fill:#5b21b6,stroke:#ddd6fe,stroke-width:2px,color:#fff
  classDef contract fill:#0f766e,stroke:#99f6e4,stroke-width:2px,color:#fff
  classDef device fill:#9a3412,stroke:#fed7aa,stroke-width:2px,color:#fff
  classDef side fill:#4b5563,stroke:#d1d5db,stroke-width:2px,color:#fff,stroke-dasharray:5 5

  subgraph L4["L4 · Host 应用"]
    direction LR
    HostL["Topology L Host<br/>设备本机"]:::host
    HostH["Topology H Host<br/>云端服务"]:::host
    HostUI["Host UI<br/>浏览器端"]:::host
  end

  subgraph L3["L3 · 组合"]
    direction LR
    Server["server<br/>createByokServer<br/>memory / SQLite"]:::compose
    Dataplane["cloud-dataplane<br/>Postgres + R2<br/>./runtime 供 Workers"]:::compose
    UiRuntime["ui-runtime<br/>timeline 投影"]:::compose
  end

  subgraph L2["L2 · 协调内核"]
    Cloud["cloud · createByokCloud<br/>auth · route registry<br/>inbound gate · mailbox<br/>attempts · 终态权威"]:::kernel
  end

  subgraph L1["L1 · 契约"]
    direction LR
    Protocol["protocol<br/>wire v3 · codec<br/>http-api"]:::contract
    Core["core<br/>tenant · store ports<br/>device proof"]:::contract
  end

  subgraph DEV["设备 · client"]
    direction TB
    DEntry["入口<br/>byok-agent · createDaemon<br/>helper bins"]:::device
    DOrch["编排<br/>Auth · Connection<br/>Journal · TaskRunner"]:::device
    DAdapt["adapters<br/>内置 Pi · Claude · Codex<br/>注入 Hermes · Grok"]:::device
    DEntry --> DOrch --> DAdapt
  end

  CLIs["agent CLI<br/>用户自装、自登录"]:::side
  Keys["keys<br/>ProviderRegistry<br/>launcher"]:::side
  CloudDo["cloud-do<br/>AgentDO · 平台 key<br/>无 workspace 依赖"]:::side

  HostL --> Server
  HostH --> Cloud
  HostH --> Dataplane
  HostUI --> UiRuntime
  Server --> Cloud
  Dataplane --> Cloud
  UiRuntime --> Cloud
  Cloud --> Protocol
  Cloud --> Core
  DOrch --> Protocol
  DOrch --> Core
  Keys --> Core
  DAdapt --> CLIs
  Keys -.->|"launcher 启动 Pi"| CLIs
  DOrch <-.->|"HTTPS long-poll"| Cloud
  CLIs ~~~ CloudDo
```

图里省略了 L3 对 L1 的直接 import：`server` 与 `cloud-dataplane` 都直接用 `core` 和 `protocol`，`ui-runtime` 直接用 `protocol`。下表是完整的运行时依赖，不含测试文件，每条边都有值导入（不只是 `import type`）。

| 层 | package | workspace 运行时依赖 | 主要入口 |
| --- | --- | --- | --- |
| L1 | `@byok-sdk/protocol` | 无 | `PROTOCOL_VERSION = 3`（`packages/protocol/src/version.ts:35`）；`encodeEnvelope` / `decodeEnvelope` / `parseMessage`（`packages/protocol/src/codec.ts`）；`BYOK_*_PATH`（`packages/protocol/src/http-api.ts:464-550`） |
| L1 | `@byok-sdk/core` | 无，只依赖 `zod` | store ports `CoreStores`（`packages/core/src/stores.ts`）；`createInMemoryCoreStores`（`packages/core/src/in-memory/index.ts:45`） |
| L2 | `@byok-sdk/cloud` | core、protocol | `createByokCloud`（`packages/cloud/src/cloud.ts:1023`）；`createInMemoryByokCloud`（`packages/cloud/src/composition/in-memory.ts:106`） |
| L3 | `@byok-sdk/server` | cloud、core、protocol | `createByokServer`（`packages/server/src/index.ts:327`）；`listenLoopback`（`packages/server/src/loopback.ts:84`） |
| L3 | `@byok-sdk/cloud-dataplane` | cloud、core、protocol | `./runtime` 导出 `createPostgresCloudStores`、`createPostgresCoreStores` 与 R2 stores；根入口另有 `migrate`、`createPostgresMailboxWake` 等 Node-only 能力（`packages/cloud-dataplane/src/index.ts:31-94`） |
| L3 | `@byok-sdk/ui-runtime` | cloud、protocol | `projectTimeline`、`replayTimeline`（`packages/ui-runtime/src/timeline.ts:366,379`） |
| 设备 | `@byok-sdk/client` | core、protocol | `createDaemon`（`packages/client/src/daemon/create-daemon.ts:4801`）；`createDaemonWithAdapters`（同文件 `:1308`）；`byok-agent` 等 8 个 bin |
| 旁路 | `@byok-sdk/keys` | core | `ProviderRegistry`（`packages/keys/src/registry.ts:184`）；`byok-pi-provider-launcher` |
| 旁路 | `@byok-sdk/cloud-do` | 无 | `AgentDO`（`packages/cloud-do/src/agent-do.ts:78`） |
| 私有 | `@byok-sdk/conformance` | cloud、core、protocol、testkit | `run*Conformance`（`packages/conformance/src/index.ts`） |
| 私有 | `@byok-sdk/testkit` | core、protocol | `createDeviceSimulator`（`packages/testkit/src/index.ts`） |

只在测试里出现的边：`client → server`、`cloud-do → keys`、`server → conformance`、`cloud-dataplane → conformance`，都声明为 devDependency。

## 2. 时序图

### 2.1 配对与建连

```mermaid
sequenceDiagram
  autonumber
  participant Host as Host 产品代码
  participant Cloud as cloud<br/>经 server façade 或直接部署
  participant D as daemon<br/>AuthManager · ConnectionManager

  Host->>Cloud: createPairingCode({ productId })
  Cloud-->>Host: 一次性 code 与过期时间
  Note over Host,D: Host 通过自己的 UI 把 code 交给设备上的用户
  D->>D: 首次配对生成 Ed25519 密钥<br/>联网前先落盘配对记录
  D->>Cloud: POST /byok/pair<br/>pairingCode · deviceName · devicePublicKey
  Cloud-->>D: deviceId · accessToken<br/>refreshHint · tenantId
  D->>Cloud: POST /byok/messages<br/>batch 里只有 conn.hello
  Cloud->>Cloud: 校验 device、protocolVersions、product<br/>记录 capabilities
  Cloud-->>D: accepted，附 capabilities 与 ingress
  D->>D: 状态置为 open<br/>之后才轮询并发送 outbox
  D->>Cloud: GET /byok/events?cursor=N<br/>held，最长 50 s
  opt token 临近过期或收到 401
    D->>Cloud: POST /byok/challenge（deviceId）
    Cloud-->>D: 一次性 nonce
    D->>Cloud: POST /byok/token<br/>deviceId · nonce · signature
    Cloud-->>D: 新 accessToken
  end
```

- `conn.hello` 必须是会话的第一条消息，这个顺序由 client 保证：hello 单独 POST，被接受后才开始轮询和发送（`packages/client/src/daemon/connection-manager.ts:282-327`）。cloud 把 hello 当作幂等的能力快照，不检查先后（`packages/cloud/src/inbound.ts:598-611`）。
- `/byok/pair` 已经返回 accessToken（`packages/cloud/src/handlers/auth.ts:47-58`）。challenge 与 token 只用于续期和 401 之后的重新认证（`packages/client/src/daemon/auth-manager.ts:266-337`）。

### 2.2 派工到终态

主线是新的 Agent 执行 `executions.submit`。`dispatch()` 的几种 offer 走同一条下游链路，只是入队的 wire 类型不同：

| Host 入口 | wire 类型 |
| --- | --- |
| `executions.submit(input)` | `task.offer_for_agent_with_egress_fresh` |
| `dispatch(input)` | `task.offer` |
| `dispatch(input)`，带 `requiredToolsets` | `task.offer_with_toolsets` |
| `dispatch(input)`，带 `agentRef` 与 `sessionRef`，只用于 resume | `task.offer_for_agent`；再带 `egressPolicy` 时是 `task.offer_for_agent_with_egress` |

入口见 `packages/server/src/index.ts:537-701`、`:807-826`，入队见 `packages/cloud/src/cloud.ts:1354-1482`、`:2339-2447`。

```mermaid
sequenceDiagram
  autonumber
  box rgba(96,165,250,0.12) Host 侧
    participant H as Host 代码<br/>与 server façade
    participant K as cloud kernel
    participant S as cloud stores
  end
  box rgba(167,139,250,0.12) 设备侧 daemon
    participant CM as Connection<br/>Manager
    participant TR as TaskRunner
    participant RT as adapter<br/>与 agent CLI
  end

  Note over K,CM: 会话已 open<br/>CM 挂着 GET /byok/events?cursor=N

  rect rgba(148,163,184,0.10)
    Note over H,S: ① 入队
    H->>K: executions.submit<br/>或 dispatch
    K->>S: 开 attempt：offered<br/>存 offer receipt
    K->>S: mailbox.append<br/>分配设备内 seq
    S-->>K: commit 后发 wake
    K-->>H: EnqueuedOffer
  end

  rect rgba(148,163,184,0.10)
    Note over K,TR: ② 投递
    K->>S: readAfter(N)<br/>记录 delivery
    K-->>CM: 返回一页 events：offer
    opt hostedJournal
      CM->>CM: journal 追加并 fsync
    end
    CM->>TR: handleEnvelope
  end

  rect rgba(148,163,184,0.10)
    Note over K,RT: ③ 认领与启动
    TR->>RT: prepare<br/>无副作用
    alt 拒绝
      TR->>CM: task.decline
      CM->>K: POST /byok/messages
      K->>S: attempt：failed
    else 接受
      TR->>TR: 封存 manifest<br/>取得 lease
      TR->>CM: task.claim
      CM->>K: POST /byok/messages
      K->>S: CAS：offered → claimed<br/>快照 capabilities
      TR->>RT: operation.start
      RT->>RT: spawn agent CLI<br/>独立进程组
      TR->>CM: task.started
      CM->>K: POST /byok/messages
      K->>S: claimed → running
    end
    CM->>CM: handler 返回<br/>cursor N+1 落盘
    CM->>K: GET /byok/events<br/>?cursor=N+1
    K->>S: 先 ack 到 N+1<br/>再读后续行
  end

  rect rgba(148,163,184,0.10)
    Note over K,RT: ④ 执行
    loop Session.events
      RT-->>TR: AgentEvent
      TR->>CM: task.progress 批次
      CM->>K: POST /byok/messages
      K->>S: 追加 activity
    end
  end

  rect rgba(148,163,184,0.10)
    Note over H,RT: ⑤ 终态与回读
    alt turn_end
      TR->>CM: task.complete
    else 运行失败
      TR->>CM: task.fail
    else Host 取消
      H->>K: tasks.cancel
      K->>S: 写 cancellation 标记<br/>mailbox 追加 task.cancel
      K-->>CM: 一页 events：task.cancel
      CM->>TR: handleCancel
      TR->>CM: task.cancelled
    end
    CM->>K: POST /byok/messages
    K->>S: first-terminal-wins<br/>status 进入终态
    K-->>H: relay 通知
    TR->>RT: Session.close<br/>整组 TERM 后 KILL
    H->>S: tasks.get<br/>持久化读回
  end
```

- **参与者 H** 合并了 Host 代码与 server façade（relay、TaskHandle）。Topology H 的 Host 直接调用 `ByokCloud` 上对应的 `submitAgentExecution`、`cancelTask`、`readTaskResult`（`packages/cloud/src/cloud.ts:2339`、`:2721`、`:2827`）。
- **ack 时机**：cursor 只在 handler 成功返回并原子落盘后前进，下一次 GET 才携带它；cloud 读取之前先 `advanceCursor`（`packages/cloud/src/handlers/events.ts:136-147`，`packages/client/src/daemon/connection-manager.ts:758-815`）。配置了 `hostedJournal` 时，offer 在 handler 里先 fsync 进 SQLite journal（`packages/client/src/daemon/create-daemon.ts:3127-3139`），没配置时没有这一步。handler 失败时 cursor 不动，mailbox 重投同一行。
- **offer handler 不等任务结束**：`task.started` 发出、事件泵启动后就返回（`packages/client/src/daemon/task-runner.ts:3254-3280`），所以 ack 发生在执行期间。
- **批量上限**：progress 由 `ProgressBatcher` 成批发送；每次 POST 最多 256 条、2 MiB（`packages/protocol/src/http-api.ts:269-272`）。
- **终态内容**：`task.complete` 带 summary、finalMessage、sessionRef 与 usage。`task.fail` 带 reason、retryable 与 `failure`；runtime 失败时三者由 adapter 的 `RuntimeExecutionFailure` 投影而来（`packages/client/src/runtime-failure.ts:162-188`），daemon 自己判定的失败带 `{ class: 'unknown' }`（`packages/client/src/daemon/task-failure.ts:4`）。`failure` 是封闭的失败类别，`resetsAt` 只出现在 `quota` 上（`packages/protocol/src/messages.ts:1292-1295`）；只有声明了 `runtime-failure-class` 的 server 才会收到它（`packages/protocol/src/wire-additions.ts:154`）。
- **`Session.close()` 在终态发出之后执行**：它挡住的是本地 lease、workspace 与 task 记录的释放，wire 终态不等它（`packages/client/src/daemon/task-runner.ts:5598-5710`）。
- **终态裁决**：cloud 以第一条设备终态为准；attempt 上有 Host 的 cancellation 标记时，结果记为 `cancelled`（`packages/cloud/src/inbound.ts:987-1074`）。
- **steer**：`TaskHandle.steer(text)` 调 `cloud.steerTask`，只有 status 为 running、且 claim 时快照的 `capabilities.steer` 为 true，才会入队 `task.steer`（`packages/cloud/src/cloud.ts:1847-1929`）。

## 3. 进程与命名空间拓扑 + 挂载层

本节的命名空间和挂载对应代码里实际存在的三样东西：进程树与进程组；身份 keyspace 与目录树；daemon 交给每个 runtime 子进程的 cwd、环境变量和配置文件。SDK 不创建内核 namespace、bind mount、chroot 或容器，`packages/client` 与 `packages/keys` 里检索 `unshare`、`bwrap`、`sandbox-exec`、`landlock`、`chroot`、`seccomp` 均无结果，与 [`host-runtime-isolation-matrix.md`](../host-runtime-isolation-matrix.md) 一致。需要 OS 级隔离时由 Host 自己包一层。

### 3.1 进程拓扑

```mermaid
flowchart LR
  classDef host fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff
  classDef daemon fill:#5b21b6,stroke:#ddd6fe,stroke-width:2px,color:#fff
  classDef runtime fill:#0f766e,stroke:#99f6e4,stroke-width:2px,color:#fff
  classDef helper fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
  classDef store fill:#9a3412,stroke:#fed7aa,stroke-width:2px,color:#fff
  classDef absent fill:none,stroke:#9ca3af,stroke-width:2px,stroke-dasharray:6 4,color:#9ca3af

  subgraph HS["Host 侧，二选一"]
    HostL["Topology L<br/>同机 Node 进程<br/>createByokServer<br/>SQLite 或 memory"]:::host
    HostH["Topology H<br/>云端 Worker 或 Node<br/>createByokCloud<br/>Postgres + R2"]:::host
  end

  subgraph DEV["设备侧 · 同一 OS 用户"]
    SM["服务管理器<br/>launchd · systemd --user<br/>WinSW"]:::helper
    Cli["byok-agent 子命令"]:::helper
    Ctl(["控制通道<br/>control.sock 或命名管道<br/>HMAC · control.token"]):::daemon
    Daemon["byok-agent start<br/>createDaemon"]:::daemon
    Ledger[("owned-processes/<br/>POSIX 进程组台账")]:::store
    Direct["直接子进程，不建组<br/>git · memory helper<br/>MCP 探测 · 凭据命令"]:::helper

    subgraph GC["进程组 · Claude"]
      Claude["claude -p<br/>stream-json"]:::runtime --> McpC["MCP servers<br/>按 --mcp-config"]:::runtime
    end
    subgraph GX["进程组 · Codex"]
      Codex["codex app-server"]:::runtime --> McpX["MCP servers<br/>按 mcp_servers"]:::runtime
    end
    subgraph GP["进程组 · Pi"]
      Launcher["keys launcher<br/>可选"]:::runtime --> PiHost["Pi host byok-pi-*<br/>McpServerPool 拉起<br/>MCP servers"]:::runtime
    end
    subgraph GH["进程组 · Host 注入"]
      Hermes["hermes gateway<br/>hermes --yolo acp"]:::runtime
      Grok["grok agent stdio"]:::runtime
    end

    SM --> Daemon
    Daemon -->|"监听"| Ctl
    Cli -->|"连接"| Ctl
    Daemon --> Claude
    Daemon --> Codex
    Daemon --> Launcher
    Daemon --> Hermes
    Daemon --> Grok
    Daemon --> Direct
    Daemon --> Ledger
  end

  Box["Host 自备的 OS 边界<br/>SDK 不提供"]:::absent

  HostL <-->|"HTTP 环回"| Daemon
  HostH <-->|"HTTPS"| Daemon
  Box -.- DEV
```

- **Host 侧**：Topology L 的 Host 进程内嵌 `createByokServer`，用 `listenLoopback` 在 `127.0.0.1` 上服务 daemon（`packages/server/src/loopback.ts:84`）。Topology H 的 Host 以 `cloud.fetch` 挂在 Worker 或 Node 上；常驻 Node 进程另开一条 session 模式的 Postgres 连接 `LISTEN byok_mailbox_wake`，Worker 没有这条连接，用进程内 wake 加可配置的兜底间隔重读，默认 5 秒（`packages/cloud-dataplane/src/mailbox-wake.ts:61-108`，`deploy/sql/0024_mailbox_wake.sql`，`packages/cloud/src/stores/in-memory/mailbox-wake.ts:4`）。
- **进程组**：daemon 指向各进程组的边都是 detached spawn。runtime 根进程经 `withOwnedProcessTree` 以 `detached: true` 启动，各自成为进程组 leader（`packages/client/src/adapters/process-tree.ts:57-62`）；释放时先对整组 SIGTERM，750 ms 后 SIGKILL（`process-tree.ts:750-821`）。Windows 不建进程组，改用 kill-on-close Job Object 和 `taskkill /T /F`，也不写台账（`packages/client/src/adapters/win32-job-object.ts`）。
- **台账**：POSIX 下 adopt 时把 pgid 写进 `<storeDir>/owned-processes/`（`packages/client/src/daemon/owned-process-ledger.ts:36,78-91`）。daemon 启动先 reconcile 台账，清掉崩溃遗留的进程组，有组杀不掉就拒绝启动（`packages/client/src/daemon/create-daemon.ts:2164`，`owned-process-ledger.ts:98-108`）。
- **Pi**：配置了 keys launcher 时 daemon 先起 launcher，launcher 以继承的 stdio 加 IPC 启动 Pi host，provider key 走 IPC（`packages/keys/src/pi-provider-launcher-core.ts:584-592`）；没配置时 daemon 直接 spawn Pi host。durable Pi 的工具 shell 由 Pi host 以 `/bin/bash -c` 另起一个进程组（`packages/client/src/adapters/pi-durable/shell.ts:32`）。
- **控制通道**：POSIX 用 `<storeDir>/control.sock`，路径超过 100 字节时退到 `/tmp/byok-<hash>/sock`；Windows 用 `\\.\pipe\byok-<hash>`；双方用 `control.token` 做 HMAC-SHA256 双向认证，token 本身不上线（`packages/client/src/daemon/control-protocol.ts:117-188`）。能以 daemon 同一 OS 用户运行的进程都能读到这个 token，这是同用户信任边界。
- **SDK 保留的 MCP helper**（`byok-agent-message-mcp`、`-result-mcp`、`-memory-mcp`、`-team-mcp`）由 runtime 当作 MCP server 拉起，再经控制通道回拨 daemon（`packages/client/src/bin/sdk-reserved-helper-runners.ts:30-60`）。
- **内置与注入**：`createDaemon` 只构建 pi、claude、codex（`packages/client/src/daemon/create-daemon.ts:1226-1237`）；Hermes 与 Grok 由 Host 通过 `createDaemonWithAdapters` 加入。
- **服务管理器**启动的命令行是 `<node> <byok-agent> start --config <abs> --service`（`packages/client/src/lifecycle/service-types.ts:60-66`）；launchd 用 `gui/<uid>` 下的 LaunchAgent，systemd 用 user unit（`lifecycle/launchd.ts`、`lifecycle/systemd.ts`、`lifecycle/winsw.ts`）。

### 3.2 命名空间

```mermaid
flowchart TB
  classDef id fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff
  classDef fs fill:#9a3412,stroke:#fed7aa,stroke-width:2px,color:#fff
  classDef os fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff

  Tenant["tenant<br/>cloud stores 的首个键"]:::id
  Product["productId"]:::id
  Device["deviceId<br/>mailbox seq 按设备递增"]:::id
  Agent["AgentRef<br/>agentId · profileRevision"]:::id
  Task["taskId<br/>attempt · receipts · 终态"]:::id
  Tenant --> Product --> Device --> Agent --> Task

  Store["storeDir<br/>默认 ~/.byok/&lt;productId&gt;"]:::fs
  Cred["OS 凭据库<br/>com.byok.client.device.<br/>&lt;sha256(productId)&gt;"]:::os
  Home["Agent home<br/>hostStorageRoot/agents/<br/>&lt;agentId&gt;/"]:::fs
  Runs[".byok/runs/&lt;taskId&gt;/<br/>memory-reader 的 cwd"]:::fs
  Exec["tmp/exec/&lt;token&gt;/<br/>每次执行一个 token"]:::fs
  WS["workspaceRoot/&lt;taskId&gt;/<br/>legacy task workspace"]:::fs

  Product -->|"路径键"| Store
  Product -->|"service 名"| Cred
  Agent -->|"路径键"| Home
  Task --> Runs
  Task --> Exec
  Task --> WS
  Store -.->|"包含"| Exec
  Home -.->|"包含"| Runs
```

storeDir 的内容（Agent home 的布局见 [`host-local-storage-layout.md`](../host-local-storage-layout.md)）：

```text
<storeDir>/                        默认 ~/.byok/<productId>
  device.json                      enrollment 的非秘密投影；私钥与 token 在 OS 凭据库
  cursor-<hash>.json               已落盘的 mailbox cursor
  daemon.db                        hostedJournal（SQLite），可选
  control.sock  control.token      控制通道与 HMAC 密钥
  mutex.sock  daemon-owner.json    单 daemon 所有权
  owned-processes/                 POSIX 进程组台账
  session-workspaces.json          sessionRef 到 workspace 的映射
  git-workspaces.json              Git checkpoint 私有台账
  skill-packs/<name>/<hash>/       skill pack 安装根，默认在 storeDir
  tmp/exec/<token>/sdk/            SDK 写给 runtime 的配置，释放即删
  tmp/exec/<token>/runtime/        子进程的 TMPDIR，由 retention 清理
```

- **storeDir** 由 `DeviceStore.resolveDir(productId, config.storeDir)` 决定，默认 `~/.byok/<productId>`（`packages/client/src/daemon/store.ts:208-219`）。同一 productId 的 daemon 与 CLI 共用这一个目录，`mutex.sock` 与 `daemon-owner.json` 保证只有一个 daemon 持有它（`packages/client/src/daemon/daemon-owner.ts`）。
- **执行 scratch**：每次执行一个 12 位十六进制 token。`sdk/` 放 SDK 写给 runtime 的配置，释放即删；`runtime/` 是子进程的临时目录，带 `released` 标记后由 retention 清理（`packages/client/src/daemon/retention/scratch.ts:160-187`）。路径过长、放不下 Unix socket 时，scratch 根改到系统 tmp 下的 `byok-scratch-<hash>`（`scratch.ts:50-61`）。
- **Agent home**：`.byok/` 是 Agent home 里唯一的 SDK 保留区，路径由 SDK 拼接并拒绝 symlink 与越界（`packages/client/src/agent-home.ts:28,326,390-398`）。布局细节见 [`host-local-storage-layout.md`](../host-local-storage-layout.md)。
- **凭据库**：设备私钥与 bearer token 整条存在 OS 凭据库，`device.json` 只是它的非秘密投影（`packages/client/src/daemon/store.ts:26-30,176-180`）。macOS 走 `/usr/bin/security`，Linux 走 `secret-tool`，Windows 走 PowerShell 编译的 credential bridge（`packages/client/src/daemon/device-credential-store.ts:221-226,342-360`）。provider key 由 `@byok-sdk/keys` 存放，service 名形如 `com.byok.keys.scope.acct_<hash>.<name>`，规则见 `packages/keys/src/secret-name.ts` 与 `secret-scope.ts`。

### 3.3 挂载层

#### 设备侧：runtime 子进程看到什么

```mermaid
flowchart LR
  classDef src fill:#9a3412,stroke:#fed7aa,stroke-width:2px,color:#fff
  classDef how fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
  classDef rt fill:#0f766e,stroke:#99f6e4,stroke-width:2px,color:#fff

  subgraph SRC["daemon 准备的来源"]
    direction TB
    Cwd["工作目录<br/>Agent home（writer）<br/>.byok/runs/&lt;taskId&gt;（reader）<br/>workspaceRoot/&lt;taskId&gt;（legacy）"]:::src
    Tmp["tmp/exec/&lt;token&gt;/runtime"]:::src
    Mcp["本任务的 MCP server 列表<br/>Host toolsets 与保留 helper"]:::src
    Sdk["tmp/exec/&lt;token&gt;/sdk<br/>0600 配置文件<br/>mcp-config.json<br/>rpc-launch.json"]:::src
    Env["daemon 环境变量<br/>去掉 CLAUDECODE 与 BYOK_*"]:::src
    User["用户自己的 agent 配置<br/>~/.claude · CODEX_HOME"]:::src
  end

  subgraph HOW["绑定方式（无内核 mount）"]
    direction TB
    B1["spawn 的 cwd，取 realpath"]:::how
    B2["TMPDIR · TEMP · TMP"]:::how
    B3["命令行参数<br/>claude --mcp-config<br/>claude --settings<br/>codex -c sandbox_mode"]:::how
    B4["协议消息携带 MCP 列表<br/>Codex thread/start<br/>ACP session/new"]:::how
    B5["SDK 设置的目录变量<br/>PI_CODING_AGENT_DIR<br/>HERMES_HOME"]:::how
    B6["原样继承<br/>不改 HOME · CLAUDE_CONFIG_DIR<br/>CODEX_HOME"]:::how
  end

  RT["runtime 子进程<br/>claude · codex · pi<br/>hermes · grok"]:::rt

  Cwd --> B1 --> RT
  Tmp --> B2 --> RT
  Mcp --> Sdk
  Mcp --> B4 --> RT
  Sdk --> B3 --> RT
  Sdk --> B5 --> RT
  Env -->|"spawn env"| RT
  User --> B6 --> RT
```

| runtime | 启动命令（节选） | MCP server 由谁拉起 | SDK 传入的权限相关参数 |
| --- | --- | --- | --- |
| Claude，内置 | `claude -p --input-format stream-json --output-format stream-json --verbose` | claude 按 `--mcp-config` 文件拉起，cwd 与会话相同 | 默认 `--dangerously-skip-permissions`；Host 开启 native interactions 时改为 `--permission-prompt-tool stdio --permission-mode acceptEdits` |
| Codex，内置 | `codex app-server -c sandbox_mode=… --listen stdio://` | codex 按 `thread/start` 的 `mcp_servers` 拉起 | `approvalPolicy: never`；`sandbox_mode` 默认 `danger-full-access`，`codexSandbox: 'inherit'` 时不覆盖 |
| Pi，内置 | Pi host bin，可经 `byok-pi-provider-launcher` 启动 | Pi host 的 `McpServerPool`，配置在 `sdk/rpc-launch.json` | 预信任会话 cwd |
| Hermes，Host 注入 | `hermes gateway run --quiet --external-supervisor --force` 与 `hermes --yolo acp` | Hermes 按 ACP `session/new` 的 `mcpServers` 拉起 | `--yolo` |
| Grok，Host 注入 | `grok agent --always-approve --no-leader stdio` | Grok 按 ACP `session/new` 的 `mcpServers` 拉起 | `--always-approve` |

出处：`packages/client/src/adapters/claude/claude-adapter.ts:274-344`，`packages/client/src/adapters/codex/codex-adapter.ts:245-247`，`packages/client/vendor/oar/c88a514/runtimes/codex/app-server-client.ts:110`，`packages/client/src/adapters/pi/pi-adapter.ts:501-527`，`packages/client/src/adapters/hermes/hermes-adapter.ts:332,343`，`packages/client/vendor/oar/c88a514/runtimes/grok/session.ts:144`。

- **环境变量**：`buildRuntimeEnv` 继承 daemon 的完整环境，只去掉 `CLAUDECODE` 与 `BYOK_*`（`packages/client/src/daemon/environment.ts:101-104`），再叠加 scratch 的 `TMPDIR`、`TEMP`、`TMP`（`packages/client/src/daemon/task-runner.ts:3592`）。provider key 等环境里的秘密会传到 agent 子进程。Pi prepared lane、durable 工具 shell 与经 launcher 的 Hermes 改用窄 allowlist（`buildAllowlistedEnv`）。
- **目录变量**：`PI_CODING_AGENT_DIR` 只在经 keys launcher 时由 SDK 指向 `sdk/` 下新建的空目录；`HERMES_HOME` 指向 Host 提供的 Hermes home（`packages/client/src/adapters/hermes/hermes-adapter.ts:93-100`）。
- **Claude 的 `agentUserContext: 'excluded'`**：只对 Agent 任务生效，加 `--strict-mcp-config` 与 `--settings <sdk>/claude-settings.json`，排除 Agent home 之外的 `CLAUDE.md` 和 auto memory（`packages/client/src/adapters/claude/agent-user-context.ts`）。`createDaemon` 不设这个选项，默认是 `inherit`。
- **skill packs** 只装到 `<dataDir>/skill-packs/<name>/<hash>/`，由 Host 调 `projectSkillPack` 复制到它选的目录；SDK 不替 runtime 决定技能目录（`packages/client/src/daemon/skill-pack-installer.ts:20-32,653-670`）。

#### Host 侧：按能力声明挂载 HTTP 路由

```mermaid
flowchart TB
  classDef in fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
  classDef kernel fill:#5b21b6,stroke:#ddd6fe,stroke-width:2px,color:#fff
  classDef out fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff

  Decl["capability 声明<br/>server 固定用 fullCapabilityDeclaration()"]:::in
  Ports["注入的 ports<br/>blobContentProxy · truthCommitter<br/>skillPacks · e2eeMemberStore 等"]:::in
  Check["assertNoOverDeclaration<br/>声明了但缺 port：构造失败<br/>有 port 但未声明：不挂载"]:::kernel
  Reg["CloudRouteRegistry.register<br/>public · device · proof · presigned"]:::kernel
  App["私有 Hono app<br/>mountedRoutes 读回 app.routes"]:::kernel
  Fetch["ByokCloud.fetch"]:::out
  MountL["server<br/>hono.all('*') 整体转发<br/>可选 GET /healthz"]:::out
  Loop["listenLoopback<br/>127.0.0.1，校验 Host 头"]:::out
  MountH["Topology H<br/>Worker export default fetch<br/>或 @hono/node-server"]:::out

  Decl --> Check
  Ports --> Check
  Check --> Reg --> App --> Fetch
  Fetch --> MountL --> Loop
  Fetch --> MountH
```

| 路由组 | 路径 | 挂载条件 | 凭据类别 |
| --- | --- | --- | --- |
| 配对与认证 | `POST /byok/pair`、`/byok/challenge`、`/byok/token` | 总是挂载 | public |
| 能力声明 | `GET /byok/capabilities` | 总是挂载 | public |
| 回执 | `PUT /byok/agent-home-projections/:requestId/completion`；`PUT`、`GET /byok/input-preparations/:requestId…` | 总是挂载 | device |
| 投递 | `GET /byok/events` | `events.longpoll` | device |
| 回传 | `POST /byok/messages` | `messages.batch` | device |
| board | `GET /byok/board`、`POST /byok/board/:id/{claim,unclaim,status}`；`GET /byok/board/stream` | `board.coordination`，stream 另需 `board.sse` | device |
| presence 与 activity | `PUT /byok/presence`、`POST /byok/activity` | `presence.hints`、`activity.tail` | device |
| blobs | `POST /byok/blobs`、`POST /byok/blobs/:id/finalize`、`GET /byok/blobs/:id/url` | `blobs.presigned` | device |
| blob 内容代理 | `PUT`、`GET /byok/blobs/:id/content` | `blobs.contentproxy` 加 `blobContentProxy` | presigned |
| truth records | `GET /byok/records`、`GET`、`PUT /byok/records/:kind/:key` | `truth.records` 加 truth ports | proof |
| E2EE | 写：`POST /byok/e2ee/{member-key,chain,key-packages}`；读：`GET /byok/e2ee/{chain,key-packages,pairing-mac}` | `e2ee.member` 加 store | 写 proof，读 device |
| skill packs | `GET /byok/skill-packs`、`GET /byok/skill-packs/:name/files/:path` | `skills.pack` 加 store | device |
| Agent memory 投影 | `POST /byok/agent-memory-projections` | `agent.memory.projection` 加 store 与 authorizer | device |

- 路由表在 `packages/cloud/src/cloud.ts:1066-1337`，登记与读回在 `packages/cloud/src/router/registry.ts:49-81`。Host 的控制面操作（取消、审批、steer 等）没有 HTTP 路由，是 `ByokCloud` 上的方法。
- `createByokServer` 用不带参数的 `fullCapabilityDeclaration()`（`packages/server/src/index.ts:379`），这个默认声明不含 `truth.records`、`skills.pack`、`agent.memory.projection`、`e2ee.member`（`packages/cloud/src/capabilities.ts:150-170`），所以内嵌 server 不挂这四组路由，即便它传入了 `e2eeMemberStore`。
- server 把整个 cloud app 挂成兜底路由，不逐条重新声明（`packages/server/src/index.ts:400-410`）。`listenLoopback` 不由 `createByokServer` 调用，Host 自己把 handler 交给它。

## 4. 与 sdk-architecture.md 的已知差异

`sdk-architecture.md` 与源码不一致的地方列在 #927 中，修正也在那里跟踪，本文不另列清单。
