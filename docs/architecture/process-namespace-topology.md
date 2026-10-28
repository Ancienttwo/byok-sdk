# 进程与命名空间拓扑 + 挂载层

> **定位**：审查视图。当前规范见[当前功能架构](current-architecture.md)；本页给出逐条证据与 Remarks。之后的修订以本页的文件历史为准。
> **核对基准**：commit `671309da`（2026-10-28）。文中 `path:line` 均指这一版，路径相对仓库根。
> **事实优先级**：源码 > `docs/spec.md` > 本文。本文是手写视图，ArchContext 不投影它。
> **配套**：[当前功能架构](current-architecture.md) · [总分层架构、模块与时序](layered-architecture.md) · [`host-runtime-isolation-matrix.md`](../host-runtime-isolation-matrix.md) · [`host-local-storage-layout.md`](../host-local-storage-layout.md) · [Architecture Index](index.md)
> **用途**：定位进程、身份与目录边界。`R-Tx` 指向本文 [Remarks](#remarks)，`R-Lx` 指向[分层文档的 Remarks](layered-architecture.md#remarks)。

本文的"命名空间"和"挂载"指代码里实际存在的三样东西：进程树与进程组；身份 keyspace 与目录树；daemon 交给每个 runtime 子进程的 cwd、环境变量和配置文件。SDK 不创建内核 namespace、bind mount、chroot 或容器，`packages/client` 与 `packages/keys` 里检索 `unshare`、`bwrap`、`sandbox-exec`、`landlock`、`chroot`、`seccomp` 均无结果，与 [`host-runtime-isolation-matrix.md`](../host-runtime-isolation-matrix.md) 一致。需要 OS 级隔离时由 Host 自己包一层。

术语：

- `storeDir`：一个 productId 的设备侧状态根，默认 `~/.byok/<productId>`。
- 长驻进程：daemon、Topology H 的常驻 Node Host；收到信号或服务管理器停止才退出。
- 每任务进程：runtime 根进程及其后代，任务释放时整组回收。

## 1. 进程拓扑

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
    HostH["Topology H<br/>Worker 或常驻 Node<br/>createByokCloud<br/>Postgres + R2"]:::host
    PG[("Postgres<br/>LISTEN byok_mailbox_wake<br/>仅常驻 Node")]:::store
    HostH -.-> PG
  end

  subgraph DEV["设备侧 · 同一 OS 用户"]
    SM["服务管理器<br/>launchd · systemd --user<br/>WinSW"]:::helper
    Cli["byok-agent 子命令"]:::helper
    Ctl(["控制通道<br/>control.sock 或命名管道<br/>HMAC · control.token"]):::daemon
    Daemon["byok-agent start<br/>createDaemon"]:::daemon
    Gate(["工具授权闸门<br/>127.0.0.1:随机端口<br/>每 runtime 一个"]):::daemon
    Ledger[("owned-processes/<br/>POSIX 进程组台账")]:::store
    Direct["直接子进程，不建组<br/>git · memory helper<br/>MCP 探测 · 凭据命令"]:::helper

    subgraph GC["进程组 · Claude"]
      Claude["claude -p<br/>stream-json"]:::runtime --> McpC["MCP servers<br/>按 --mcp-config"]:::runtime
    end
    subgraph GX["进程组 · Codex"]
      Codex["codex app-server"]:::runtime --> McpX["MCP servers<br/>按 thread/start"]:::runtime
    end
    subgraph GP["进程组 · Pi"]
      Launcher["keys launcher<br/>可选"]:::runtime --> PiHost["Pi host byok-pi-*<br/>McpServerPool"]:::runtime
    end
    subgraph GD["进程组 · Pi 工具 shell"]
      Shell["/bin/bash -c"]:::runtime
    end
    subgraph GH["进程组 · Host 注入"]
      Hermes["hermes gateway<br/>hermes --yolo acp"]:::runtime
      Grok["grok agent stdio"]:::runtime
    end

    SM --> Daemon
    Daemon -->|"监听"| Ctl
    Cli -->|"连接"| Ctl
    McpC -.->|"保留 helper 回拨"| Ctl
    Daemon --> Claude
    Daemon --> Codex
    Daemon --> Launcher
    PiHost --> Shell
    Daemon --> Hermes
    Daemon --> Grok
    Daemon --> Direct
    Daemon --> Ledger
    Daemon -->|"监听"| Gate
    Claude -.->|"auto 模式"| Gate
    PiHost -.->|"auto 模式"| Gate
  end

  Box["Host 自备的 OS 边界<br/>SDK 不提供"]:::absent

  HostL <-->|"HTTP 环回"| Daemon
  HostH <-->|"HTTPS"| Daemon
  Box -.- DEV
```

| 进程 | 生命周期 | 谁启动 | 证据 |
| --- | --- | --- | --- |
| Topology L Host | 长驻，内嵌 `createByokServer`；Host 自己把 handler 交给 `listenLoopback`，只绑 `127.0.0.1` 并校验 Host 头 | Host | `packages/server/src/loopback.ts:84` |
| Topology H Host | Worker 按请求；常驻 Node 另开一条 session 模式 Postgres 连接 `LISTEN` | Host | `packages/cloud-dataplane/src/mailbox-wake.ts:10-19,99` |
| daemon | 长驻；服务管理器的命令行是 `<node> <byok-agent> start --config <abs> --service` | launchd `gui/<uid>` LaunchAgent、systemd user unit、WinSW | `packages/client/src/lifecycle/service-types.ts:63`；`lifecycle/launchd.ts`、`systemd.ts`、`winsw.ts` |
| runtime 根进程 | 每任务；`detached: true`，各自成为进程组 leader | daemon | `packages/client/src/adapters/process-tree.ts:54-60` |
| keys launcher | 每任务，可选；以继承的 stdio 启动 Pi host。rpc 与 durable lane 的 provider key 走私有 IPC；prepared lane 不运行原生工具，key 经环境变量 `PI_PROVIDER_API_KEY` 交给它 | daemon | `packages/keys/src/pi-provider-launcher-core.ts:548-552,586-592` |
| durable Pi 工具 shell | 每次工具调用；`/bin/bash`（缺失时 `/bin/sh`）`-c`，`detached: true` | Pi host | `packages/client/src/adapters/pi-durable/shell.ts:28-32` |
| SDK 保留 MCP helper | 随 runtime；`byok-agent-message-mcp`、`-result-mcp`、`-memory-mcp`、`-team-mcp`，经控制通道回拨 daemon | runtime 当作 MCP server 拉起 | `packages/client/src/bin/sdk-reserved-helper-runners.ts:30-40,146-160` |
| 工具授权闸门 | 每 runtime 一个 loopback HTTP server，仅 `auto` 模式 | daemon 进程内 | `packages/client/src/tool-authorization-ipc.ts:74-103` |
| 直接子进程 | 短命，不建组 | daemon | git、memory helper、`daemon/mcp-tools-probe.ts`、`daemon/device-credential-store.ts` |

- **内置与注入**：`createDaemon` 只构建 pi、claude、codex（`packages/client/src/daemon/create-daemon/support.ts:288-292`）；Hermes 与 Grok 由 Host 经 `createDaemonWithAdapters` 加入。
- **控制通道**：POSIX 用 `<storeDir>/control.sock`，路径过长时退到 `/tmp/byok-<hash>/sock`（`packages/client/src/daemon/control-protocol.ts:119-121`）；Windows 用 `\\.\pipe\byok-<id>`（`:147`）；双方用 `control.token` 做 HMAC-SHA256 双向认证，token 本身不上线（`:180-193`）。能以 daemon 同一 OS 用户运行的进程都能读到这个 token，这是同用户信任边界（R-T2）。

## 2. 受监督执行协议

runtime 根进程的所有权由 `withOwnedProcessTree` 统一管理。POSIX 用进程组加台账，Windows 用 kill-on-close Job Object 加 `taskkill /T /F`。

```mermaid
sequenceDiagram
  autonumber
  participant D as daemon
  participant L as owned-processes/ 台账
  participant PT as withOwnedProcessTree
  participant R as runtime 进程组

  Note over D,L: 启动：先 reconcile，再准入任何 offer
  D->>L: reconcile()
  alt 有残留组
    L->>R: 按记录 SIGKILL 整组
    alt 仍有幸存
      L-->>D: OwnedProcessResidueError，拒绝启动
    else 全部结束
      L-->>D: 删除记录，继续
    end
  end
  D->>PT: spawn runtime，detached
  PT->>L: adopt：写入 pgid
  PT->>R: 运行
  Note over D,R: 释放：终态之后，Session.close()
  D->>PT: dispose
  PT->>R: 记下后代，对整组 SIGTERM
  PT->>PT: 等待 750 ms
  PT->>R: SIGKILL 整组与已离组的后代
  PT->>L: 删除记录
```

- 默认宽限 750 ms（`packages/client/src/adapters/process-tree.ts:8`）；SIGTERM 前先记下根进程的后代，包括已经离开进程组的，直到它们也收到 SIGKILL（同文件 `:19`、`:503`）。
- 台账目录 `owned-processes/`（`packages/client/src/daemon/owned-process-ledger.ts:36`）；`reconcile` 有幸存者就抛错（`:98-106`），daemon 在准入之前调用它（`packages/client/src/daemon/create-daemon/start-run.ts:40-44`）。Windows 不写台账，Job Object 已经结束它们。
- Windows 释放以 `taskkill /T /F` 报告遍历到的 pid 集合判断是否静止，不看退出码（`packages/client/src/adapters/process-tree.ts:17`；`adapters/taskkill-pid-set.ts`；`adapters/win32-job-object.ts`）。

## 3. 命名空间拓扑

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
  Appr["approvalId<br/>每 task 至多一个待审批"]:::id
  Tenant --> Product --> Device --> Agent --> Task --> Appr

  Store["storeDir<br/>默认 ~/.byok/&lt;productId&gt;"]:::fs
  Cred["OS 凭据库<br/>设备私钥与 bearer token"]:::os
  Keys["OS 凭据库<br/>com.byok.keys.scope.…<br/>provider key"]:::os
  Home["Agent home<br/>hostStorageRoot/agents/<br/>&lt;agentId&gt;/"]:::fs
  Runs[".byok/runs/&lt;taskId&gt;/<br/>memory-reader 的 cwd"]:::fs
  Exec["tmp/exec/&lt;token&gt;/<br/>每次执行一个 token"]:::fs

  Product -->|"路径键"| Store
  Product -->|"service 名"| Cred
  Agent -->|"路径键"| Home
  Task --> Runs
  Task --> Exec
  Store -.->|"包含"| Exec
  Home -.->|"包含"| Runs
```

storeDir 的内容（Agent home 的布局见 [`host-local-storage-layout.md`](../host-local-storage-layout.md)）：

```text
<storeDir>/                        默认 ~/.byok/<productId>
  device.json                      enrollment 的非秘密投影；私钥与 token 在 OS 凭据库
  cursor-<hash>.json               已落盘的 mailbox cursor
  daemon.db                        本机 journal（SQLite）
  control.sock  control.token      控制通道与 HMAC 密钥
  mutex.sock  daemon-owner.json    单 daemon 所有权
  owned-processes/                 POSIX 进程组台账
  skill-packs/<name>/<hash>/       skill pack 安装根
  tmp/exec/<token>/sdk/            SDK 写给 runtime 的配置，释放即删
  tmp/exec/<token>/runtime/        子进程的 TMPDIR，由 retention 清理
```

| 名字空间 | 规则 | 证据 |
| --- | --- | --- |
| storeDir | `DeviceStore.resolveDir(productId, config.storeDir)`，默认 `~/.byok/<productId>`。同一 productId 的 daemon 与 CLI 共用，`mutex.sock` 与 `daemon-owner.json` 保证只有一个 daemon 持有它。 | `packages/client/src/daemon/store.ts:210,222`；`packages/client/src/daemon/daemon-owner.ts:12,92` |
| cursor 与 journal | `cursor-<key>.json` 按 server 与 device 分键；journal 是单库 `daemon.db`。 | `packages/client/src/daemon/cursor-store.ts:32`；`packages/client/src/daemon/journal/sqlite-journal.ts:69` |
| 执行 scratch | 每次执行一个 12 位十六进制 token；`sdk/` 释放即删，`runtime/` 写 `released` 标记后由 retention 清理；路径放不下 Unix socket 时改到 `/tmp/byok-scratch-<hash>`（macOS `/private/tmp`）。 | `packages/client/src/daemon/retention/scratch.ts:28,60,158-187` |
| Agent home | `hostStorageRoot/agents/<agentId>/`；`.byok/` 是其中唯一的 SDK 保留区，路径由 SDK 拼接并拒绝 symlink 与越界。 | `packages/client/src/agent-home.ts:27-28` |
| 设备凭据 | 设备私钥与 bearer token 整条存在 OS 凭据库：macOS `/usr/bin/security`，Linux `secret-tool`，Windows 经 PowerShell 编译的 credential bridge。 | `packages/client/src/daemon/device-credential-store.ts:71-76,331,344` |
| provider key | 由 `@byok-sdk/keys` 存放，service 名形如 `com.byok.keys.scope.acct_<hash>.<name>`。 | `packages/keys/src/secret-name.ts`、`secret-scope.ts` |
| approvalId | 每个 task 同时至多派发一个，其余在 daemon 内排队；cloud 侧由 timeline 尾部折叠出当前槽。 | `packages/client/src/daemon/task-runner/approvals.ts:25-46`；`packages/cloud/src/approval-control.ts:14-35` |

## 4. 挂载层

### 4.1 设备侧：runtime 子进程看到什么

```mermaid
flowchart LR
  classDef src fill:#9a3412,stroke:#fed7aa,stroke-width:2px,color:#fff
  classDef how fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
  classDef rt fill:#0f766e,stroke:#99f6e4,stroke-width:2px,color:#fff

  subgraph SRC["daemon 准备的来源"]
    direction TB
    Cwd["工作目录<br/>Agent home（writer）<br/>.byok/runs/&lt;taskId&gt;（reader）"]:::src
    Tmp["tmp/exec/&lt;token&gt;/runtime"]:::src
    Mcp["本任务的 MCP server 列表<br/>Host toolsets 与保留 helper"]:::src
    Sdk["tmp/exec/&lt;token&gt;/sdk<br/>0600 配置文件<br/>mcp-config.json · rpc-launch.json"]:::src
    Env["daemon 环境变量<br/>去掉 CLAUDECODE 与 BYOK_*"]:::src
    GateEnv["工具授权闸门地址与 token<br/>仅 auto 模式"]:::src
    User["用户自己的 agent 配置<br/>~/.claude · CODEX_HOME"]:::src
  end

  subgraph HOW["绑定方式（无内核 mount）"]
    direction TB
    B1["spawn 的 cwd，取 realpath"]:::how
    B2["TMPDIR · TEMP · TMP"]:::how
    B3["命令行参数<br/>claude --mcp-config / --settings<br/>codex -c sandbox_mode"]:::how
    B4["协议消息携带 MCP 列表<br/>Codex thread/start<br/>ACP session/new"]:::how
    B5["SDK 设置的目录变量<br/>PI_CODING_AGENT_DIR · HERMES_HOME"]:::how
    B6["原样继承<br/>不改 HOME · CLAUDE_CONFIG_DIR<br/>CODEX_HOME"]:::how
    B7["Claude：stdio control hook<br/>Pi：rpc-launch.json 交给 Pi host<br/>Pi host 再经环境变量交给子会话"]:::how
  end

  RT["runtime 子进程<br/>claude · codex · pi<br/>hermes · grok"]:::rt

  Cwd --> B1 --> RT
  Tmp --> B2 --> RT
  Mcp --> Sdk
  Mcp --> B4 --> RT
  Sdk --> B3 --> RT
  Sdk --> B5 --> RT
  Env -->|"spawn env"| RT
  GateEnv --> B7 --> RT
  User --> B6 --> RT
```

| runtime | 启动命令（节选） | MCP server 由谁拉起 | 权限相关参数 | `auto` 工具授权 |
| --- | --- | --- | --- | --- |
| Claude，内置 | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | claude 按 `--mcp-config` 文件拉起 | 默认 `--dangerously-skip-permissions`；Host 开启 native interactions 时改为 `--permission-prompt-tool stdio --permission-mode acceptEdits` | 支持，PreToolUse hook 走 stdio control |
| Codex，内置 | `codex app-server -c sandbox_mode=… --listen stdio://` | codex 按 `thread/start` / `thread/resume` 的 `mcp_servers` 拉起 | `approvalPolicy` 默认 `never`；`sandbox_mode` 默认 `danger-full-access`，`codexSandbox: 'inherit'` 时不覆盖 | 不支持，`auto` 会被 decline |
| Pi，内置 | Pi host bin，可经 `byok-pi-provider-launcher` 启动 | Pi host 的 `McpServerPool`，配置在 `sdk/rpc-launch.json` | 预信任会话 cwd | 只在普通 `pi-rpc` lane 支持，loopback IPC；prepared offer 与 durable lane 在准入时以 `tool_authorization_unsupported` decline（durable 的 descriptor 不声明 `toolAuthorizationAuto`，启动时的检查只是兜底） |
| Hermes，Host 注入 | `hermes gateway run --quiet --external-supervisor --force` 与 `hermes --yolo acp` | Hermes 按 ACP `session/new` 的 `mcpServers` 拉起 | `--yolo` | 不支持 |
| Grok，Host 注入 | `grok agent --always-approve --no-leader stdio` | Grok 按 ACP `session/new` 的 `mcpServers` 拉起 | `--always-approve` | 不支持 |

出处：`packages/client/src/adapters/claude/claude-adapter.ts:128-139,344-366`；`packages/client/src/adapters/codex/codex-adapter.ts:49-65,236,271`；`packages/client/vendor/oar/51b83c9/runtimes/codex/app-server-client.ts:110`；`packages/client/vendor/oar/51b83c9/runtimes/codex/open.ts:112,137`；`packages/client/src/adapters/pi/pi-adapter.ts:227,436-440,525-555`；`packages/client/src/adapters/hermes/hermes-adapter.ts:100,335,346`；`packages/client/vendor/oar/51b83c9/runtimes/grok/session.ts:144`；`auto` 准入见 `packages/client/src/daemon/task-runner/offer-launch.ts:61`。

- **环境变量**：`buildRuntimeEnv` 继承 daemon 的完整环境，只去掉 `CLAUDECODE` 与 `BYOK_*`（`packages/client/src/daemon/environment.ts:1-11,102-103,154`），再叠加 scratch 的 `TMPDIR`、`TEMP`、`TMP`（`packages/client/src/daemon/retention/scratch.ts:187`）。环境里的 provider key 等秘密会传到 agent 子进程（R-T1）。窄 allowlist `buildAllowlistedEnv` 用在 durable Pi 工具 shell、Pi 受控目录 lane，以及经 launcher 或 custody 的 Hermes（`adapters/pi-durable/environment.ts:7`；`adapters/pi/runtime-launch.ts:93`；`adapters/hermes/hermes-adapter.ts:228,262,325`；R-T4）。
- **目录变量**：`PI_CODING_AGENT_DIR` 只在经 keys launcher 时指向 launcher 的投影目录（`packages/keys/src/pi-provider-launcher-core.ts:396`）；`HERMES_HOME` 指向每次运行新建的 profile `<Hermes home>/profiles/byok-<id>`（`packages/client/src/adapters/hermes/hermes-home.ts:98-104`；`hermes-adapter.ts:100`）。
- **Claude 的 `agentUserContext: 'excluded'`**：只对 Agent 任务生效，加 `--strict-mcp-config` 与 `--settings <sdk>/claude-settings.json`，排除 Agent home 之外的 `CLAUDE.md` 和 auto memory（`packages/client/src/adapters/claude/claude-adapter.ts:105-106,297-314`；`adapters/claude/agent-user-context.ts:17`）。
- **skill packs** 只装到 `<dataDir>/skill-packs/<name>/<hash>/`，由 Host 调 `projectSkillPack` 复制到它选的目录；SDK 不替 runtime 决定技能目录（`packages/client/src/daemon/skill-pack-installer.ts:20-32,72`）。

### 4.2 Host 侧：按能力声明挂载 HTTP 路由

```mermaid
flowchart TB
  classDef in fill:#374151,stroke:#d1d5db,stroke-width:2px,color:#fff
  classDef kernel fill:#5b21b6,stroke:#ddd6fe,stroke-width:2px,color:#fff
  classDef out fill:#1e40af,stroke:#bfdbfe,stroke-width:2px,color:#fff

  Decl["capability 声明<br/>server 固定用 fullCapabilityDeclaration()"]:::in
  Ports["注入的 ports<br/>blobContentProxy · truthCommitter<br/>skillPacks · e2eeMemberStore 等"]:::in
  Check["assertNoOverDeclaration<br/>声明了但缺 port：构造失败<br/>有 port 但未声明：不挂载"]:::kernel
  Reg["CloudRouteRegistry.register<br/>public · device · proof · presigned"]:::kernel
  App["私有 Hono app<br/>mounted 读回 app.routes"]:::kernel
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
| 配对与认证 | `POST /byok/pair`、`/byok/challenge`、`/byok/token` | 总是挂载；可选限流 | public |
| 能力声明 | `GET /byok/capabilities` | 总是挂载 | public |
| 回执 | `PUT /byok/agent-home-projections/:requestId/completion`；`PUT`、`GET /byok/input-preparations/:requestId…` | 总是挂载 | device |
| 投递 | `GET /byok/events` | `events.longpoll` | device |
| 回传 | `POST /byok/messages` | `messages.batch` | device |
| board | `GET /byok/board`、`POST /byok/board/:id/{claim,unclaim,status}`；`GET /byok/board/stream` | `board.coordination`，stream 另需 `board.sse` | device |
| presence 与 activity | `PUT /byok/presence`、`POST /byok/activity` | `presence.hints`、`activity.tail` | device |
| truth records | `GET /byok/records`、`GET`、`PUT /byok/records/:kind/:key` | `truth.records` 加 truth ports | proof |
| E2EE | 写：`POST /byok/e2ee/{member-key,chain,key-packages}`；读：`GET /byok/e2ee/{chain,key-packages,pairing-mac}` | `e2ee.member` 加 store | 写 proof，读 device |
| skill packs | `GET /byok/skill-packs`、`GET /byok/skill-packs/:name/files/:path` | `skills.pack` 加 store | device |
| blobs | `POST /byok/blobs`、`POST /byok/blobs/:id/finalize`、`GET /byok/blobs/:id/url` | `blobs.presigned` | device |
| blob 内容代理 | `PUT`、`GET /byok/blobs/:id/content` | `blobs.contentproxy` 加 `blobContentProxy` | presigned |
| Agent memory 投影 | `POST /byok/agent-memory-projections` | `agent.memory.projection` 加 store 与 authorizer | device |

- 路由表在 `packages/cloud/src/cloud.ts:1077-1340`，登记与读回在 `packages/cloud/src/router/registry.ts:50-81`。Host 的控制面操作（取消、审批、steer 等）没有 HTTP 路由，是 `ByokCloud` 上的方法（`cloud.ts:1341-1345`）。
- `createByokServer` 用不带参数的 `fullCapabilityDeclaration()`（`packages/server/src/index.ts:418`），默认声明不含 `truth.records`、`skills.pack`、`agent.memory.projection`、`host-mcp-task-context`、`e2ee.member`（`packages/cloud/src/capabilities.ts:157-178`），所以内嵌 server 不挂这几组路由，即便它传入了 `e2eeMemberStore`（R-L3）。
- server 把整个 cloud app 挂成兜底路由，不逐条重新声明（`packages/server/src/index.ts:440-449`）。

## Remarks

| ID | 级别 | 问题 | 证据 | 方向 |
| --- | --- | --- | --- | --- |
| R-T1 | 高 | 默认环境是完整继承：除 `CLAUDECODE` 与 `BYOK_*` 外，daemon 环境里的任何秘密都会进入 agent 子进程及其 MCP server。这是有意的（用户自己的 agent 读自己的凭据），但 Host 需要知道。 | `packages/client/src/daemon/environment.ts:1-11,102-103` | 在 Host 文档里明确；需要收窄时由 Host 以干净环境启动 daemon，或扩展 allowlist lane。 |
| R-T2 | 中 | 设备侧所有本地认证（`control.token`、工具授权闸门 token）都只防跨用户，不防同用户进程。工具授权闸门的 token 还通过环境变量传给 SDK 子会话。 | `packages/client/src/daemon/control-protocol.ts:180-193`；`packages/client/src/tool-authorization-ipc.ts:5-17` | 保持现状并写进 [`security.md`](../security.md)；`auto` 不是沙箱，见 `tool-authorization.ts:5-13`。 |
| R-T3 | 中 | `auto` 工具授权只有 Claude 与普通 Pi RPC lane 支持。Codex、Hermes、Grok 与 prepared offer 收到 `auto` 会被 decline，durable Pi 在启动时失败。Host 若默认 `auto`，这些组合实际不可用。 | `packages/client/src/daemon/task-runner/offer-launch.ts:61`；`adapters/claude/claude-adapter.ts:166`；`adapters/pi/pi-adapter.ts:227,436-440` | Host 侧按 runtime 选模式；或为 Codex 接 app-server 的审批事件。 |
| R-T4 | 低 | `environment.ts` 的文件头说 `buildAllowlistedEnv` "只有两个 Pi lane 使用"，实际 Hermes 在 launcher 或 custody 下也用它。 | `packages/client/src/daemon/environment.ts:13-14`；`packages/client/src/adapters/hermes/hermes-adapter.ts:228,262,325`；`adapters/hermes/hermes-custody.ts:38` | 更新注释。 |
