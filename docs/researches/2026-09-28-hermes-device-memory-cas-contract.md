# Hermes Bot Mode：device memory CAS transport 契约（WP2-I-D）

> **状态：设计已验收（Codex w2:pR round 3 PASS，2026-09-28），docs-only。** 本文为被接受 subject `912351ed` 的 successor：`8f4b93d6` 仅含状态、笔误与语义澄清；其后一版为「已验收 S2 身份门裁定的同步」，相对旧设计含已批准的行为修订（identity/digest 门先于任何可持久化拒绝），依据 contract「Approved follow-up: WP2I-S2 identity-gate fix」与 WP2I-S2 r3 ACCEPTED（subject `f54bef21…`），不新增实现之外的行为。Owner 待裁定 R2、R3、R4、R6、R7、R9、R10、R11、R16 仍 pending；source/fsync/macOS/serializer 的运行证据留到获批后的实现验收。不批准产品实现、SDK release、Salesko adoption，也不替 Owner 做「裁定表」里的产品决定。本版回应 `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md`「WP2-I-D design acceptance — round 1: FAIL (Codex w2:pR)」的 WP2D-F1–F4 与非阻断项，按 orchestrator 的裁定实现：F1 显式 `uncertain`、F2 release 时点授权、F3 记录上界与 durable ack、F4 单一 pending body。round 3 回应 round-2 receipt 的 F3-a（durable barrier）、F3-b（无本地行的 Host terminal 分支）与四项同步。
>
> **基线（只读核验）：** SDK `origin/main` `050349af`（worktree `byok-sdk-wt-hermes-bot-adoption`）。Salesko merged truth 为 `origin/main` `4b1944c9`；cutover 集成分支 `claude/web-key-cutover` `2ce4f540`；Host 最新 `claude/wkc-h1b` `643024af`；device 最新 `claude/wkc-h3` `8a38bfc2`；wkc-* 互不包含、均未 push/merge。Salesko 引用以 `h1b:`、`h3:`、`main:` 标注来源树。SDK 0.24.0（PR #239，`claude/s4-host-surfaces` `bb64dd25`）状态 OPEN。
>
> **上游：** WP2-D `docs/researches/2026-09-28-hermes-host-lifecycle-design.md`；WP1-I `docs/researches/2026-09-28-prepared-agent-memory-contract.md`。

## 结论

推荐 carrier **(a)**：新增 task-free notice-and-fetch family `agent.memory.intent.available`，由 device capability `agent-memory-intent.v1` 门控。Host 在自有 device-assertion routes 上释放已审批 intent、接收 typed receipt；SDK daemon 在进程内取得与 `agent.home.projection` 相同的 task-free Agent-home writer lease，先持久化 `applying` 再调用现有 sha256 CAS 一次；complete 之前必须完成该 terminal 的 durable barrier，resolve 之前必须完成 `ackedAt` 的 durable barrier（§L）。它是 additive message type + capability，`PROTOCOL_VERSION` 与 input-preparation v8 不变。

- **授权：** Salesko Host 是唯一 approval authority，最终授权人是 Bot canonical owner（R6）。授权线性化点是 fetch 事务里的 release（§A，R16）；release 之后的 revoke、expiry、profile/placement 变化只阻止后续 release。capability、notice、receipt 都不构成 approval。
- **内容 authority：** device-local `MEMORY.md` / `notes/**` 是唯一 memory content authority。Host 侧唯一 raw body 位置是 pending-body record，proposal 与 intent 只持 `bodyRef`，首个 terminal 即 purge（§B，R4）。notice、ledger、completion、readback 只含 id、path 与 sha256。
- **恢复：** 单个 intent 的 CAS 至多执行一次。入口处发现的 `applying` 永不重放，报告 `uncertain{observed}`，不作 provenance 推断（§R）。
- **容量与持久化：** ledger 每条记录 ≤ `R_MAX` = 2048 B，容量 `N` = 511 条，fetch 前先查行再预留；满时只接受 Host terminal。可见不等于持久，complete 与 resolve 各有一道 barrier（§L）。
- **busy：** home 被 active task 占用时不 resolve，由 mailbox replay 重试，与 `agent.home.projection` 一致（`docs/spec.md:1822-1824`）。
- **前置产品问题：** Salesko execution `agentMemory` 固定为 `none`，apply 之后没有 model 能读到。推荐先裁定 R3，再开任何实现包。

## 0. 已核验基线

| 项 | 状态 | 证据 |
| --- | --- | --- |
| Salesko execution `agentMemory` | 恒为 `none`：contracts 常量、offer v9 literal、receipt binding literal、SQL CHECK | `h1b:packages/contracts/src/private-agent-preparation-wire.ts:22`；`h1b:packages/contracts/src/index.ts:6320,6334`；`h1b:deploy/sql/0082_private_agent_chat_one_chat_per_bot_v8.sql:78,94` |
| `none` 的 Owner 裁定 | Owner 回复「批准」（2026-09-28），经 w2:pB 转述；repo 内无带日期的书面记录；Salesko notes 只把 offer v8→v9 列在「Decisions to confirm」 | `pb-coordination-20260928.md` 第 2 条；`h1b:tasks/notes/20260928-1443-web-key-cutover.notes.md:24,29` |
| device memory ceiling | code-owned `none` | `h3:apps/local-agent/src/input-preparation-authority.ts:78-83` |
| Salesko 已有 Host→device 新通道 | 只有 sealed provisioning，且只在 wkc-h1b/h3；`main:` 不含 provisioning relay、`0082`、`0083`，最新 SQL 为 `0081` | `git cat-file -e origin/main:<path>` 均失败 |
| 四个 pB-owned `apps/api` 入口 | repository / preparation-request / preparation-lane / preparation 在 `main:` 存在，wkc-h1b 均有修改；H4 合入前归 pB | `pb-coordination-20260928.md` 第 3 条 |

## P1：当前 authority 地图

| datum / 动作 | 当前 authority | 证据 | 与本契约的关系 |
| --- | --- | --- | --- |
| memory proposal / approval / Host 侧 revision | **不存在** | Salesko `apps/api`、`apps/byok-control`、`apps/local-agent` 无 memory proposal 或 `agent.memory.projection` 引用；唯一命中 `h1b:apps/api/src/private-agent-profile-projection-outbox.ts:66` 为无关 profile outbox | 全部新建，归 Host |
| proposal 先例 | Host 持有 proposal retry identity，拒绝 client `clientMutationId` | `h1b:apps/api/src/private-agent-tools-routes.ts:35-37`；`GraphChangeSetStatusSchema` `h1b:packages/contracts/src/index.ts:2121` | 复用「Host 铸 id」 |
| device memory 内容与 revision | device-local Agent home | `AgentMemoryService` `packages/client/src/daemon/agent-memory.ts:418-457`；revision = 文件字节 sha256 `:110-111,212-239`；缺失文件 revision 为空字节 sha256 `:220-221`；单文件 ≤256 KiB `:18` | apply 复用同一 primitive |
| CAS | 同上 | replace 比对 `:252-253,258-259,262-263`，rename `:264`；delete 比对 `:280-281,285-286`，rename `:287`；冲突类型 `:34-39` | §R 的 zero-write 证据点 |
| path 规则 | 同上 | 仅 `MEMORY.md` 或 `notes/<safe>/…md`，段限 `[A-Za-z0-9._-]` `:26,122-131`；`MEMORY.md` 不可删 `:278,295`；缺失父目录不代建 `:174-185,189-200` | 约束 forget 与 bootstrap |
| home 互斥 | SDK lease | home 按 `agentId` 定址 `packages/client/src/agent-home.ts:289`；base lease 被持有即抛 `AgentHomeBusyError` `:461-476`；execution group 持 base lease `:653-690`；task-free `project()` 同一 `acquire` `:937-941,987-989`；同 owner 重启回收残留 marker `:586-598` | 非 task apply 的互斥来源 |
| caller 绑定 | **只有 task** | `AgentMemoryTaskContext` `agent-memory.ts:41-53`，校验 `:114-119`；`TaskRunner.activeMemoryContext` `packages/client/src/daemon/task-runner.ts:3393-3428`；control API 只认 task token `packages/client/src/daemon/control-protocol.ts:603-617` | 新增非 task 路径，不放宽 task context |
| ledger 载体 | SDK 内部文件 | `replaceInternalFile` 超限在写前拒绝 `agent-memory.ts:317-340`；`AGENT_MEMORY_MAX_LOCAL_LOG_BYTES` = `AGENT_MEMORY_MAX_SNAPSHOT_BYTES` = 1,048,576 `:19,23` | §L 容量来源 |
| Host→device 投递 | SDK mailbox | append 按 messageId 幂等 `packages/core/src/mailbox.ts:48-64`；handler resolve 后 cursor 才前进 `packages/client/src/daemon/connection-manager.ts:518-537,584-631`；handler 可独立并发 `:557-567`；unknown executable work 不 ack `docs/protocol.md:65-67`；read-ahead ≤4096 `docs/protocol.md:1504-1511` | notice 载体 |
| task-free 先例 | SDK | provisioning notice `packages/protocol/src/provider-provisioning.ts:50-55`，processor `packages/client/src/daemon/provider-provisioning.ts:91-138`，cloud enqueue `packages/cloud/src/cloud.ts:2134-2162`；`agent.home.projection` `packages/protocol/src/messages.ts:612-620` | (a) 的结构先例 |
| 认证 | 连接与 device assertion | assertion `packages/core/src/device-assertion.ts:33-39,69,107`；durable capability 读 device 行并拒 revoked `packages/cloud/src/cloud.ts:1176-1195`；Salesko relay principal 只取自 assertion `h1b:apps/byok-control/src/private-agent-provider-provisioning.ts:73-142` | tenant/device 不来自 payload |
| hosted redacted projection | device→hosted 单向 | mutation 绑定 task `packages/protocol/src/agent-memory-projection.ts:84-104`；整 Agent erase `packages/cloud/src/cloud.ts:1714-1727`；Salesko 未配置 | §F |
| 平台 | SDK | Windows fail-closed、macOS 需外部 helper `agent-memory.ts:148-156`；helper 由 product 配置 `packages/client/src/daemon/create-daemon.ts:326-331`；`h3:apps/local-agent/src` 未配置 `agentMemoryFilesystem` | Salesko macOS device 目前不能 advertise |

```text
Bot owner ──approve──> Salesko api (proposal / intent / pending-body)   [approval authority]
                           │ admin notice                ▲ internal relay (principal from assertion)
                           ▼                             │
                 byok-control ──enqueue──> SDK cloud mailbox     byok-control device routes
                                               │ long-poll (authenticated device)   ▲ fetch / complete
                                               ▼                                    │
                 SDK daemon intent processor ──calls──> Salesko local-agent transport hook
                           │ in-process, home lease windows 1/2/3
                           ▼
                 AgentMemory CAS + .byok apply ledger (device-local)   [content authority]
```

## P2：traced chain

processor 对同一 `agentId` 的所有 intent 在进程内串行；网络 I/O 永不在 home lease 内。

1. **propose（Host）：** Host 铸 `proposalId`；replace 时写 pending-body `{bodyId, content, contentDigest, byteCount}`，proposal 只存 `bodyRef`；delete 无 body。device 无副作用。
2. **approve（Host）：** Bot owner 批准展示的精确 proposal。同一事务创建不可变 intent，引用同一 `bodyRef`，绑定 `tenantRef`、`deviceId`、`placementRevision`、`agentRef`、`path`、`operation`、`baseRevision`、`targetRevision`（= `contentDigest`）、`approvalRef`、`approvedBy`、`expiresAt`，计算 `operationDigest`。一个 `proposalId` 至多一个 intent。
3. **notify：** Host → control admin route → `ByokCloud.enqueueAgentMemoryIntentNotice(tenant, deviceId, {intentId, agentRef})`；cloud 先读 durable capability，再按 (tenant, device, intentId) 派生 messageId。
4. **window 1（持 lease）：** 先按 `intentId` 查行。terminal → 在本窗口完成 terminal barrier 后跳到 8，barrier 失败抛 `local_io_failed`。`applying` → 观测文件，写 `uncertain{observed}`，该写返回成功即 barrier，跳到 8；该写抛错则抛 `local_io_failed`。无行 → 只裁剪带 `ackedAt` 的记录直到非裁剪记录数 < N 并预留；仍 ≥ N 时以 `reservation: 'none'` 继续 fetch（§L 的 HT4/HT5/HT9）。释放 lease。
5. **fetch：** hook 带 assertion 调 Host，请求携带 `reservation`：window 1 已预留为 `held`，否则为 `none`。`none` 时 Host 不做任何状态迁移、不释放内容：intent 已 terminal 返回 `terminal`，其余一律返回 `deferred`（只含 identity 与 digest）。`held` 时 Host 在一个事务内检查 device、tenant、状态、`expiresAt`、revocation、placement、profileRevision，返回 `release`、`withheld{code}`（只用于已 dispatch 的 intent）或 `terminal{readback}`。`approved` 且遇阻断条件时，Host 在同一事务单方终结并返回 `terminal`。
6. **validate：** 严格解析；先过身份门：intent `agentRef`（agentId 与 profileRevision）必须等于 notice，且以本机 enrollment 的 tenantId/deviceId 重算的 `operationDigest` 必须等于 intent 所带值，任一不符 → `fetch_invalid`（零 ledger、零 CAS、零 completion、不 resolve），content 缺陷也先过此门；门后才校验 path/operation/size 与 `sha256(utf8(content)) = targetRevision`，这些失败才可记为 rejected。
7. **window 2（持 lease）：** 重读 ledger（`applying` 按第 4 步转 `uncertain`；terminal 按第 4 步 barrier 后 → 8）；再验非裁剪记录数 < N。持久化 `applying`；这次写入报错则中止，不调 CAS，抛 `local_io_failed`。调用 CAS 一次：返回成功 → `applied{result}`；抛 `AgentMemoryRevisionConflictError` → `conflict{observed}`（受 §R 停止点约束）；其他错误 → 观测后 `uncertain{observed}`。持久化 terminal：写调用返回成功即 terminal barrier；写调用抛错（包括 rename 已可见之后才报错）则本次不 complete，抛 `local_io_failed`。写 metadata audit，释放 lease。一个 `release` 只供紧随其后的这一次 window 2 使用；window 2 在写 `applying` 之前失败（busy 等）时丢弃它，下一次调用重新 fetch。
8. **complete：** 只有本进程内已对这条 terminal 完成 barrier 才能发出。hook 把由该 terminal 构造的 completion PUT 给 Host，Host 记录并返回 readback（lease 外）。
9. **readback：** schema 合法且与已提交 completion 一致（§字段表 ack 规则）。
10. **window 3（持 lease）：** 重新取 lease → 重载 ledger → 核对 terminal 与刚提交的一致 → `ackedAt` barrier：整份重写该记录，`ackedAt` 已存在时也原样重写 → 释放 lease。
11. **resolve：** 只在 `ackedAt` barrier 成功后 resolve，cursor 可前进。window 3 busy 或 barrier 失败时不 resolve；redelivery 从第 4 步重新 complete，Host 回 `idempotent`。
12. **later recall：** 第 7 步之后被 admit、且 sealed `agentMemory` ≥ `read` 的 execution 经 `memory_recall` 读到当前磁盘状态（`docs/researches/2026-09-28-prepared-agent-memory-contract.md:116`）。Salesko 当前为 `none`，这一步不存在（R3）。

### 失败路径

| 情形 | 判定点 | 确定结果 |
| --- | --- | --- |
| notice 重投 / replay | window 1 ledger 为 terminal | terminal barrier 重写 ledger 后重发同一 completion，Host `idempotent`；target memory 零新增 CAS（ledger barrier 重写仍会发生） |
| 重复 enqueue / 重复 approve | 派生 messageId；`proposalId` 唯一 | 同一 mailbox row；同一 intent |
| 跨 tenant / device | Host fetch 要求 assertion 主体 = intent 主体；digest 含本机 tenantId/deviceId | 不释放（not found → `fetch_failed`，不 resolve；只有 Host 误投可达，operator 修复，同 provisioning 404）；返回的 intent digest 不能以本机 tenant/device 重算 → `fetch_invalid`，零 ledger/CAS/completion，不 resolve |
| 跨 Agent / profileRevision | notice `agentRef` ≠ fetched intent `agentRef` | Host 违约 → `fetch_invalid`，零 ledger/CAS/completion，不 resolve；不产生可持久化 completion，Host 侧也不得放宽 receipt 身份来收录混合身份 |
| 跨 profileRevision / placement | Host 在 release 时检查（R8） | release 前：阻断；release 后：不可撤回（§A） |
| stale `baseRevision` | live path CAS 抛 conflict | `conflict{observed}`；纠正需新 proposal + 新审批 |
| Host 从未观测过的已有文件 | bootstrap（§B） | 首个 intent `conflict{observed}`，再走 R11 |
| device offline | row 留在 mailbox | 上线后照常处理；从未 dispatch 的 intent 过期由 Host 单方终结 |
| Host 侧久无 receipt | intent 停在 `dispatched` | 不得推断「未应用」，只可 UI 标记 overdue |
| 入口发现未决 `applying` | window 1/2 | `uncertain{observed}`，不重放（§R 轨迹 T1–T6） |
| lost ack | redelivery → ledger terminal | terminal barrier → 重新 complete → `idempotent` → window 3 → resolve |
| late completion | Host 收到 dispatched intent 的 completion | 按 device 事实记为 terminal；若有 `revokeRequestedAt`，UI 写「release 之后请求撤销；结果以 device completion 为准」 |
| home busy | window 1/2/3 `acquire` 抛 `AgentHomeBusyError` | 抛 `home_busy`，不 resolve；本窗口不做新写入，这不表示该 intent 从未写过；进程内 home queue 只做短时排队 |
| release 前 revoke / 过期 / profile / placement 变化 | never-dispatched：Host 单方终结；dispatched 且 device 无 `applying`：re-fetch 得 `withheld` | 前者 fetch 返回 `terminal`（`host_terminal`），按无本地行 ack 例外直接 resolve（HT1/HT2）；后者 device 提交 `rejected{code}`，零写入 |
| release 后同类变化 | 已释放的 grant 不可撤回 | 结果以 completion 为准（§A 轨迹 A1–A5） |
| ledger 满 | window 1 查行后以 `reservation: 'none'` fetch | `terminal` → 无行 ack；`deferred` → `ledger_full`；均零本地写入，Host 状态不变（HT4/HT5/HT9） |
| terminal 或 `ackedAt` 写入 rename 可见、fsync 失败 | 写调用抛错 | 本次不 complete / 不 resolve；D1、D3 |
| readback 成功但 `ackedAt` barrier 未成功 | window 3 | 不 resolve；redelivery → `idempotent` → resolve |
| delete 指向 `MEMORY.md` | primitive 拒绝 | `rejected: memory_md_not_deletable`；Host 应在 approve 时拒绝 |

## §R 恢复：残留不是 provenance（WP2D-F1）

- `applied` 与 `conflict` 只能来自 live path：同一次进程内尝试先持久化 `applying`，再从 CAS 得到返回（成功，或 `AgentMemoryRevisionConflictError`），之后 terminal 持久化成功。
- window 1 或 window 2 入口发现的 `applying`（crash、terminal 写失败、restart）一律不重放，转成 terminal `uncertain`，附 `observed: {exists, revision}`，含义是「本 intent 可能写过也可能没写；当前文件观测为 X」，不作任何 provenance 断言。live path 中 CAS 抛非 conflict 错误同样归 `uncertain`。
- Host 把 `uncertain` 归为 terminal non-success；此后任何变更需要新 proposal + 新审批。UI 只能说「目标内容当前存在 / 不存在（revision …）」，不得说「已应用」或「未应用」。device 的观测时刻不上 wire，Host 不知道；UI 可显示 Host `recordedAt`，必须标为「Host 记录时间」，不得当作观测时间。

**不变量：** 单个 intent 的 CAS 至多执行一次，因为 `applying` 在 CAS 之前持久化，且 `applying` 永不重放。intent 之外的 writer（model `memory_save`、fresh lane、人工编辑）不被 fence，超出本契约范围，本设计也不依赖它们。ledger 与 memory 文件同在 home，从备份恢复 home 不在不变量内。

**`conflict` 的零写入证据点（Linux native）：** replace 的三次比对在 `agent-memory.ts:252-253`（temp 之前）、`:258-259`（temp 之前）、`:262-263`（temp 已写、rename 之前），rename 在 `:264`；delete 的比对在 `:280-281`、`:285-286`，rename 在 `:287`。conflict 抛出时目标未被 rename，可能残留的只有 catch 清理失败的 `.byok-memory-*.tmp`（`:267`），不是目标文件。rename 之后的 `syncDirectory` 失败会被包装成普通 `AgentMemoryError`（`:266-269`、`:288-290`），按上条归 `uncertain`。macOS helper 后端 `context.filesystem.replace/delete`（`:274,296`）的同一性质**未核验**。WP2I-S2 停止点：实现者必须对两个后端证明「conflict ⇒ 无 rename」，否则 conflict 分支也映射为 `uncertain`。

以下轨迹均以 `applying(A→B)` 起始，结局都是 `uncertain`，且没有第二次写入：

| # | 轨迹 | 入口观测 | 结局 |
| --- | --- | --- | --- |
| T1 | CAS 前 crash | 文件 A | `uncertain{exists, A}` |
| T2 | CAS 写入 B 后、terminal 持久化前 crash | B | `uncertain{exists, B}` |
| T3 | CAS 写入 B，terminal 写入失败且未落盘 | B | 本次抛 `local_io_failed`；redelivery → `uncertain{exists, B}` |
| T4 | T2 之后另一 writer 做 B→A，再 replay | A | `uncertain{exists, A}`；旧设计会重放 CAS |
| T5 | T2 之后另一 writer 做 B→C，再 replay | C | `uncertain{exists, C}`；旧设计会误报零写入 conflict |
| T6 | CAS 前 crash，另一 writer 产生 B | B | `uncertain{exists, B}`；旧设计会误报 applied |

T3 的变体：terminal 写入的 rename 已可见、随后 fsync 报错时，本次不 complete，抛 `local_io_failed`。之后的尝试读到该 terminal，必须先在 lease 内完成 terminal barrier 才可 complete；barrier 之前掉电则回到 `applying` → `uncertain`（D1）。任何分支都不重跑 CAS。

## §A 授权线性化点（WP2D-F2）

- 线性化点是 Host fetch 事务内的 release：首次 release 为原子的 `approved→dispatched`。release 之后，这次操作是不可撤回的 grant。
- release 之后的 revoke、expiry、profile 变化、placement 变化只阻止后续 release，以及对「device 尚未写 `applying`」的 re-fetch 返回 `withheld`；它们不能取消已释放、正在进行的操作。dispatched intent 上的 revoke 记为 `revokeRequestedAt`，语义是「release 之后请求撤销；结果以 device completion 为准」。
- re-fetch 的 release 与首次 release 走同一检查，每次 release 只授权紧随其后的一次 window 2（P2 第 7 步）。

| # | 轨迹 | 结局 |
| --- | --- | --- |
| A1 | delayed release：T0 release 已提交，响应延迟；T1 owner revoke；T2 device 收到并在 window 2 写入 | `applied`，带 `revokeRequestedAt`；UI 不说撤销晚于应用 |
| A2 | expiry after release：release 后 `expiresAt` 过去，device 随即 apply | `applied`；expiry 只影响后续 release |
| A3 | revoke after release：release 后 revoke；window 2 busy，release 被丢弃，下次 re-fetch | `withheld: intent_revoked` → `rejected`，零写入（ledger 无 `applying`）；若 window 2 未 busy 则同 A1 |
| A4 | profile / placement change after release | 按旧授权 apply，结果如实记录；后续 intent 以新 profile/placement 审批 |
| A5 | late completion：device 在 CAS 后离线数日，回来后 complete | Host 记录 device 事实为 terminal，附 revoke/expiry 注记 |

**R16 选项 B：硬 apply 截止。** release 响应携带 `releaseNotAfter`，与 `operationDigest` 一起进入 `releaseDigest`，completion 回传 `releaseDigest`；device 在写 `applying` 之前用本地时钟检查，超时 → `rejected: release_expired`，零写入。局限：device 时钟偏差会双向出错（误拒或晚写），且无可信时间源；检查到 CAS 完成之间仍有 lease 窗口内的 check-to-write race；它只缩窄 race，不消除；它约束时间，不约束 release 之后的 revoke。追加任何远端预检同样留下 check-to-write race，无法消除它。

## §L ledger 容量与 durable ack（WP2D-F3）

ledger 为 `.byok/agent-memory-intents-v1.json`，紧凑 JSON（无空白）`{"version":1,"records":[…]}`，只在 lease 内经 `replaceInternalFile` 原子替换。记录字段与上界：

| 字段 | 上界 | 依据 |
| --- | --- | --- |
| `intentId` | 36 B | UUID |
| `profileRevision` | ≤19 B | canonical decimal（`AgentHomeProjectionProfileRevisionSchema`）；agentId 由 home 隐含，不入记录 |
| `path` | ≤1024 B，ASCII，无需 JSON 转义 | `validateAgentMemoryPath` 长度与段字符集 `agent-memory.ts:26,122-131` |
| `operation` | `replace` \| `delete` | |
| `operationDigest` / `baseRevision` / `targetRevision` | 各 71 B（target 可为 `null`） | `sha256:` + 64 hex |
| `approvalRef` | ≤128 B，限 `[A-Za-z0-9._:-]` | 避免转义膨胀 |
| `state` | `applying` \| `applied` \| `conflict` \| `rejected` \| `uncertain` | |
| `detail` | `null` \| `{exists, revision}` \| `{code}`（code ≤32 B，闭集） | |
| `createdAt` / `updatedAt` / `ackedAt` | 各 24 B（`ackedAt` 可为 `null`） | ISO-8601 UTC 毫秒 |

最大状态（`uncertain`，`detail` 为 `{"exists":false,…}`，含 `ackedAt`）实测序列化为 1810 B，加分隔逗号 1811 B。取 `R_MAX` = 2048 B 留出余量；外层开销 `E` = 26 B。`N` = floor((1,048,576 − 26) / 2048) = **511**，满载 26 + 511 × 2048 = 1,046,554 B ≤ 1,048,576 B。

- **查行与预留：** window 1 先按 `intentId` 查行。无行且裁剪后非裁剪记录数 < N 时预留，window 2 写 `applying` 前复核；per-Agent 串行保证两次之间没有其他写者。无行且无容量时仍 fetch，但以 `reservation: 'none'` 请求（HT4/HT5/HT9），不写任何本地行。由于每条记录在任何状态下都 ≤ `R_MAX`，已预留记录的 terminal、`uncertain` 转换与 `ackedAt` 重写按构造必然放得下。
- **裁剪：** 只有已持久化 `ackedAt` 的记录可裁剪，旧者优先，只裁到满足预留为止。永不驱逐未确认证据。
- ledger 无法解析或 `version` 未知：抛 `ledger_invalid`，不 resolve，不重置 ledger。

**Durable barrier（F3-a）。** barrier 指：在持有 home lease 时，经 `replaceInternalFile` 对 ledger 整份重写并得到成功返回；重写内容包含读到的那条记录原样，且在本进程内晚于最近一次读取完成。成功返回须覆盖 temp 写入、新文件 fsync、rename、目录 fsync。记录「存在」或「之前某次写在 rename 之后抛错」都不算 barrier。源码现状：native 路径在 `agent-memory.ts:330` 对 temp 文件 `handle.sync()`，在 `:333` 先 rename 再 `syncDirectory`；`syncDirectory` 吞掉 `EINVAL`/`EPERM`（`:244-247`），所以在拒绝目录 fsync 的文件系统上，成功返回不能证明目录已 fsync；helper 路径直接委托 `context.filesystem.replace`（`:321`），持久化语义未核验。WP2I-S2 停止点 ⑤：ledger 的每次写入（包括 CAS 之前的 `applying`，它是 F1 at-most-once 的前提）都必须使用把任何目录 fsync 错误（含 `EINVAL`/`EPERM`）视为失败的写入变体，或在此类文件系统上不 advertise capability；helper 后端须证明同样四步，否则 macOS 不 advertise。

- **terminal barrier 先于 complete：** live path 的 terminal 写入返回成功即 barrier。写入在 rename 可见之后抛错：本次不 complete，抛 `local_io_failed`，不 resolve。之后任何尝试在 window 1 或 window 2 读到 terminal（`applied` / `conflict` / `rejected` / `uncertain`），都先在该窗口内做 barrier 重写，成功后才 complete。不重跑 CAS。
- **`ackedAt` barrier 先于 resolve：** window 3 一律做 `ackedAt` barrier 重写，`ackedAt` 已存在时也原样重写；成功后才 resolve。window 3 busy 或重写失败：不 resolve，redelivery 重新 complete，Host 回 `idempotent`。
- **`ackedAt` 的含义：** 「Host readback 已验证，且该事实已在本地通过 barrier 持久化」，不代表 cursor 已持久化。
- 前提：存储不对 fsync 撒谎。在此前提且停止点 ⑤ 闭合时，Host 与 device 的 terminal 矛盾不可达。

| # | 轨迹 | 结局 |
| --- | --- | --- |
| D1 | terminal rename 可见 → fsync 失败（本次不 complete）→ 重试未完成 barrier → 掉电 | barrier 之前 Host 从未收到任何 completion；掉电后记录回到 `applying` → `uncertain`，Host 只收到 `uncertain`（若该 rename 恰被同目录其他 fsync 带入持久化，读到的 `applied` 经 barrier 后 complete，同样真实） |
| D2 | terminal barrier 成功 → complete → Host 记录 `applied` → 掉电 | terminal 已持久，重投时 barrier 重写后重新 complete，Host `idempotent`，无矛盾 |
| D3 | `ackedAt` rename 可见 → fsync 失败（不 resolve）→ 重试 → 掉电 | `ackedAt` 丢失，terminal 仍在；redelivery → terminal barrier → complete → `idempotent` → `ackedAt` barrier → resolve |
| D4 | `ackedAt` barrier 成功 → resolve → cursor 落盘前掉电 | redelivery → terminal barrier → complete → `idempotent` → `ackedAt` barrier → resolve；若记录已被裁剪则走 HT3 |

**Host terminal 分支（F3-b）。**

- **无本地行、fetch 返回 `terminal`：** 校验 readback 身份：`tenantId`/`deviceId` 等于 enrollment，`intentId` 等于 notice，`completion.agentRef` 等于 notice `agentRef`，`completion.operationDigest` 等于用本机 tenantId/deviceId 对 fetched intent identity 重算的值。通过即直接 resolve，不写 ledger，不走 window 3，不在本地生成任何 device 事实（不写 `applied` 或 `rejected`）。理由：本地没有可持久化的东西，Host 持有 durable terminal，重投得到同一答案。
- **无本地行且无容量（`reservation: 'none'`）：** Host 不做 `approved→dispatched`、不释放内容、不改变 intent 状态。`terminal` → 上一条；`deferred` → 抛 `ledger_full`，不 resolve，零本地写入。device 在 `none` 请求下收到 `release` 或 `withheld` 属于 Host 违约，按 `fetch_invalid` 处理、丢弃响应、不 resolve。
- **有本地行时 Host readback 为 terminal**（来自 complete 的 readback；有行时 window 1 不 fetch）：与本地 terminal 相等 → `ackedAt` barrier → resolve。本地 terminal 而 Host 为 `host_terminal`，或本地 `uncertain` 而 Host 记录了不同的 completion → integrity audit → `ackedAt` barrier → resolve，barrier 失败不 resolve；在 barrier 前提下两者都不可达。

| # | 轨迹 | 结局 |
| --- | --- | --- |
| HT1 | never-dispatched 过期：无行 → fetch `terminal`（`host_terminal`, `intent_expired`） | 身份校验 → 直接 resolve，零本地写入 |
| HT2 | never-dispatched revoke | 同 HT1，code `intent_revoked` |
| HT3 | 已裁剪记录的旧 notice：fetch `terminal`，readback 为当年记录的 completion | 身份校验 → 直接 resolve；前提是 Host 在 mailbox retention 窗口内保留 intent identity 行 |
| HT4 | ledger 满 + Host `terminal` | `reservation: 'none'` → 同 HT1/HT3 |
| HT5 | ledger 满 + 未 release 的非 terminal intent | `reservation: 'none'` → `deferred`，`ledger_full`，不 resolve，零本地写入；Host 状态不变，revoke 仍是完整撤销 |
| HT6 | 本地 `uncertain` 对 Host 不同的 completion | integrity audit → `ackedAt` barrier → resolve；barrier 前提下不可达 |
| HT7 | readback 身份不符（tenant/device/intent/agentRef/digest 任一） | `readback_invalid`，不 resolve |
| HT8 | 有本地行分支中 terminal 或 `ackedAt` barrier 失败 | 不 resolve |
| HT9 | ledger 满 + 已 dispatch 的非 terminal intent | 同 HT5：返回 `deferred`，不返回 `withheld`，Host 状态不变，`ledger_full` |

负控：L1 非裁剪记录恰为 N−1 时预留；恰为 N 且无可裁剪记录时以 `reservation: 'none'` fetch（HT4/HT5/HT9）；L2 N 条最大尺寸记录全部转为带 `ackedAt` 的最大 terminal，文件 ≤ 1,048,576 B；L3 readback 成功后 `ackedAt` barrier 失败 → 不 resolve → redelivery `idempotent` → resolve，零第二次 CAS；L4 在「写 `applying` 后、CAS 后、terminal barrier 后、complete 后、readback 后、`ackedAt` barrier 后、cursor 落盘前」各点重启：前两点结局为 `uncertain`，其余各点从 durable terminal 经 barrier 重新 complete（Host `idempotent`），全部零第二次 CAS；L5 window 3 busy 时不 resolve；L6 损坏 ledger → `ledger_invalid`；L7 在 rename 之后注入目录 fsync 失败（含 `EINVAL`），complete 与 resolve 都不发生；L8 `reservation: 'none'` 从不得到 `release` 或 content，也从不改变 Host intent 状态（含已过期未迁移、revoke 未决的 intent）；device 在 `none` 下收到 `release` / `withheld` → `fetch_invalid`。

## P3：carrier 决策

| 候选 | 证据 | 裁决 |
| --- | --- | --- |
| **(a) 新 task-free notice-and-fetch family** | provisioning 证明 capability 门控 + Host device routes + readback 后 resolve 可行（`provider-provisioning.ts:91-138`；`docs/protocol.md:536-620`）；pB 要求不复用 provisioning schema | **采用**。内容只走 Host routes |
| (b) `task.offer` memory-apply task | offer 经 TaskRunner、busy decline、terminal（`task-runner.ts:2143-2160,2545-2552`）；Salesko `strictAgentOnly` 只收 Agent egress offer（`h3:apps/local-agent/src/daemon.ts:183-186`） | **拒绝**：需无 runtime 的 task 变体与新 offer schema；内容进 instruction/blob store |
| (c) `agent.content.read` / receipt | payload 绑定已知 session（`messages.ts:528-543`；`create-daemon.ts:2558-2600`）；receipt 走 SDK cloud egress | **拒绝**：读命令，apply 无 session；receipt 不落在 approval authority |
| (d) `agent.home.projection` push | 内联 projection、按 profileRevision latest-value（`agent-home.ts:1010-1025`）；hook 直接写 home | **拒绝**：内容进 mailbox；一 revision 一 projection；绕过 CAS/path 校验；Host 成为内容 authority |

**非 task caller 路径。** `agent-memory.ts` 新增 intent apply 入口，接受 lease 给出的 `{canonicalHome, homeIdentity, filesystem?}`，复用 `replace`/`remove`/`readFile` 的 pinned-descriptor 实现；这些 primitive 的参数收窄为 home binding，task 路径继续由 `AgentMemoryTaskContext` 构造，`taskContext()` 不变。lease 用 `AgentHomeManager.acquire(agentRef)`，与 `project()` 相同；active execution 持 base lease 时抛 `AgentHomeBusyError`。写入包在 `exclusiveAgentMemoryHome` 内（`agent-memory.ts:393-412`）。macOS 用 `openAgentMemoryFilesystemHelper`（`task-runner.ts:3483-3499`）。不开放 control-socket 方法：same-UID 进程都能连 socket，入口只有 mailbox notice → 进程内 processor。

**平台。** capability 仅在 hook 存在、`agentHome` 已配置、`isAgentMemorySecureFilesystemAvailable(helper 已配置)` 为真，且 ledger 写入满足 §L 严格目录 fsync 停止点 ⑤ 时 advertise；只配置 helper 不足以 advertise。Windows 不 advertise；无视 capability 的陈旧 notice 在 fetch 前抛 `filesystem_unavailable`，与 provisioning `handler_unconfigured` 同一纪律（`create-daemon.ts:656-670`）。

**busy。** 选 D2：不 resolve，replay 重试。D1（非 terminal completion + Host attempt 重发；与 fetch disposition `deferred` 无关）需要非 terminal outcome 与 Host 调度，被拒绝。D2 代价是 cursor 前缀 stall；其他 row 仍独立处理，read-ahead 窗口内 control 可越过 stall。Turn 连续排满时 apply 可能长期抢不到 lease，补救是 Host 在 intent 未 terminal 时暂缓该 Bot 的下一个 Turn（R5）。

**默认可见性。** apply 需要 base lease，不与同一 daemon 上该 home 的 execution 重叠；第 7 步之后 admit 的 execution（若有 read）通过 live recall 看到它；相对具体 Host Turn 的先后无保证。这不构成 next-turn-only 契约（R2）。

**版本。** 新 message type + capability + schemas，属于 freeze rule 的 additive 条目（`docs/protocol.md:29-37`）；cloud enqueue 在 append 前检查 durable capability；golden 以 `BYOK_PROTOCOL_UPDATE_GOLDEN=1` 重生（`packages/protocol/src/__tests__/freeze-guard.test.ts:322-331`）。无 paired cut。

**禁止项。** 无 dual write；无 semantic fallback（每个失败要么 typed terminal，要么不 resolve）；无 auto snapshot；无 Host raw-memory DB（pending body 有界、terminal purge、永不用于 recall/prompt/重建）；不从 `agent.memory.projection` import；不声明 next-turn-only 可见性。

## 状态机

Host intent：

| 状态 | 进入 | 允许转移 | body |
| --- | --- | --- | --- |
| `approved` | approve 事务 | 首次 release → `dispatched`；revoke → `revoked`*；过期 → `expired`*；placement/profile 变化 → `withdrawn`* | 保留 |
| `dispatched` | 首次 release | completion → `applied` / `conflict` / `rejected` / `uncertain`；revoke 只记 `revokeRequestedAt`（「release 之后请求撤销；结果以 device completion 为准」）；revoke/过期/变化阻止后续 re-release；device 被 unenroll/revoke → `unconfirmed` | 保留 |
| `applied` / `conflict` / `rejected` / `uncertain` | device completion | 无 | 同事务 purge |
| `revoked`* / `expired`* / `withdrawn`* | Host 单方 | 无 | 同事务 purge |
| `unconfirmed` | device 身份消失 | 无；结果不可知 | 同事务 purge |

`*` 为 host terminal，只发生在从未 release 的 intent 上。`approved→dispatched` 与 revoke/expire 在同一行锁下串行。approval 消费：一次批准只绑定一个不可变 intent，不能复用到其他 path、内容或 base；首次 release 即消费。

device ledger：`none → applying → applied | conflict | rejected | uncertain`；`none → rejected`（校验失败或 withheld，零写入）；`applying` 只能在入口转 `uncertain`；terminal 之后只追加 `ackedAt`；只有带 `ackedAt` 的记录可裁剪。

事实分开记录，历史 receipt 与当前观测不混用：

| 事实 | 证据 | authority | 不能推出 |
| --- | --- | --- | --- |
| 命令已发送 | intent `approved` + enqueue 返回 `{messageId, seq}`；delivery watermark 只说明 row 交给过 device | Host、SDK cloud | 已 release、已应用 |
| 本 intent 的 CAS 结果（历史 receipt） | live path 的 `applied` / `conflict`，terminal 已持久化 | device | 当前文件仍如此 |
| 本 intent 结果未知 | `uncertain` | device | 任何 provenance |
| 当前文件观测 | completion 的 `result` / `observed`（观测时刻不上 wire，Host 未知） | device 观测，Host 持副本 | 此刻仍成立；过期只在下一次 CAS 以 `conflict` 暴露 |
| Host 已记录 | Host terminal 行与 `recordedAt` | Host | device 已 `ackedAt` 或 cursor 已前进 |

receipt 只含 digest，Host 能验证 `applied.result.revision = targetRevision`，却无法从中还原内容。

## §B Host body 存储、保留与 bootstrap（WP2D-F4）

Host 侧唯一 raw body 位置是 pending-body record：`{bodyId, content, contentDigest, byteCount}`，`contentDigest = sha256(utf8(content))`，`byteCount ≤ 256 KiB`。proposal 以 `bodyRef` 引用；approve 时 intent 引用同一 `bodyRef`，并以 `targetRevision = contentDigest` 与 `operationDigest` 绑定，不复制。proposal / intent 行没有 content 列。来源 conversation（含 model tool call 参数，若被记录）按其自身策略保留，与 proposal body 无关。

| 链路状态 | body purge 触发 |
| --- | --- |
| proposal `proposed` | 保留 |
| proposal `rejected` / `withdrawn`（提议方撤回） / `expired`（未审批过期） | 进入该状态的同一事务 purge |
| proposal `approved` → intent `approved` / `dispatched` | 保留（re-release 需要），所有权移交 intent |
| intent `applied` / `conflict` / `rejected` / `uncertain` | 记录 completion 的同一事务 purge |
| intent `revoked`* / `expired`* / `withdrawn`* | Host 单方终结的同一事务 purge |
| intent `unconfirmed` | 标记的同一事务 purge |

purge 后保留 `bodyId`、`contentDigest`、`byteCount`、`path`、`operation`、actor 与时间戳。时间驱动的过期由 Host 定时迁移，迁移与 purge 在同一事务。

实现者删除断言：B1 任一 terminal proposal 或 terminal intent 的 `bodyRef` 在 pending-body 中无行；B2 每个 pending-body 行恰好被一条活链引用（`proposed` proposal，或 `approved` proposal 加非 terminal intent）；B3 除 pending-body 外无表含 raw content；B4 delete 链 `bodyRef` 为 null；B5 body 不出现在日志、notice、completion、readback、mailbox。

**bootstrap（非阻断项）：** 新建 Host note 时，intent 以显式审批的「absent-or-empty」期望 `baseRevision = sha256("")`，UI 必须写明缺失与空文件在 SDK 中等价（`agent-memory.ts:220-237`）。对 Host 从未观测过的已有文件，首个 intent 以同一期望提交，得到 live path `conflict{observed}`；之后可由新 proposal + 新审批以 observed revision 为 base，UI 必须写明会覆盖 Host 看不到的内容（R11）。任何路径都不得静默断言文件缺失。

## 字段表

**Notice `agent.memory.intent.available`**（server → daemon；forbid `task_id`，require `seq`，`.strict()`）：`intentId`（UUID，Host approve 时铸）、`agentRef`（`AgentHomeProjectionAgentRefSchema`，只用于 lease 与 ledger 路由，必须与 fetched intent 相等）。tenant/device 由认证连接决定。messageId = `uuidFromSha256({domain:'byok:agent-memory-intent-notice', tenant, deviceId, intentId})`。enqueue 错误：`agent_capability_missing`（无 capability 或 revoked，无 row）、schema 失败、`mailbox_receipt_mismatch`。

**Intent `AgentMemoryIntentV1`**（SDK protocol 定义，Host 产生）：

| 字段 | 约束 | 备注 |
| --- | --- | --- |
| `intentId` | UUID | |
| `agentRef` | 同 notice | |
| `path` | `validateAgentMemoryPath`；Host 也在 approve 时校验 | R10 |
| `operation` | `replace` \| `delete` | delete 禁止 `MEMORY.md` |
| `baseRevision` | `sha256:<64 hex>` | 即 SDK `save` 的 `expectedRevision`；bootstrap 用 `sha256("")` |
| `targetRevision` | replace：`contentDigest`；delete：`null` | 必须 ≠ base |
| `content` | 仅 replace 的 `release` 响应，UTF-8，≤256 KiB | 唯一携带内容的字段 |
| `approvalRef` | ≤128 B，`[A-Za-z0-9._:-]` | 只入 ledger/audit，device 不评估 |
| `operationDigest` | `sha256(canonicalizeJson({v:'byok-agent-memory-intent-v1', tenantId, deviceId, intentId, agentRef, path, operation, baseRevision, targetRevision, approvalRef}))` | tenantId 为 SDK tenant（Salesko `tenantRef`）；device 以本机值重算 |

**Fetch**（Host 路由；推荐 `POST /device/private-agent-memory-intents/fetch`，audience `salesko.agent-memory-intent.v1`）。请求字段：

| 字段 | 约束 |
| --- | --- |
| `assertion` | device assertion；tenant/device 只取自它 |
| `intentId` | UUID，等于 notice |
| `reservation` | `held` \| `none`；window 1 未能预留容量时必须为 `none` |

SDK transport `fetch({intentId, agentRef, reservation}) → unknown`，plain-data 快照后严格解析 `disposition ∈ {release, withheld, terminal, deferred}`：`release`（`intent`，replace 含 `content`；R16=B 时加 `releaseNotAfter`）→ 校验后进入 window 2；`withheld`（仅 dispatched；无 `content`；`code ∈ {intent_revoked, intent_expired, placement_changed, profile_revision_changed}`）→ 提交 `rejected{code}`；`terminal`（无 `content`，含 `readback`）→ 只在本地无行时出现（有行时 window 1 不 fetch），按 §L 无本地行 ack 例外处理；`deferred`（仅 `reservation: 'none'` 且 intent 非 terminal；只含 identity 与 digest，无 `content`，Host 不改状态）→ `ledger_full`，不 resolve，零写入。`release` 与 `withheld` 只可能回应 `held`。只要 Host 仍认得该 intent，fetch 必须返回完整 identity 与 digest（同 `docs/protocol.md:612-620` 纪律）；Host 在 mailbox retention 窗口内不得删除 intent identity 行。transport/HTTP/404 → `fetch_failed`，不 resolve。

**Completion**（device → Host）公共字段 `intentId`、`agentRef`、`path`、`operation`、`operationDigest`（R16=B 时加 `releaseDigest`），按 `outcome`：

| `outcome` | 附加字段 | 含义 |
| --- | --- | --- |
| `applied` | `result: {exists, revision}` | live path CAS 返回成功 |
| `conflict` | `observed: {exists, revision}` | live path CAS 抛 conflict；本次尝试零写入（以 §R 停止点为前提） |
| `rejected` | `code` | 未写 `applying`，零写入 |
| `uncertain` | `observed: {exists, revision}` | 本 intent 是否写过未知；只有当前观测 |

rejection codes（闭集，只命名失败的检查）：`intent_invalid`、`path_invalid`、`memory_md_not_deletable`、`content_invalid`、`intent_digest_mismatch`、`agent_ref_mismatch`、`agent_home_unavailable`（`intent_digest_mismatch` 与 `agent_ref_mismatch` 仍在 S1 wire enum 中，本实现不产出：身份或 digest 不符在身份门处以 `fetch_invalid` 处理，不形成 completion）、`release_expired`（仅 R16=B），以及 Host 码 `intent_revoked`、`intent_expired`、`placement_changed`、`profile_revision_changed`；这四个 Host 码同时构成 `HOST_TERMINAL_CODES`。相等性：上表字段 canonical 比较，不含时间戳。

**Readback**（Host → device）：`tenantId`、`deviceId`（等于 enrollment）、`intentId`（等于 notice）、`disposition ∈ {recorded, idempotent, conflict, host_terminal}`、`completion`（Host 存储的 terminal；`host_terminal` 时只能是带 Host 码的 `rejected`）、`recordedAt`。ack 规则：`recorded` / `idempotent` 要求 `completion` 等于刚提交的，否则 `readback_mismatch`；`host_terminal` 在 ledger 无 `applying` / `applied` 时接受；`conflict`，以及 `host_terminal` 撞上本地 terminal，表示 Host 事实与 device 事实矛盾：写 integrity audit、经 daemon observer 报告，再做 `ackedAt` barrier 后 resolve，barrier 失败则不 resolve。有 §L 的两道 barrier 时它不可达，除非存储对 fsync 撒谎或 WP2I-S2 停止点 ⑤ 未闭合。其余情形接受后进入 window 3。

**不 resolve 的 closed reasons：** `transport_unconfigured`、`filesystem_unavailable`、`home_busy`、`fetch_failed`、`fetch_invalid`、`complete_failed`、`readback_invalid`、`readback_mismatch`、`local_io_failed`、`ledger_full`、`ledger_invalid`。错误只含 reason 与 intentId，同构于 `ProviderProvisioningNoticeError`（`packages/client/src/daemon/provider-provisioning.ts:41-74`）。

**标识符：** `proposalId`（Host 内部，proposal 重试幂等）；`bodyId`（Host 内部，唯一 raw body）；`intentId`（approve 铸，wire 与 ledger 键）；`approvalRef`（审计关联）；mailbox `messageId`（cloud 派生，enqueue 幂等）；`operationDigest`（身份与内容绑定、completion 相等键）；`baseRevision` / `targetRevision`（每文件顺序由 CAS 保证）。不采用 provisioning 的 `operationGeneration`：它为不可按内容寻址的 profile 状态提供单调序（`packages/protocol/src/provider-provisioning.ts:62-78`）；memory 已有 content revision CAS。Host 以「每 `(agentId, path)` 至多一个 open intent」约束同文件并发。

**Authority：** tenantId/deviceId ← 认证连接与 assertion，由 SDK cloud、byok-control、device digest 重算校验；agentRef/placement/profile ← Host，由 Host release 校验；approval/revoke/expiry ← Host，在 fetch 事务校验；path/operation/body/base/target ← 不可变 intent，由 Host approve 与 device 重算校验；当前文件 revision ← device 文件，由 CAS 校验；apply 结果 ← device ledger，Host 核对 digest 与 `result.revision`；terminal 记录 ← Host，device 以 readback 对照 ledger。

## F. forget 的确切效果

forget 是一个经审批的 intent：对 `notes/**` 做 `delete`，或对 `MEMORY.md` / note 做去掉目标文字的 `replace`。

| 存储 | 效果 |
| --- | --- |
| device 目标文件 | delete 以 rename-to-tombstone 后 rm（`agent-memory.ts:283-287`）；replace 以 temp + rename（`:255-264`）。结果若为 `uncertain`，只能说明当前观测 |
| device 其他位置 | **不删除**：已释放磁盘块、快照与备份；runtime session transcript；model 写进其他 note 或 workspace 的副本；hosted projection outbox 中待发布的 redacted body（若启用）。audit 与 ledger 只含 metadata |
| Host pending-body | forget intent 自身的 replace body 在其 terminal 时 purge。已 terminal 的旧 intent body 已按 §B purge。仍 open 的其他 proposal 若含被遗忘文字，forget 不删除它们；需由 owner reject / withdraw（即 purge） |
| Host redacted projection | apply 不发布 mutation（mutation 绑定 task，`agent-memory-projection.ts:90-104`）；已启用的 Host 只在下一次 task-close snapshot 后更新；立即移除只能整 Agent erase。Salesko 未启用 |
| Host proposal / intent / history | **不删除**：proposal / approval 元数据、digest、receipt、canonical conversation 与 raw messages（含 model tool call 参数，若被记录）、Summary、preparation request/artifact、terminal/audit、日志 |
| SDK mailbox / device journal | notice 只含 `{intentId, agentRef}`，本无内容 |
| model provider | 已发送过的 prompt 不受控制 |

`MEMORY.md` 不能删除，只能改写。本契约不提供「全部遗忘」语义，UI 文案必须写明实际删除范围。

## 裁定表

| # | 问题 | 类型 | 推荐 |
| --- | --- | --- | --- |
| R1 | Bot execution `agentMemory` | Owner 已决定（经 w2:pB 转述「批准」`none`，2026-09-28；repo 无书面记录） | 保持；建议落入 Salesko plan/notes |
| R2 | next-turn-only 可见性 | Owner 待定 | 默认只有 lease 互斥；若需要，由 Host 暂缓 Turn（同 R5），不新增 SDK lease |
| R3 | later execution 如何 recall | Owner，所有实现包的前置 | `none` 下无消费者。二选一：Salesko 提到 `read`（WP2I-H3），或暂缓 WP2-I。Host 注入 intent body 与 SDK auto snapshot 均不可选 |
| R4 | Host body 保留 | Owner | 推荐首个 terminal 即 purge（§B）；可选：terminal 后有界 grace window 供审计展示（扩大 forget 残留面，不推荐）；是否为已 rejected proposal 提供「撤回拒绝」（需要保留 body，不推荐）。先例 `h1b:apps/api/src/private-agent-provider-provisioning-store.ts:85` |
| R5 | busy 下的 liveness | 证据可判定 | D2 + Host 对有 open intent 的 Bot 暂缓下一 Turn；暂缓落在 pB-owned 入口，属 WP2I-H3 |
| R6 | approver 角色 | Owner | 仅 Bot canonical owner；先例 `h1b:apps/api/src/private-agent-provider-provisioning-routes.ts:147-148`；`h1b:apps/api/src/private-agent-chat-repository.ts:153` |
| R7 | forget 范围 | Owner | 按 §F，仅 device 目标文件与本链 body；其他存储需各自 retention/erasure 契约 |
| R8 | release 前 profileRevision 变化 | 证据可判定，Owner 可放宽 | fail-closed：阻断 release，需重新审批；依据 Host 已有 `agent_profile_changed` 结算（`h1b:apps/api/src/private-agent-chat-repository.ts:1113-1118`） |
| R9 | proposal 来源 | Owner | 用户 UI 起步；model tool 需扩展 `salesko.propose.v1` 并触发 reprepare |
| R10 | intent 可指向的 path | Owner | 仅扁平前缀 `notes/host-<slug>.md`（primitive 不代建子目录）；`MEMORY.md` 不对 Host intent 开放 |
| R11 | conflict 后以 observed revision 重新提议 | Owner | 允许，须新 proposal + 新审批，UI 写明覆盖 Host 看不到的内容；禁止自动 rebase |
| R12 | receipt 暴露 observed sha256 | 证据可判定 | 暴露；同类 metadata 已在 device audit（`agent-memory.ts:359-363,452`） |
| R13 | approve 是否要求 device 在线 | 证据可判定 | 不要求；provisioning 要求在线（`h1b:apps/api/src/private-agent-provider-provisioning-routes.ts:166`）源于密封窗口 |
| R14 | `expiresAt` 窗口 | Host 配置 | 有界，不超过 mailbox retention |
| R15 | carrier 与版本 | 证据可判定 | (a)，additive，无 paired cut |
| R16 | 授权线性化 | Owner | **A（推荐）**：release 时点不可撤回 grant。B：`releaseNotAfter` 硬截止，局限见 §A |

## 实施工作包

顺序：R3（及 R4/R6/R9/R10/R16）裁定 → WP2I-S1 → WP2I-S2 ∥ WP2I-S3 → SDK release（独立授权）→ Salesko H4 合入 main 并与 pB 协调 → WP2I-H1 → WP2I-H2 ∥ WP2I-L1 → WP2I-H3（条件）→ WP2I-W。写路径互斥，同一文件只在包之间顺序移交。

| 包 | 依赖 | 独占写路径（候选） |
| --- | --- | --- |
| **WP2I-S1 SDK protocol/core** | R3 为 go | 新 `packages/protocol/src/agent-memory-intent.ts`；`packages/protocol/src/messages.ts`（`:1350-1354`、`:1390-1393`）；`envelope.ts:76-79`；`codec.ts:96-99`；`version.ts:114-140`；`packages/protocol/src/index.ts`；新 `packages/core/src/agent-memory-intent.ts`（digest，模式同 `packages/core/src/sealed-provider-secret.ts:421`）与 `packages/core/src/index.ts`；新测试 `packages/protocol/src/__tests__/agent-memory-intent.test.ts`、`packages/core/src/__tests__/agent-memory-intent.test.ts`；golden `v1.frozen.json`、`v1.envelopes.ndjson`；`api-surface/protocol.d.ts`、`api-surface/core.d.ts` |
| **WP2I-S2 SDK client** | S1 | `packages/client/src/daemon/agent-memory.ts`；新 `packages/client/src/daemon/agent-memory-intent.ts`（processor、ledger、windows 1–3）；新 `packages/client/src/daemon/plain-data-snapshot.ts`（移自 `provider-provisioning.ts:158-198`）与 `provider-provisioning.ts`；`create-daemon.ts`（DaemonConfig、`computeCapabilities` `:1083-1128`、路由 `:2731-2735,2773-2778`）；`packages/client/src/agent-home.ts`（仅当需要不跑 `projection.prepare` 的 task-free initialize）；`packages/client/src/index.ts`；新测试 `packages/client/src/__tests__/agent-memory-intent.test.ts`，扩展 `daemon-conn-hello-capabilities.test.ts`；`api-surface/client.d.ts` |
| **WP2I-S3 SDK cloud + docs** | S1；与 S2 并行 | `packages/cloud/src/cloud.ts`（`:590-606`、`:2134-2162` 旁）；新 `packages/cloud/src/__tests__/agent-memory-intent-notice.test.ts`；`docs/protocol.md` 新 §2.4；`docs/spec.md` Durable Agent homes；`api-surface/cloud.d.ts` |
| **WP2I-H1 Salesko contracts + api** | SDK release；H4 在 Salesko main；pB 协调 | 新 `packages/contracts/src/private-agent-memory-intent.ts` 与 `packages/contracts/src/index.ts` 导出；新 `apps/api/src/private-agent-memory-intent-store.ts`（proposal、intent、pending-body；memory + PG）；新 `apps/api/src/private-agent-memory-intent-routes.ts`；`apps/api/src/index.ts` 注册；新 `deploy/sql/00NN_private_agent_memory_intents.sql`（编号待 H4）；对应测试 |
| **WP2I-H2 Salesko byok-control** | H1 contracts | 新 `apps/byok-control/src/private-agent-memory-intent.ts`（device relay + admin notice，形同 `h1b:apps/byok-control/src/private-agent-provider-provisioning.ts`）；`apps/byok-control/src/main.ts` 注册（先例 `h1b:…/main.ts:231,461`）；测试 |
| **WP2I-L1 Salesko device** | SDK release；H1 contracts；macOS helper 可用 | 新 `apps/local-agent/src/agent-memory-intent.ts`；`apps/local-agent/src/daemon.ts`（`h3:…:133-142` hooks、`:205-207` audiences、`:225` 旁、`agentMemoryFilesystem`）；`apps/local-agent/src/cli.ts`（先例 `h3:…:275-282`）；测试 |
| **WP2I-H3 条件** | R3=`read` 或 R2/R5 要求暂缓；H4 合入；pB 同意 | 四个 pB-owned `apps/api` 入口；`packages/contracts/src/private-agent-preparation-wire.ts:22`、`index.ts:6320,6334`；`h3:apps/local-agent/src/input-preparation-authority.ts:78-83`；新 SQL 放宽 0082 的 `agentMemory='none'` CHECK。Salesko 侧 paired cut，需自己的 drain 与 contract |
| **WP2I-W 审批 UI** | H1 | `apps/web/src/routes/app.bots.*.tsx`、`apps/web/src/workspace/bots/*`（仅 wkc-h2，**[unverified]**） |

### 验收矩阵与停止点

| 包 | 正向 | 负向 / 轨迹 | 停止点 |
| --- | --- | --- | --- |
| WP2I-S1 | 各 schema 解析；digest golden 固定字节；golden 只增不改；completion 含 `uncertain` | 多余/缺字段、delete 带 content、`deferred` 带 content、`host_terminal` 配非 Host 码、target=base、`approvalRef` 越界字符全部拒绝 | golden 出现既有项改动即停 |
| WP2I-S2 | replace 新建/更新、delete note 得 `applied`；replay 对 target memory 零新增 CAS（ledger barrier 必须重写）；complete 只在 terminal barrier 之后、resolve 只在 `ackedAt` barrier 之后；bootstrap `sha256("")` 对缺失与空文件均通过 | T1–T6 均为 `uncertain`，本 intent 的 CAS 调用数 T1、T6 为 0（CAS 前 crash，T6 中的 B 来自其他 writer）、T2–T5 为 1，所有轨迹断言「CAS 总调用 ≤ 1，恢复路径新增 0」；D1–D4；HT1–HT9；L1–L7；A1–A5（device 侧：release 后不再检查 revoke/expiry；busy 后必须重新 fetch）；home busy 零写入且未 fetch；跨 Agent、digest、`MEMORY.md` delete、超限、非 UTF-8、stale base 均 typed；Windows 与无 helper 的 macOS 不 advertise；readback 不符不 resolve；无 control-socket 方法 | ① 需放宽 `AgentMemoryTaskContext` 即停；② 未能对 native 与 helper 两个后端证明「conflict ⇒ 无 rename」，conflict 分支改映射 `uncertain`；③ `AgentMemoryError` 不能用 typed 子类区分确定性失败与 I/O 失败即停，禁止解析 message；④ 实测最大记录 + 分隔符 > `R_MAX` 即停；⑤ ledger barrier 未能证明 file fsync + rename + directory fsync 全部成功（见 §L）即停 |
| WP2I-S3 | 有 capability 时 enqueue，重试同 seq | 无 capability 或 revoked → `agent_capability_missing` 且无 row；payload 多字段拒绝 | 文档只写已实现行为 |
| WP2I-H1 | approve 生成唯一 intent 并共享 `bodyRef`；首次 release 原子 `approved→dispatched`；`reservation: none` 不做任何迁移（不 dispatch、不单方终结、不释放内容）；completion `recorded`/`idempotent`；terminal 同事务 purge | B1–B5；reject/withdraw/过期 proposal 同事务 purge；他 device/tenant 不释放；release 前阻断条件单方终结；dispatched 上 revoke 只记 `revokeRequestedAt` 并阻止 re-release；`uncertain` 记为 non-success；同 path 第二个 open intent 被拒；UI 文案不含「撤销晚于应用」「已应用/未应用」（对 `uncertain`） | H4 未合入或 pB 未确认前不开工 |
| WP2I-H2 | principal 只取自 assertion；409 映射 capability 缺失 | body 中 tenant/device 被忽略；readback 指向他 device → 502 | 同 H1 |
| WP2I-L1 | helper 已配置且满足停止点 ⑤ 时 advertise；fetch/complete 签 assertion 走新 audience | 无 helper 的 macOS 不 advertise；transport 抛错不 resolve | SDK release 未发布即停，不 vendor |
| WP2I-H3 | 仅新 prepared request 携带 `read`；recall 读到已应用内容 | 旧 v9 `none` 行不被改写；`read-write` 不被隐式开放 | 无 Owner R3 书面裁定不开工 |

## 10x 与 falsifier

10x 时最先承压的是同一 Bot 的 busy 窗口：apply 与 window 3 都要在连续 Turn 之间取 lease，cursor stall 变长；Host open intent 与审批积压排在其后；ledger 511 条上限只在大量未 ack 记录堆积时触及。

会改变结论的证据：busy 时长 × mailbox 流量接近 4096 read-ahead 或 retention → 改用 D1；Owner 在 R3 继续 `none` 且无其他消费者 → 暂缓 WP2-I；无法在不放宽 task context 下把 CAS primitive 收窄为 home binding → 重新评估 (b)；产品要求 release 后仍可硬撤销 → 选 R16=B 并接受其局限，或重新设计为设备侧可验证的撤销（本轮未设计）。

## Evidence limitations

- 全部为 source 级证据：SDK `050349af` 与三条未合入的 Salesko 分支。未运行测试、daemon、Host route 或 mailbox，不证明部署、数据库或 live 行为。
- Owner 对 `agentMemory: none` 的批准只有 w2:pB 转述。
- busy 行在同一连接经 replay-from-ACK 重试，依据 `docs/protocol.md:1506-1509` 与 `connection-manager.ts` 阅读，未运行验证；spec 只保证 reconnect/restart 后重投（`docs/spec.md:1822-1824`）。
- `R_MAX` 的 1810 B 为按字段上界构造的 JSON 实测，非实现代码实测；WP2I-S2 须以真实序列化复核。
- macOS helper 后端的 conflict/rename 顺序与缺失父目录行为未核验。
- mailbox retention 时长、Salesko 对 retryable decline 的重试上限、apply 与 window 3 引起 Turn decline 的频率未核验。
- Salesko 是否有可发的 secure-filesystem helper 未核验；model tool call 参数是否被 Salesko 持久化未核验。
- wkc-h2 Web bots 页面、`h1b:deploy/sql/0083…` 80 行之后、`0004-0006` change-set RPC 未打开；H4 合入后 `apps/api/src/index.ts`、`packages/contracts/src/index.ts`、`apps/byok-control/src/main.ts` 的形状需开工时复核。
