# WP3A 本地执行边界实施包（2026-09-03）

Status: Design packet (executable). Baseline `main@4cc765f`.
Upstream decision (不再重开): `docs/researches/2026-09-03_architecture-review.md` §8 WP3A / §12 / D4。
本包只做 WP3A：AgentHome / SessionState / Workspace 三分，Workspace 单写者，Git worktree 作 backend。
不含 WP3B（server 折叠）、WP4（wire v2）、WP5（结果事务）、WP6（runtime parity）。

所有 `file:line` 基于 `main@4cc765f`，除非标 `[unverified]`。

---

## 1. 现状本地模型清单

| 组件 | 位置 | 今天守的不变量 |
|---|---|---|
| `AgentHomeLayout` | `packages/client/src/agent-home.ts:250-362` | `<hostStorageRoot>/agents/<agentId>` 由 SDK 独占组合（`:265-274`）；existing-ancestor + realpath + 逐段拒 symlink（`materializeDirectory:185`、`ensureDirectoryNoSymlink:207`）；同一 canonicalHome 不得绑两个 agentId（`:275-280`）；root 变更与 relocation 走同一 `agent-home-root` path gate（`:353-361`） |
| `AgentHomeLeaseManager` | `agent-home.ts:406-558` | canonical home 的**单 mutable writer**：进程内静态 `held` map 先于任何 await 占位（`:419-424`），磁盘 marker `<home>/.byok/agent-home.lease` 记 `{version,ownerId,leaseId,agentRef,canonicalHome}`（`:444-450`）；crash residue 只能被同一 `stableAgentHomeOwnerId(storeDir, productId)`（`:373-376`）回收；持锁时捕获 `homeIdentity {dev,ino}`（`:433`） |
| `AgentHomeExecutionLeaseManager` | `agent-home.ts:572-696` | **这是 V2 的根因**。按 `(task\|session)\0<value>` 排他（`executionKey:560-568`），同一 canonical home 的多个 session 共享**一个** base writer lease（`:592-598`），只有同键重入才 busy（`:600-602`），每个 execution lease 的 `cwd` 都等于 `resolution.canonicalHome`（`:614`）。即：home 级 writer lease 存在，但被降级成"进程内还有人在跑"的存在标记，不再是互斥；`bindSession` 做 task-keyed → session-keyed 的原子换键（`agent-home.ts:615-637`），只能绑一次 |
| `AgentSessionHandoffStore` | `daemon/agent-session-handoff-store.ts:252-410` | `<home>/.byok/runtime-sessions/`（`:225-226`）下 `<runtime>-<hash>.jsonl`（`sessionFileName`/`taskTerminalFileName`，`:399,:407`）；`requireMatch`（`:277`）要求 agentRef/profileRevision/runtime/**cwd**/sessionRef 全等，任一不符 fail-closed。**cwd 是匹配字段之一**——改 cwd 即让所有历史 handoff 失配 |
| `SessionWorkspaceStore` | `daemon/session-workspace-store.ts:5-15`，文件 `<storeDir>/session-workspaces.json`（`:112-114`） | `sessionRef → {workspaceDir, runtimeSessionId, workspaceKind?, gitWorkspaceId?}`；`workspaceKind` 省略读作 `plain`（`docs/spec.md:741` 明写这是"一次性有界迁移语义"）；只服务 legacy 非 Agent 路径（`task-runner.ts:1868,:1904,:2281`） |
| `GitWorkspaceManager` | `daemon/git-workspace.ts:260-495` | `acquireLease(workspaceDir, sessionRef)` 只是**两个进程内 Map**（`workspaceLeases`/`sessionLeases`，`:218-219`；`:385-405`），无磁盘 marker、无跨进程保护；owner marker 是目录内 `.byok-git-workspace-owner.json`（`:97`）；git 子进程剥掉 `GIT_ENV_KEYS` 里 **20** 个具名 `GIT_*` 变量（`:99-120`），外加 `GIT_OPTIONAL_LOCKS` 与整个 `GIT_CONFIG_(KEY|VALUE)_<n>` 家族（正则剥离，`:126`；read-only 时再显式回写 `GIT_OPTIONAL_LOCKS=0`，`:128`） |
| `GitWorkspaceStore` | `daemon/git-workspace-store.ts:8-32,63-73` | `<storeDir>/git-workspaces.json` 单文件全量重写 + 串行队列；`MAX_RECORDS = 500`（`:32`）；phase 机（`:7`）；启动把 `preparing`/`active` 改 `interrupted` |
| operation manifest | `packages/client/src/types.ts:264-290`、`sealRuntimeOperationManifest:364-396` | `cwd`（`:277`，注释明写"for an Agent task this is the Agent home root"）、`workspace {workspaceDir, workspaceId?, baseline?}`（`:283-287`）、`agentRef`、`lease {leaseId, canonicalHome}`（`:280-282`）。`cwd` 缺省回落 `workspace.workspaceDir`（`:389`）。**这是 client 内部类型，不上 wire**，但在 WP1 `.d.ts` golden 内 |
| 组装点 | `daemon/task-runner.ts:1807-1937` | `acquireExecution`（`:1808`）→ `workspaceDir = agentBinding.lease.cwd`（`:1827`）→ handoff `requireMatch`（`:1830-1836`）→ `initializeExecution`（`:1843`）→ message outbox（`:1853`）→ seal manifest（`sealRuntimeOperationManifest`，`:1915-1940`）→ `task.claim`（`:1945`）。Agent 分支与 git/plain 分支三选一互斥（Agent 分支头 `:1807`，git 分支头 `:1867` 的 `else if (this.deps.gitWorkspaceManager && …)`，plain 分支头 `:1903`，第四条 `else`（`:1907`）直接 decline） |
| memory 投影与本地 CAS | `daemon/agent-memory.ts` | 本地 CAS 是 **sha256 内容 revision**：`AgentMemoryRevisionConflictError(expectedRevision, actualRevision)`（`:35`），`replaceInternalFile` 读-比-写-复检（`:317-332`）；路径白名单只允许 `MEMORY.md` 或 `notes/**.md`（`:124-128`）；写操作在 `withPinnedDirectory(canonicalHome, ..., homeIdentity)` 下钉住 dev/ino（`:490`）；hosted 投影 outbox `<home>/.byok/agent-memory-redacted-outbox-v2.json`（`:17,:613`），带 `currentWriterEpoch` fencing（`:619,:662`）。**云端 CAS 是另一套**：`packages/core/src/truth.ts:74,:109` 的数值 `expectedRev` |
| memory 可达性 | `daemon/memory-guidance.ts:7-13`、`task-runner.ts:2063-2064` | prompt-only：`"read \`MEMORY.md\` in the provided \`cwd\`"`。**cwd 一变即失效**。MCP 侧相反：`withAgentMemoryMcp:2337-2362` 只传一个不透明 context token，canonicalHome 由 daemon 从 sealed task 反查（`activeMemoryContext:2364+`、`:2397,:2440`）——已经与 cwd 无关（verified） |
| `local-state-relocation.ts` | `:165-262` | 一次性搬迁租约。只 gate 两个 scope：`store`（源/目的 storeDir）与 `agent-home-root`（源/目的 `<root>/agents`）（`:215-220`），并要求 daemon store 与 agent-home root 静默（`:223-226`）。**没有 workspaces scope** |
| `.byok` 命名空间 | `AGENT_HOME_INTERNAL_DIRECTORY = '.byok'`，`agent-home.ts:21` | `agent-home.lease`（`:440-442`）、`agent-home-projection.json`（`:22`、`projectionStatePath:700-706`）、`egress/reliable-v1.jsonl`（`agent-egress-spool.ts:13-14,:212`）、`messages/outbox-v1.jsonl`（`agent-message-outbox.ts:16-17,:81`）、`runtime-sessions/*.jsonl`（`agent-session-handoff-store.ts:225`）、`agent-memory-redacted-outbox-v2.json`（`agent-memory.ts:17`）、`agent-memory-audit-v1.jsonl`（`agent-memory.ts:15`）。`MEMORY.md`/`notes/` 在 home 根、**不在** `.byok` 内，且 `.byok` 被显式列为不可读内容名（`agent-memory.ts:127`、`agent-content-read.ts:206-208`） |
| wire 版本 | `packages/protocol/src/version.ts:27` | `PROTOCOL_VERSION = 1`，FROZEN，由 `__tests__/golden/v1.frozen.json` + `freeze-guard.test.ts` 守住 |
| 并发配额 | — | main 上 `maxConcurrent*` 在 `packages/{client,protocol,core}/src` 生产源**零命中**（verified）。WP0 分支 `codex/agent-home-single-writer` tip = `5a2211e`（PR #125）（`feat(client): one active Attempt per canonical Agent home by default`），vs `origin/main` **14 files / +1359 / −11**，**尚未合入 main**（verified 2026-09-03）。实现已在该分支上完整落地：配置键 `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome`（声明 `create-daemon.ts:311`，构造期校验 `:1194`，默认 1）→ `task-runner.ts:346` / getter `:1146` → `handleOffer` 的 per-home 准入门 `task-runner.ts:1622-1639`：用 `AgentHomeExecutionLeaseManager.activeAttemptCount(canonicalHome)`（`agent-home.ts:727`）读当前计数，`active >= limit` 即 retryable decline `agent home busy: N active attempt(s)`。租约层**只计数、不设上限**（`agent-home.ts:613-623` 的类注释明写），上限是 `handleOffer` 的一次性准入判定。counts-only readback `AgentHomeExecutionStatus{maxConcurrentMutableSessionsPerAgentHome, activeHomes, activeAttempts}`（`agent-home.ts:588-595`）投进 `Daemon.status()` 与本地控制面状态；golden `api-surface/client.d.ts:1062` 同刀更新。**两处形状要点**：该门位于 `admissionGuard` **之前**，且计数键用 `layout.canonicalHomePath()` 而非 `resolve()`（`task-runner.ts:1626`），以免为一个将被拒的 offer 建 `agents/<agentId>` 或绑 Agent 身份 |

`worktree` 一词在 `packages/client/src` 零命中（verified）：git worktree 是纯新增能力。

---

## 2. 目标磁盘布局

```text
<hostStorageRoot>/
  agents/<agentId>/                 ← 不再是 runtime cwd
    MEMORY.md                       create-if-missing, preserve
    notes/                          create-if-missing, preserve
    profile.json                    host 投影 hook 所有，SDK 不解析
    .byok/
      agent-home.lease              短租（元数据），不再整轮持有
      agent-home-projection.json
      agent-state/                  ← 新：egress/、content-read-audit、messages/ 迁入
      sessions/<sessionId>/         ← 新：取代 runtime-sessions/<runtime>-<hash>.jsonl
        handoff.json                native locator + runtime + workspaceId
        terminal.jsonl
      result-outbox/                ← 新：memory outbox v2 + 终态结果暂存
    …                               既有不透明 Agent 文件，原地保留
  workspaces/<workspaceId>/         ← 新：runtime cwd
    …                               backend 决定内容
```

**移动的**：`.byok/runtime-sessions/` → `.byok/sessions/<sessionId>/`（一次性重写，见 §6）；`.byok/egress/`、`.byok/messages/`、`content-read-audit-v1.jsonl` → `.byok/agent-state/`（纯改常量，同一租约域内）。
**新增的**：`.byok/sessions/`、`.byok/agent-state/`、`.byok/result-outbox/`、`<hostStorageRoot>/workspaces/`、`<storeDir>/workspaces/<workspaceId>.json`（每 workspace 一文件，非单一 ledger——理由见 §8）、`<storeDir>/workspace-leases/<workspaceId>.lease`。
**不动的**：`MEMORY.md`、`notes/`、`agent-home.lease`、`agent-home-projection.json` 路径与语义。

注意仓库里有**两个不同的 `.byok`**：`<storeDir>` 默认是 `~/.byok/<productId>`（`daemon/store.ts:162-163`），而 Agent home 内的 `.byok` 是 `AGENT_HOME_INTERNAL_DIRECTORY`（`agent-home.ts:21`）。本包新增的 `workspace-leases/`、`workspaces/*.json` 属**前者**（私有 store，已有 `ensureSecureDir` 与 Windows DACL 硬化），不进 Agent home。

runtime cwd（按 backend）：

| kind | cwd | 材化方式 |
|---|---|---|
| `plain-directory` | `<hostStorageRoot>/workspaces/<workspaceId>` | 与 agent home 同一套 `ensureDirectoryNoSymlink` + realpath containment |
| `git-worktree{repositoryRef}` | 同上路径，该目录本身即 worktree | `git worktree add -b byok/ws/<workspaceId> <path> <base>`，base 由 host 配置显式给出 |

`git worktree add` 与 `docs/spec.md:735`「daemon 从不 branch switching」的关系：它**不切换宿主自己 checkout 的分支**，只在共享 repo 里新建保留命名空间分支并写 `worktrees/<name>` 条目。spec 该句需精确化为「从不改变 host 自身 checkout 的分支」，这是本包必须一并改的文档口径（§7 S7）。`git worktree remove` 只在 host 显式 disposal 时执行，永不自动。

**`MEMORY.md`/`notes/` 在 cwd 变成 Workspace 后如何可达 — 推荐：guidance 携绝对路径，不用 symlink，不靠 env。**

三条候选：

1. **symlink `<workspace>/MEMORY.md` → home**：直接排除。SDK 自身在 `agent-home.ts:207-229` 与 `local-state-relocation.ts:64-80` 全域拒绝 symlink 组件，自己造一个等于自毁不变量；且 Windows 建 symlink 需要 Developer Mode 或管理员，spec:749 已经承认 Windows 私有存储只能靠 DACL 硬化并 fail-closed —— 在 Windows 上这条路会把一个必成功的步骤变成条件性失败。
2. **env（`BYOK_AGENT_HOME`）**：`forwardedEnvironmentNames` 是白名单机制（types.ts:288），可以加；但模型看不到 env，除非 runtime 主动转述。作**辅助**可以，不能作权威。
3. **runtime guidance 携 SDK 提供的绝对 home 路径**（推荐）：把 `AGENT_MEMORY_GUIDANCE`（memory-guidance.ts:7-13）从常量改成 `agentMemoryGuidance({ agentHomeDir })` 函数，首行改为读 `<绝对路径>/MEMORY.md`，并显式说明 cwd 是任务工作区、home 是记忆区。理由：memory-guidance.ts:1-6 自己写明「deliberately prompt guidance only」——prompt 就是这个 datum 的唯一权威，改权威本身而不是加第二条通道。MCP 侧已经与 cwd 无关（`:2337-2362` verified），无需改动。

采纳 3，附带 2 作为可选 env（同一个值，不构成第二权威：env 由同一个 binding 派生并列入 `forwardedEnvironmentNames`）。

---

## 3. 身份与租约

```ts
export type WorkspaceBackend =
  | { readonly kind: 'plain-directory' }
  | { readonly kind: 'git-worktree'; readonly repositoryRef: string };

export interface WorkspaceRef {
  /** 一个有界可移植路径段（含 Windows 保留名/尾点空格拒绝），复用 validateAgentRef 的段校验 */
  readonly workspaceId: string;
  readonly backend: WorkspaceBackend;
}
```

`repositoryRef` 是 **host 预注册的 id**，不是路径。daemon 配置里 `workspaces.repositories: Record<repositoryRef, absolutePath>`；wire 或调用方永远不能传裸路径。这与 WP6 的 `RuntimeRef` 本地预注册同形，也是 v1 阶段能"host-config-derived"的关键（§5）。不加 `mutable` 字段：今天不存在只读 Workspace，加了就是无消费者的抽象。

三条租约，各守一个不变量：

| 租约 | 键 | 语义 | 实现 |
|---|---|---|---|
| **Workspace writer lease** | canonical workspace dir | mutable Workspace **恰好一个 writer** | 新 `WorkspaceLeaseManager`，照抄 `AgentHomeLeaseManager:406-558` 的双层结构：进程内静态 map 先占（`:419-424`）+ 磁盘 marker。marker 放 `<storeDir>/workspace-leases/<workspaceId>.lease`，**不放 workspace 目录内**（git worktree 里多一个文件就是 untracked 污染）。crash residue 复用 `stableAgentHomeOwnerId` 同形的 owner id |
| **Session run 串行租约** | `sessionId`（v1 阶段 = `sessionRef`；无 session 时 task-keyed） | 同一 Session 的 Run 串行 | 直接复用 `AgentHomeExecutionLeaseManager` 的 `executionKey:560-568` + `bindSession:622-648`，但**把作用域从 canonicalHome 提到进程全局**——它现在守的是 session 身份，不是目录 |
| **Home 元数据短租** | canonical home | home 内 SDK-reserved 元数据的串行 | 保留 `AgentHomeLeaseManager`，但改成**围绕单次 mutation 取放**：`initializeAgentHome`（`:684-690`）、`project`（`:868-916`，已经是这个形状）、终态 memory/result 写回、egress spool append。不再由 execution group 整轮持有（`:592-598` 删除） |

**WP0 计数怎么落到 Workspace**：WP0 已在 `codex/agent-home-single-writer` 上实现完毕、尚未合入 main（§1 给了确切形状）。本包按**一条**路径规划：WP0 先合入 main，WP3A 在其之上做替换，S3 起始动作就是读一遍已合入的 WP0 形状（§7 S3）。

WP0 的 `maxConcurrentMutableSessionsPerAgentHome` 是"把 home 当 mutable workspace"的临时止血：它把上限判定放在 `handleOffer`（`task-runner.ts:1622-1639`），把计数放在 `AgentHomeExecutionLeaseManager.activeAttemptCount`（`agent-home.ts:727`），两者以 canonical home 为键。WP3A 之后 home 不再是 mutable workspace，**这个键与这个计数门必须整体删除，不能改语义留名**——保留一个同名但含义变了的旋钮就是稳态兼容路径。正确性改由 Workspace writer lease 这个**不变量**承担（不是可调值），互斥点从 `handleOffer` 的计数比较移到租约获取本身。

可观测行为在迁移默认（每 Agent 一个 Workspace，§6）下与 WP0 默认 1 逐字等价：同一 Agent 的第二个 mutable run 仍被 retryable decline，只是 decline 文案从 `agent home busy: N active attempt(s)` 变为 workspace 口径。counts-only readback `AgentHomeExecutionStatus`（`agent-home.ts:588-595`）随之改成 workspace 口径的同形计数（`activeWorkspaces` / `activeRuns`），保持"只报计数不报正文"的既有姿态。

**Installation 资源配额 `maxConcurrentRuns`**：这是资源上限不是正确性上限，放 `handleOffer` 的顺序门里。推荐插入位置与理由：

```
dedup / redelivery (:1496)
pendingCancelled   (:1558)
strictAgentOnly    (:1569)
admissionGuard     (:1578)          host 否决权最便宜且属 host，保持最先
stoppingOffers     (:1586)
maxConcurrentRuns  ← 新增，retryable decline   ★ 必须在 prepare() 之前
limits.maxTokens   (:1605)
policy.workspaceRoot (:1632) … pickAdapter (:1670) … buildRuntimeEnv (:1685)
prepare()          (:1788-1801，无副作用)
Workspace writer lease acquire   ← 取代 :1809 的 acquireExecution
Session 串行租约 acquire
handoff requireMatch (:1830)
seal manifest (:1915-1940) → task.claim (:1945)
```

`maxConcurrentRuns` 计所有 lane 的 active run（与 WP0 的"统一计数"同一原则），readback 只报计数不报正文。

---

## 4. 并发规则表

| 场景 | 行为 | 由谁保证 |
|---|---|---|
| 同一 Session 两个 Run | 第二个 `session_busy`，retryable decline | Session 串行租约（`executionKey:560-568` 复用） |
| 不同 Session、同一 mutable Workspace | claim 前 retryable decline | Workspace writer lease |
| 不同 Session、不同 Workspace | 并行放行 | 无租约冲突 |
| 同一 Agent、不同 Workspace | 并行放行（home 元数据互斥仅在短租窗口内） | Home 短租序列化，不阻塞执行 |
| 同一 repo 需并行 | 每个并行任务一个 `git-worktree` Workspace，`repositoryRef` 相同、`workspaceId` 不同 | `git worktree add` + 每 worktree 独立 index |
| Installation 超配额 | retryable decline | `maxConcurrentRuns` |
| 终态后 memory 写回 | 在 home 短租内，用 **`agent-memory.ts` 现有的 sha256 内容 CAS**（`AgentMemoryRevisionConflictError:35`、`replaceInternalFile:317-332`）；冲突不合并、不重试覆盖，报 typed 冲突 | 本地 CAS |
| 终态后 memory head 上云 | 另一套：`core/src/truth.ts:74,:109` 的数值 `expectedRev` CAS + outbox `writerEpoch` fencing（`agent-memory.ts:619,:662`） | 云端 CAS |

**CAS 用哪个 —— 结论：两个都用，但是两个 datum。** 本地文件字节的权威是本地文件，其 CAS 只能是内容 revision（已实现，sha256）；云端 memory head 的权威是 TruthStore，其 CAS 是 `expectedRev`。把本地写回改用 `truth.ts` 的 `expectedRev` 会让本地文件依赖一个远端修订号 —— 违反「一事实一权威」。WP3A 不新增任何 CAS 原语，只把本地写回从"运行中任意时刻"收紧到"终态后、home 短租内、一次"。

---

## 5. Offer / manifest 变更：v1 可加 vs 必须等 v2

**wire v1 上零变更（本包不碰 wire）**。Workspace 完全由本地推导：

```
(agentRef, sessionRef | taskId) + DaemonConfig.workspaces → WorkspaceRef
```

v1 阶段 host-config-derived 的部分：
- `DaemonConfig.workspaces: { root?, defaultBackend, repositories: Record<string,string>, select?(input): WorkspaceRef }`。`select` 缺省 = 每 Agent 一个 `plain-directory` Workspace，`workspaceId = agentId`（迁移默认，§6）。
- `RuntimeOperationManifest` 加 `workspace.backend`、`workspace.repositoryRef?`、`agentHomeDir`（types.ts:283-287 扩展）。这是 client 内部类型，不上 wire —— 但它在 WP1 `.d.ts` golden 内，属**有意 breaking**，走 golden 有意门。
- `git-worktree` 的观测复用 `GitWorkspaceObservation`（git-workspace.ts:195-206），只经本地 `onGitWorkspaceEvent` 回调（`task-runner.ts:2046`），不上 wire。

**必须等 v2**：
- offer 里的 `workspaceRef`（云端选 Workspace）—— WP4 v2.1 的 `run.offer` 字段。**技术上也不可能在 v1 加**：`TaskOfferForAgentPayloadSchema`（`packages/protocol/src/messages.ts:319-337`）是 `.strict()`，未知字段整条拒绝；`PROTOCOL_VERSION = 1` 由 `version.ts:27` + golden freeze-guard 冻结。所有 offer payload 今天都不带 `cwd`（唯一带 `cwd` 的 wire 面是无关的 content-read 回执，`messages.ts:457-462,:484-535`）。
- 云端可见的 Workspace 列举 / 生命周期（create/dispose）。
- `sessionId` 由 SDK 铸造并与 native locator 解耦（WP4 v2.3）；v1 阶段 `.byok/sessions/<sessionId>/` 的 `<sessionId>` 仍是 `sessionRef` 的安全哈希，目录结构先就位、身份后切换。

**一个 v1 兼容性硬点**：`AgentSessionHandoffStore.requireMatch`（`:277`）把 `cwd` 当匹配字段。cwd 改成 Workspace 后，所有既有 handoff 记录的 `cwd`（= canonical home）都会失配 → 所有 resume fail-closed。这是**期望行为**（一次性 cutover、无双读），不是缺陷；必须在 §6 里作为显式后果写进 release note，并且 handoff 记录同刀改为存 `{workspaceId, workspaceDir, agentHomeDir}` 三元而不是单个 `cwd`。

---

## 6. 迁移（一次性、fail-closed、无双读）

三个候选：

- **(a) home 即 Workspace**（`workspaceId = agentId`，dir = `agents/<agentId>`）：零字节移动，但每个已迁移 Agent 永久保留 "home == mutable workspace" 的耦合 —— 正是本包要消掉的东西，稳态兼容，**否决**。
- **(b) 把 home 里的非保留文件搬进新 Workspace**：SDK 必须区分"哪些是任务文件"，而 `docs/host-local-storage-layout.md:44-47` 明写 BYOK 不解析、不分类、不推断 Agent 文件语义。**否决**。
- **(c) 每 Agent 建一个空的 `workspaces/<agentId>`，一个字节都不搬**（推荐）。

**推荐 (c)**，具体契约：

1. `DaemonConfig.agentHome` 存在但 `DaemonConfig.workspaces` 缺失 → 构造期抛错（与 `create-daemon.ts:1115-1124` 现有互斥/依赖校验同形）。cutover 由 operator 显式开启，daemon 不推断。
2. 首次为某 `agentId` 材化 Workspace：建目录 + 写 `<storeDir>/workspaces/<workspaceId>.json`，不读、不复制、不扫描 home 内容。
3. home 内既有不透明文件**原地保留、永不删除**。它们不再在 cwd 里 —— 这是可见的产品性变化。补救是 host 权威：host 可在 relocation 租约下自行搬字节，SDK 不代劳（责任矩阵已把 "Agent files: 名称/格式/目录/业务语义" 划给 host）。
4. `.byok/runtime-sessions/*.jsonl` → `.byok/sessions/<sessionId>/`：**不做数据迁移**。旧记录的 `cwd` 已经全部失配（§5），迁移它们只会产生一批必然被拒的记录。启动时把旧目录整体重命名为 `.byok/sessions-legacy-<timestamp>/` 保留取证，不读。所有 in-flight session 在 cutover 后需要 fresh 重开 —— 写进 release note。
5. `git-workspaces.json` 与 `SessionWorkspaceStore`：**本包不动**。它们只服务 legacy 非 Agent 路径（`task-runner.ts:1864-1905`），Salesko 生产零命中（review §13 verified）。新的 `WorkspaceStore` 只服务 Agent 路径。两者对同一 datum 无重叠权威（不同代码分支、不同记录集合），因此不是双读；它们的删除归 WP4（legacy offer 消亡的同一刀）。在 WP3A 里删会把 legacy 路径一起破坏，属越界。
6. 回滚：移除 `DaemonConfig.workspaces` 并回滚 daemon 版本。`workspaces/` 目录、`workspace-leases/`、`workspaces/*.json`、`sessions-legacy-*` 全部保留供手工取证，无清理命令（与 spec:751 的 git workspace 回滚口径一致）。

---

## 7. 工作分解（顺序执行，每步 ≤ ~1 天）

前提：全程只在 worktree 分支上做；每步独立 commit；每步末尾跑 `bun run build && bun run typecheck && bun run test`。

**S0 — 表征测试（先行，不改产品代码）**
allowed: `packages/client/src/__tests__/**`
写死今天的行为：Agent cwd == canonicalHome（`agent-home.ts:614`）、同 home 多 session 并发放行、manifest 的 `cwd`/`lease` 字段、`AGENT_MEMORY_GUIDANCE` 文本、`requireMatch` 拿 cwd 比对、handoff 文件名形状。
exit: 新测试全绿且**明确标注哪些断言将在 S4/S6 被有意推翻**。
rollback: 删测试文件。

**S1 — containment helper 提取 + `WorkspaceRef` 类型 + `WorkspaceStore`（无接线）**
allowed: 新建 `packages/client/src/workspace/{layout,store,types}.ts`；`agent-home.ts:185-247` 三个私有 helper 移到 `packages/client/src/util/path-containment.ts` 并由 agent-home 与新模块共同 import（两个真实消费者，符合共享组件规则；`agent-content-audit-store.ts:221` 是第三处重复实现，可顺带收编或记为 report-only）。
`WorkspaceStore` = **每 workspace 一个 JSON 文件** `<storeDir>/workspaces/<workspaceId>.json`，不复制 `GitWorkspaceStore` 的单文件 ledger（理由见 §8）。
exit: 新模块单测（段校验含 Windows 保留名、realpath containment、symlink 拒绝、并发 upsert 无丢失）+ 四项 required checks；`agent-home.ts` 行为零变化（S0 测试仍绿）。
rollback: revert 单 commit。

**S2 — 两个 backend 的材化**
allowed: `packages/client/src/workspace/**`
`plain-directory`：`ensureDirectoryNoSymlink` + realpath。
`git-worktree`：预检 git、校验 `repositoryRef` 已在配置里注册、`git worktree add -b byok/ws/<id> <path> <base>`，复用 `git-workspace.ts:98-131` 的 `GIT_*` 剥离与超时/输出上限；禁网络与 history 操作的既有清单原样套用。
exit: 单测覆盖「同一 repo 两个 worktree 并行、index 互不干扰」「repositoryRef 未注册 → fail-closed」「worktree 目录已存在且非空 → fail-closed」「git 不可用 → 预检失败，不接 offer」。
rollback: revert；无磁盘遗留（失败路径清理新建目录）。

**S3 — 拆租约**
前置：**S3 的第一件事是读一遍已合入 main 的 WP0 形状**（`DaemonConfig.maxConcurrentMutableSessionsPerAgentHome`、`task-runner.ts` 的 per-home 计数门、`AgentHomeExecutionLeaseManager.activeAttemptCount`、`AgentHomeExecutionStatus` readback、`api-surface/client.d.ts` golden），以合入后的实际行号与字段名为准，不照抄本包 §1 的分支态行号。
allowed: `packages/client/src/agent-home.ts`、`packages/client/src/workspace/lease.ts`
新增 `WorkspaceLeaseManager`（双层：进程内 map + `<storeDir>/workspace-leases/<id>.lease` marker + owner id 回收）。
`AgentHomeExecutionLeaseManager` 去掉 `:592-598` 的 base-lease 持有，改名/收窄为 `SessionRunLeaseManager`，键从 `(canonicalHome, key)` 提到全局 `key`。
`AgentHomeManager` 暴露 `withHomeMetadataLease(agentRef, fn)` 短租。
**删除 WP0 的 home 级计数上限**（同刀，不留同名旋钮）：删 `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` 及其构造期校验（`create-daemon.ts:311,:1194`）、`TaskRunnerDeps` 上的同名字段与 getter（`task-runner.ts:346,:1146`）、`handleOffer` 里的 per-home 门（`task-runner.ts:1622-1639`）、`AgentHomeExecutionLeaseManager.activeAttemptCount`（`agent-home.ts:727`），并把 `AgentHomeExecutionStatus`（`agent-home.ts:588-595`）改写为 workspace 口径的计数 readback。这是一次有意 breaking，同刀更新 `api-surface/client.d.ts` golden（WP0 在 `:1062` 加的那条随之消失）。
exit: 单测「同一 Workspace 第二个 writer 被拒（跨 lane）」「不同 Workspace 并行」「同 Session 第二 Run 被拒」「home 短租不阻塞执行」「crash residue 由同 owner 回收、异 owner 拒收」；WP0 的 `agent-home-single-writer.test.ts` 按 workspace 口径改写而非删除（它锁的是"同一 Agent 第二个 mutable run 被 retryable decline"，这条语义在 WP3A 后必须仍然成立）；golden diff 为一次有意 breaking 且已记录。
rollback: revert。

**S4 — task-runner 接线（最大一步，允许拆两天则拆 S4a 解析/S4b 终态）**
allowed: `packages/client/src/daemon/task-runner.ts`、`packages/client/src/types.ts`、`packages/client/src/daemon/memory-guidance.ts`、`agent-session-handoff-store.ts`
`:1807-1863` 改成：解析 `WorkspaceRef` → 取 Workspace writer lease → 取 Session 串行租约 → 材化 backend → `requireMatch`（新三元）→ home 短租内 `initializeAgentHome`。
`:1827` 的 `workspaceDir = agentBinding.lease.cwd` 改为 workspace dir；manifest `:1908-1937` 同时携 `cwd`(=workspace)、`workspace{workspaceId,backend}`、`agentHomeDir`。
`memory-guidance.ts` 常量改函数，`:2064` 传绝对 home 路径。
handoff 记录改存 `{workspaceId, workspaceDir, agentHomeDir}`。
exit: S0 中被标注的断言按预期翻转且新断言绿；新增端到端「fresh Agent offer → cwd 是 workspace → MEMORY.md 经 MCP 与经绝对路径都可写 → 终态」；四项 required checks。
rollback: revert S4（S1-S3 可独立留存，未接线）。

**S5 — 配置与准入**
allowed: `packages/client/src/daemon/create-daemon.ts`、`task-runner.ts` 顺序门
`DaemonConfig.workspaces` 校验（agentHome 存在则必填，与 `gitWorkspace` 互斥，同 `:1115-1124` 形状）；`maxConcurrentRuns` 插到 §3 指定位置；status readback 只报计数。
exit: 单测「agentHome 无 workspaces → 构造期抛错」「第 N+1 个 run 被 retryable decline」「decline 不改 task 状态」；四项 required checks。
rollback: revert。

**S6 — 终态写回与 relocation gate**
allowed: `task-runner.ts` 终态路径（`finish():3896-4030`、`failClaimedAgent():3562-3596`）、`agent-memory.ts`、`local-state-relocation.ts`
`finish()` 现有顺序必须保持并扩展：`session.close()`（`:3951-3972`，失败即不释放任何租约）→ `quiesceAndSnapshotAgentMemory`（`:3980`，`:2423-2453`）→ 终态证据重试（`:3981-4009`）→ `agentBinding.lease.release()`（`:4010-4016`）→ **新增 Workspace lease release** → `gitLease?.release()`（`:4017,:4024`）。memory/result 写回收拢到 home 短租内（`snapshotAndProjectAgentMemory` 已有 per-home 事务队列 `agent-memory.ts:414-416,:682-701`，改为在短租内调用），本地 sha256 CAS 冲突走 typed 失败不重写。
`local-state-relocation.ts:214-219` 增加第三个 gate scope `workspaces`（源/目的 `<root>/workspaces`）并扩展 `assertAgentHomeRootQuiescent`（`:101-140`）的同形静默检查到 workspace lease marker。该模块只发租约、不搬字节，且仓库内除 `index.ts:67-75` 的再导出外无调用者（verified）——搬字节是 host 权威，这正是 §6 步骤 3 补救路径的落点。
exit: 单测「终态后 memory CAS 冲突 → typed 冲突、文件未被覆盖」「cancel 与 disposal 失败后 lease 计数正确」「relocation 在 workspace 活跃时 fail-closed」；四项 required checks。
rollback: revert。

**S7 — 文档与 golden**
allowed: `docs/spec.md`（§Durable Agent homes、§Local Git task workspaces 的 branch-switching 口径）、`docs/host-local-storage-layout.md`、`CHANGELOG.md`、`api-surface/**` golden
exit: `repo-harness run check-task-workflow --strict` + 四项 required checks 全绿；golden diff 为一次有意 breaking 且已记录。
rollback: revert。

### 跨包写权归属与顺序（WP3A ⇄ WP3B ⇄ WP0）

WP3A 与 WP3B 是并发排期的两把刀，下列路径两包都会写，**每条路径同一时刻只有一个写者**，顺序如下。写权窗口在包的步骤粒度上交接，不在文件粒度上交错。

| 路径 | 写者顺序 | 说明 |
|---|---|---|
| `packages/client/src/agent-home.ts` | WP0 → WP3A S1/S3/S6 | WP0（`codex/agent-home-single-writer`）先合入 main；WP3A S3 在其之上删计数门 |
| `packages/client/src/daemon/task-runner.ts` | WP0 → WP3B Step 4 → WP3A S4/S5/S6 | WP3B Step 4 只做 WS 分支的减法，WP3A S4 是 `:1807-1940` 的重写；减法先落，重写基于最终形状写一次 |
| `packages/client/src/daemon/create-daemon.ts` | WP0 → WP3B Step 4 → WP3A S3/S5 | 同上 |
| `packages/client/src/index.ts` | WP0 → WP3B Step 4 → WP3A S3 | `ConnectionState` 联合收窄（WP3B）与租约类型导出变更（WP3A）都改这一个导出面 |
| `docs/spec.md` | WP0 → WP3B Step 5 → WP3A S7 | |
| `CHANGELOG.md` | WP0 → WP3B Step 5 → WP3A S7 | |
| `api-surface/**` | WP0 → WP3B Step 5 → WP3A S7 | golden 已在 main（`api-surface/client.d.ts` 等 10 个文件，由 `2e01c9a` "chore(ci): gate the public type surface and version strings (#123)" 带入；`4cc765f` 上尚不存在——verified 2026-09-03）。三方各自的 breaking 面必须分三次有意 diff 落，不合并成一次 |

**可并行的窗口**：WP3B Step 0–3 的允许路径只有 `packages/cloud/**`、`packages/cloud-dataplane/**`、`packages/conformance/**`、`packages/server/**`（外加 Step 2 的 `packages/client/scripts/*.mjs`、Step 3 的 `examples/basic/**`），与 WP3A S0–S3 的 `packages/client/src/{__tests__,workspace,agent-home.ts}` 无交集，**可完全并行**。

**必须串行的窗口**：WP3B Step 4 与 WP3A S4/S5 都写 client daemon 面 → 串行，WP3B Step 4 先。WP3B Step 5 与 WP3A S7 都写 `docs/` + `CHANGELOG.md` + `api-surface/**` → 串行且排在两包所有代码步骤之后，WP3B Step 5 先。

**交接纪律**：接手方在自己的步骤开始时重读被交接文件的当前内容与行号，不沿用本包写作时刻的行号；被交接文件上的 required checks 由接手方重跑一遍。

---

## 8. 风险 / 10x 首先坏在哪 / 必需验证 / 置信度

**风险**

| # | 风险 | 缓解 |
|---|---|---|
| R1 | cutover 后 Agent 在空 cwd 里开工，历史任务文件"消失"（在 home 里但不在 cwd） | 唯一的产品性破坏。必须进 release note + 由 host 在 relocation 租约下自行搬字节。这是 §6 里 owner 需要点头的那一条 |
| R2 | 所有既有 handoff 因 `cwd` 失配而 resume 全灭 | 期望行为（无双读），但需要 release note 明写「cutover 后 in-flight session 需 fresh 重开」 |
| R3 | `git worktree add` 触碰共享 repo（写 `worktrees/<name>`、建分支），越过 `docs/spec.md:735` 的现有禁令口径 | 限定 `-b byok/ws/<id>` 保留命名空间 + 显式 base；spec 口径同刀精确化；`remove` 只在 host 显式 disposal |
| R4 | WP0 已实现（`codex/agent-home-single-writer` tip `5a2211e`（PR #125））但未合入 main，WP3A 在其之上排队，止血窗口取决于 WP0 何时合 | WP3A 的 Workspace writer lease 是 WP0 计数门的超集。排序固定：**先合 WP0，再起 WP3A**；S3 以已合入的 WP0 形状为输入，同刀删掉 `maxConcurrentMutableSessionsPerAgentHome`、`handleOffer` 的 per-home 门与 `activeAttemptCount`，不保留同名旋钮。若 owner 决定 WP0 不合入 main（直接被 WP3A 取代），S3 的删除步骤退化为"不新增"，其余不变 |
| R5 | `workspace-leases` marker 在 storeDir、workspace 内容在 hostStorageRoot，两个 root 可被分别搬迁 | S6 的 relocation 第三 gate 覆盖 workspaces root；两个 root 的一致性由 relocation 同时持四个 gate 保证 |
| R6 | Windows：worktree 路径长度 + DACL 硬化 | `workspaceId` 段长上限；Windows 上失败 fail-closed（沿用 spec:749 口径）。`[unverified]`：本包未在 Windows 实机验证 worktree 路径长度 |

**10x 首先坏在哪**：不是并发，是 workspace 元数据的写放大。`GitWorkspaceStore`（`git-workspace-store.ts:63-73`）是单文件全量重写 + 进程级串行队列 + `MAX_RECORDS = 500` 硬顶（`:32`）；`SessionWorkspaceStore` 同形。10x（数百 Agent × 每 Agent 数个 Workspace）下每次 phase 变更都重写整个 ledger，队列变成全局串行点，且 500 条上限会静默淘汰活跃记录。所以 S1 明确规定**每 workspace 一个文件**，不复刻这个形状。第二个会坏的是 `AgentHomeExecutionLeaseManager.queues`（`agent-home.ts:678-694`）的 per-home Promise 链——拆租约后 home 短租窗口从"整轮"缩到"单次 mutation"，这条链才不会成为吞吐上限。

**必需验证**（S4/S6 之后一次性跑全）
1. `bun run build` / `bun run typecheck` / `bun run test` / `repo-harness run check-task-workflow --strict`。
2. 并发矩阵实测：同 Workspace 跨 lane 第二 writer 被拒；同 Session 第二 Run 被拒；不同 Workspace 并行成功；同 repo 两 worktree 并行成功且 `.git/index` 互不干扰。
3. 崩溃残留：kill -9 后同 owner 可回收 workspace lease、异 owner 被拒。
4. cutover 演练：从一个含既有文件与既有 `runtime-sessions/` 的 home 出发，开启 `workspaces` 配置，验证 home 文件零变动、旧 session 目录被重命名保留、fresh offer 成功、resume fail-closed。
5. memory 可达性：MCP 路径与 prompt 绝对路径两条都能读写 `MEMORY.md`；终态 CAS 冲突产出 typed 冲突而非覆盖。

**置信度：MEDIUM。** 代码事实、租约结构、CAS 归属、准入顺序都已在本轮逐条核对（§1 全部 verified）；不确定集中在一处 —— (c) 方案让既有 Agent 的历史任务文件离开 cwd，这是 owner 的产品决定，不是我的架构决定。

**什么会推翻这个判断**：(i) 若存在任何下游依赖"Agent 任务文件就在 home 根下"的读取路径（Salesko 审计 §13 未覆盖此项 `[unverified]`），则 (c) 不可行，退回 (a) 并把 home==Workspace 明确标为一次性迁移态而非稳态；(ii) 若 `git worktree` 在目标 Windows 部署上被证实不可用，`git-worktree` backend 降为可选能力、`plain-directory` 单独先发；(iii) WP0 的计数形状本身不是推翻项——S3 已把"先读一遍已合入 main 的 WP0 形状"写成前置条件（§7 S3），所以合入时的行号或字段名变化只影响 S3 的执行细节，不影响本包的裁定。

---

RECOMMENDATION: 按 S0→S7 执行 WP3A —— cwd 迁到 `<hostStorageRoot>/workspaces/<workspaceId>`，writer lease 按 Workspace 键、Session 串行租约按 sessionId 键、home 降为短租元数据域，memory 用既有本地 sha256 CAS（不用 `truth.ts` 的 `expectedRev`），guidance 携绝对 home 路径（不用 symlink），迁移走"每 Agent 一个空 Workspace、一个字节不搬"的 fail-closed 一次性 cutover — confidence: MEDIUM
