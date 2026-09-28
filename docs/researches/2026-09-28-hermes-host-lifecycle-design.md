# Hermes Bot Mode：Host 记忆生命周期、身份与工具边界（WP2-D）

> **状态：设计候选，非产品实现、非 runtime/release 验收。**
>
> **范围：** 此文只为 `WP2-I`、`WP3`、`WP4` 定义可判定的下一切片。它不批准字段、UI、审批政策、Host 数据库或任何 SDK/Host wire 变更。Salesko 是首个候选 Host；现有 Salesko `main` 是旧路径，本文针对只读 prepared 候选树 `salesko-new-wt-c07-host` 的 `5670f5d12537b12636df896bccf7bbbe25f02e69`。该候选树的 `todos` WIP 未读取为实现结论。

## 结论

本地 canonical Agent home 的 `MEMORY.md` 和 `notes/` 是 Agent working-memory 的唯一写 authority；SDK 已提供 exact active task context 绑定的 `recall`/`save` 与 sha256 CAS，且 home/lease/`AgentRef` 已是 durable execution boundary。Host 仍是 persona、用户业务语义、proposal/approve/reject 的治理语义、canonical conversation 与 epoch 的 authority。二者之间只能通过一个后续、显式批准的 Host-to-device contract 连接；不得让 Host 复制原始 memory、不得新建 Host memory database，也不得把 redacted hosted projection 解释为远程 authoring。

因此，提议→审批→CAS apply→下一次合法执行 recall→纠正/forget 是 **future WP2-I candidate**，不是现有功能。现有 source 已能复用的是：本地 memory CAS、单 home 互斥、canonical conversation/epoch、sealed ContextPack→preparation document bridge、write-once preparation request 和 ready-first queue gate。现有通道都不能安全承载已审批的 UI action 到 device-local CAS（WP2-I-D 已逐一比较）；候选契约见 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md`，推荐新增 task-free notice-and-fetch family `agent.memory.intent.available`。该契约仍是设计候选，待 Owner 裁定后才能实施，不能把它伪装成已有 capability。

## P1：边界与当前 authority

| datum / action | 当前 authority | 已有可复用面 | 当前状态与禁止事项 |
| --- | --- | --- | --- |
| Agent working memory (`MEMORY.md`, `notes/**`) | device-local canonical Agent home | SDK home 初始化、exact task context、`AgentMemoryService.recall/save`、per-home serialization、sha256 CAS | **已实现的 local primitive**。SDK 把 Agent-owned files 视为 opaque；Host 不读取或 author 原始 bytes。|
| redacted memory projection | device→hosted latest-value projection | `agent.memory.projection` protocol | **不是 authoring path**：明确排除 remote authoring、merge、import、history、RAG。不能作为 approve/apply/recall 的替代。|
| persona、用户事实、proposal/approval/rejection 语义 | Host | Host system prompt、conversation/epoch、prepared request identity | **Host business authority**；目前没有获批的 proposal record/schema/UI policy。|
| conversation、turn、epoch、settlement、ContextPack/Summary read | Host canonical chat store | snapshot transaction、epoch/history validation、ContextPack、preparation bridge | **候选 Host 已实现**。它是聊天上下文 authority，不是 Agent memory authority。|
| Summary | Host read path | `readContextPackSummary` + coverage validation | **reader only**；没有生产 writer/job/API，不能用 Summary 代替 memory 或把 forget 说成删 Summary。|
| authentication / execution identity | authenticated tenant/device principal + exact `AgentRef { agentId, profileRevision }` binding | durable Agent home, manifest, lease, terminal echo | AgentRef is execution identity, not an authentication credential; title/SOUL/session cannot replace authentication or execution binding. |
| tool discovery / invocation | sealed execution + Host authorization | frozen `requiredToolsets` / schema digest / ready receipt | 当前 prepared 候选只有 Salesko MCP；可发现不授予调用权，approved capability change 只影响下一次 sealed execution。|

### 关键 source

- SDK 将 `AgentRef { agentId, profileRevision }` 设为 durable identity；canonical home 是唯一 runtime cwd，封入 immutable manifest，并在单 home 上序列化执行：`docs/spec.md:1614-1639`。
- memory API 要求 exact active Agent task context；仅允许 `MEMORY.md` 或安全的 `notes/*.md`，`save` 以 expected sha256 revision CAS：`packages/client/src/daemon/agent-memory.ts:114-130,438-455`。`MEMORY.md` 不可 delete；note delete 仍要求 expected revision：`:277-297`。
- Host 只应依赖 opaque projection hook；local home projection 的 ordering record 属于 SDK 的 `.byok`：`docs/spec.md:1675-1686`。但协议对 hosted redacted snapshot 明言不是 remote authoring/import/history/RAG：`packages/protocol/src/agent-memory-projection.ts:84-104`。
- 任务 assertion 只认证 claims；task、AgentRef、toolset 是否仍属于 execution 与是否允许 invocation 是 Host decision：`docs/spec.md:1014-1024`。

## 来源表：main 与 prepared candidate

| 证据面 | Salesko main `83bcbfc5` | prepared candidate `5670f5d1` | 本设计采用的结论 |
| --- | --- | --- | --- |
| 用户 Turn 运行路径 | 旧 fresh/legacy handoff，不能代表 prepared 现状 | queue head 先要求 `preparation_ready`，再 freeze execution：`apps/api/src/private-agent-chat-preparation.ts:33-70` | 只以 candidate 描述当前 prepared 接口点；不声称已线上启用。|
| ContextPack | 历史设计材料，不作为 current prepared proof | pure assembler/validation；不 I/O、不计数，summary/history/input 统一投影：`private-agent-chat-context-pack.ts:207-266` | **复用，不重建**；candidate memory 不自动混入 pack。|
| wire document | 无此 current prepared evidence | 唯一 sealed pack/content→SDK document bridge：`private-agent-chat-preparation-document.ts:1-22,46-76` | persona/prompt 的 future change 必须在这里之前由 approved Host input 决定，并重封 request。|
| source snapshot | 旧路径不作断言 | 同一 snapshot 读取 history、Summary、Agent context，构造 exact profileRevision/toolsets：`private-agent-chat-repository.ts:2013-2057` | Host conversation 与 Agent context 不能各自另取最新值。|
| request / seal | 旧 handoff 不证明 D equals execution | summary digest、toolset、ruling/facts 都进 request identity；oversize 明确拒绝：`private-agent-chat-preparation-request.ts:175-190,214-263`；request write-once：`private-agent-chat-preparation-lane.ts:199-243` | 已封请求不可被 UI/approval 改写。|
| prepared toolset | 旧文档不可证明新 tool surface | Salesko MCP only (`salesko.read.v1`, `salesko.propose.v1`)；不含 native / reserved agent-memory：`docs/researches/20260924-byok-018-c02-amendment-2-prepared-execution.md:40-44` | memory invocation 依赖 WP1-I，不能假定 current prepared Bot 可调。|
| Summary writer | 无生产闭环 | 生产无 writer/job/upload API；null 是合法，超预算阻塞：`docs/researches/20260912-byok-018-authoritative-contract-draft-3.md:291-297,505-515` | Summary 不能承担 proposal、memory authoring 或 forget erase。|

## P2：一条现有路径与未来 candidate lifecycle

### 已实现的候选 Host 路径（没有 memory proposal/apply）

1. 用户 input 被 Host canonical conversation 接收；target turn 的 epoch、owner、已结算前缀必须通过 ContextPack validation，跨 epoch、未结算 predecessor、损坏 Summary 都 fail closed：`private-agent-chat-context-pack.ts:106-175`。
2. repository 在一个 snapshot transaction 内读取 chat history、covering Summary 与 Agent context；它把 `agentId + profileRevision` 和 frozen Salesko toolsets 带入 preparation snapshot：`private-agent-chat-repository.ts:2013-2057`。
3. ContextPack 只做 content assembly；唯一 bridge 把 sealed content 和 Host system prompt 变成 SDK wire document，使用 stored timestamps，避免 requestId 同而 body 不同：`private-agent-chat-preparation-document.ts:1-22,46-76`。
4. builder 将 source/facts/summary/toolsets/ruling 编入 request identity，超出 inline 上限直接拒绝；lane 将 request write-once，race 时已存 body 获胜：`private-agent-chat-preparation-request.ts:214-263`、`private-agent-chat-preparation-lane.ts:199-243`。
5. 只有 receipt ready、frozen toolsets/schema digest/artifact digest 都一致时才进入 queue execution preparation：`private-agent-chat-preparation-lane.ts:305-354`、`private-agent-chat-preparation.ts:33-70`。

压力点是 step 2--5 没有 memory proposal、approval 或 apply，也没有 reserved memory tool；因此不能由 UI 写入、Summary marker、hosted projection 或 ContextPack 临时字段绕过 request sealing。

### `WP2-I` future candidate（尚未批准实现）

该 candidate 仅在 WP1-I 已使 prepared memory tool 可被 *正确计数、sealed、admit* 后才可实施。它描述 state/authority，而不是批准具体 record 字段或 UI policy。

| transition | candidate state | authority / required proof | side effect | negative condition |
| --- | --- | --- | --- | --- |
| propose | `draft → proposed` | Host records semantic proposal scoped to one Host principal + exact AgentRef/profileRevision + source conversation/epoch; model/device has no direct authoring grant | **none** to local memory | cross-Agent, stale conversation/epoch, malformed scope → refuse; no CAS call |
| approve | `proposed → approved` | Host applies product approval semantics and creates an immutable approval intent | **none** to local memory | UI visibility/title/session is not approval; failed/absent approval module → fail closed |
| reject / revoke before release | `proposed → rejected` or never-released `approved → revoked` | Host governance decision + audit | **none** to local memory | rejected proposal never reaches device; revoke after release is only a request (`revokeRequestedAt`) and the outcome follows the device completion; no compensating memory write |
| apply | `approved → dispatched → applied / conflict / rejected / uncertain` | candidate contract `2026-09-28-hermes-device-memory-cas-contract.md` (not yet ruled) delivers approved intent to the exact device/AgentRef/profileRevision and expected local file revision(s); device uses local `AgentMemoryService.save` CAS | atomic replace/delete only in local Agent home; typed receipt reports the locally produced result revision | stale expected revision → conflict; one intent performs its CAS at most once; an unresolved `applying` is reported as `uncertain` (no provenance claim, never replayed); transport uncertainty stays unconfirmed |
| next-turn recall | `applied` becomes eligible only for a new execution | Host may cite the device apply receipt's result revision, but only device-local CAS/recall determines a file's current revision; binding that receipt/revision into preparation remains a **missing contract edge** | model may call the admitted local memory tool during that new execution | frozen request/tool surface of a current execution do not change. Existing live memory helper can read later disk state; a requirement that only the next turn observes apply needs a new visibility/lease contract, not an inference from prompt sealing |
| correct | new proposal, not mutation of prior approval | same Host governance + fresh expected revision | new local CAS only after approval | no last-write-wins or implicit merge |
| forget | a scoped approved local operation | exact target files/revisions and declared retention scope | local note delete or content replacement via CAS; `MEMORY.md` is not deletable by present primitive | does **not** delete canonical conversation, raw messages, Summary, preparation request/artifact, terminal/receipt/audit, caches, or hosted redacted projection unless each store has a separately approved retention/erasure contract |

**device CAS 边（WP2-I-D 候选契约）。** 字段级契约、状态机、恢复矩阵、forget 范围与裁定表见 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md`。推荐 carrier 是新的 task-free notice-and-fetch family `agent.memory.intent.available`（capability `agent-memory-intent.v1`，additive，不动 `PROTOCOL_VERSION` 与 input-preparation v8）：Host 在自有 device-assertion routes 上释放不可变 approved intent 并接收 typed receipt；daemon 以 `agent.home.projection` 同款 task-free home lease 在进程内调用现有 CAS，先写 `.byok` apply ledger，terminal 与 `ackedAt` 各经 durable barrier 后才 complete / ack；home busy 时不 ack，该窗口不做新写入。`task.offer`、`agent.content.read` 与 `agent.home.projection` 三个候选均被拒绝，理由见该文 P3。receipt 的 result revision 只作为 Host 的观测副本被引用。next-turn-only 可见性仍待 Owner 裁定（该文 R2）；Salesko 当前 `agentMemory: none`，later recall 不存在（该文 R3）。候选契约获批前，仍不得建 Host raw-memory DB 或使 redacted projection 反向导入。

## P3：设计判断、10x 压力与 falsifier

选择 local Agent home 作为 working-memory single writer，是因为它已有 path containment、lease/exact task binding、CAS、bounded snapshot 与 per-home mutual exclusion；把相同 bytes 再放入 Host 会创造第二 authoring authority。Host 不拥有 raw memory，仍完全拥有用户业务语义及 approval/routing policy，因此 proposal semantics 不需要落到 SDK protocol。

10x 时最先失效的是同一 home 的多 proposal/CAS 冲突与审批积压，其次是每次准备携带的 tool/schema/context 预算。首刀只接受 explicit conflict、bounded proposal list 和 no auto-merge/no auto-apply；不引入 vector store、background summarizer、cross-Agent discovery 或 generic Host memory service。SDK snapshot 也有 bounded file/byte contract：`packages/client/src/daemon/agent-memory.ts:494-509`。

**Falsifier：** 若 WP1-D/WP1-I 无法将 memory descriptor、implementation identity、policy/authorization 与 usage accounting 一并纳入 preparation/admission，或 device CAS contract 不能表达 exact approved intent 并回传 durable receipt，则 WP2-I 被阻断。正确结果是保持 proposal 为 Host-only pending/rejected state；不得 auto-inject memory、放宽 current sealed toolset、或以 Host/Summary/projection 副本代写。

## 身份、capability 与 scope-bound discovery

| change | frozen current execution | next execution | authority |
| --- | --- | --- | --- |
| tenant/device authenticated principal + exact AgentRef | authenticated tenant/device principal is the credential boundary; exact AgentRef is the sealed execution identity, but is not an authentication credential by itself | next execution must bind both current authenticated tenant/device facts and exact selected AgentRef | authenticated device/tenant transport plus Host admission; SDK verifies exact claims |
| title、display name、SOUL/persona 文本 | 不改 authenticated principal、AgentRef、home、lease 或 sealed request/tool surface | 若 Host 决定变更 prompt，必须重新 snapshot/prepare/seal；同名 Agent 不共享 home | Host controls presentation/persona; SDK controls exact AgentRef/home |
| session close/rebuild/runtime restart | 不创造新 Bot；resume 必须 exact AgentRef/profile/session/runtime/cwd，否则 fail closed：`docs/spec.md:1631-1639` | fresh session still uses same AgentRef unless Host explicitly issues a new profile revision | SDK runtime/session evidence |
| profileRevision | existing sealed execution remains exact original identity | Host resolves it before new snapshot; next prepared request gets new AgentRef and must seal anew | Host profile revision selection + SDK exact identity enforcement |
| memory tool / capability / schema / implementation / policy | frozen request/tool surface does not change; this does not freeze bytes later read by an already-admitted live helper | only newly prepared execution may expose a capability change after descriptor + schema digest + implementation identity + authorization are admitted and accounted | WP1-I contract plus Host admission; next-turn-only visibility requires a further explicit contract |
| skill/tool discovery | no enumeration beyond frozen toolset | discovery result is scoped to candidate AgentRef/profileRevision, Host principal, approved capability policy, device/runtime and sealed toolset; outside scope requires reprepare/admit | Host authorization, SDK verifies exact authenticated claims |

Tool visibility is never invocation authorization. The existing candidate already rejects ready when frozen toolsets/schema digest do not equal the ruling: `private-agent-chat-preparation-lane.ts:305-333`; this is the seam a future memory descriptor must satisfy, rather than an invitation to add a compatibility helper.

## 最小后续 work packages、文件 ownership 与验收

| package | prerequisite | candidate entrypoints / future write ownership (not this document's authorization) | sufficient acceptance |
| --- | --- | --- | --- |
| WP1-I prepared memory reachability | WP1-D proves one descriptor→count→seal→handler chain | **SDK candidate entrypoints, per WP1-D:** `packages/client/src/daemon/prepared-tool-surface.ts`, `packages/client/src/daemon/input-preparation-service.ts`, `packages/client/src/bin/pi-prepared-host.ts`, `packages/client/src/adapters/pi/prepared-session.ts`, `packages/client/src/daemon/task-runner.ts`, `packages/client/src/adapters/pi/mcp-extension.ts`, `packages/client/src/daemon/agent-memory.ts`; focused tests `packages/client/src/__tests__/prepared-offer-lane.test.ts`, `prepared-tool-surface.test.ts`, `pi-prepared-tools.test.ts`, `agent-memory-mcp.test.ts`. Any new protocol/persistence file is **UNKNOWN** until its contract names it. | prepared surface includes memory only when schema/implementation/policy are frozen; mismatch/cross-Agent/stale binding rejects; native filesystem/terminal stay closed |
| WP2-I Host proposal lifecycle + device CAS transport | WP1-I; Owner ruling R3 (later recall) in the device-CAS contract; that contract approved; Salesko H4 merged to Salesko main and coordinated with w2:pB | Packages WP2I-S1/S2/S3, WP2I-H1/H2/H3, WP2I-L1 and WP2I-W, their dependencies and disjoint write scopes are in the device-CAS contract「实施工作包」(paths verified against SDK `050349af`, Salesko `main:4b1944c9`, `wkc-h1b`, `wkc-h3`). **SDK (WP2I-S1–S3):** new `packages/protocol/src/agent-memory-intent.ts`, `packages/core/src/agent-memory-intent.ts`, `packages/client/src/daemon/agent-memory-intent.ts`; edits to `packages/protocol/src/{messages,envelope,codec,version,index}.ts`, `packages/client/src/daemon/{agent-memory,create-daemon,provider-provisioning}.ts`, `packages/cloud/src/cloud.ts`, `docs/protocol.md`, `docs/spec.md`, `api-surface/*.d.ts`, protocol golden. **Salesko Host (WP2I-H1/H2):** new `packages/contracts/src/private-agent-memory-intent.ts`, `apps/api/src/private-agent-memory-intent-{store,routes}.ts`, `apps/byok-control/src/private-agent-memory-intent.ts`, `deploy/sql/00NN_private_agent_memory_intents.sql` (number after H4); registration in `apps/api/src/index.ts`, `apps/byok-control/src/main.ts`. **Salesko device (WP2I-L1):** new `apps/local-agent/src/agent-memory-intent.ts`; edits to `apps/local-agent/src/{daemon,cli}.ts`. The four pB-owned `apps/api` entrypoints (`private-agent-chat-repository.ts`, `-preparation-request.ts`, `-preparation-lane.ts`, `-preparation.ts`) belong only to conditional package WP2I-H3 (execution memory read or Turn hold). Web UI paths are **[unverified]**. | propose/reject have zero local effect; approve produces one immutable intent; stale CAS yields typed `conflict`; one intent performs its CAS at most once and unresolved `applying` is reported as `uncertain`; Host cites only device receipt result revision; home busy leaves the notice unacknowledged with zero writes; forget distinguishes every store per contract §F; next-turn-only visibility still needs an explicit Owner contract |
| WP3 identity feedback | WP2-D acceptance and Host product decision | Existing source entrypoint is `apps/api/src/private-agent-chat-repository.ts` for snapshot `AgentRef/profileRevision`; presentation/API files are **UNKNOWN**, must be selected without creating a Bot registry | title/session rebuild does not change AgentRef/home; revision change is visible and only next execution changes |
| WP4 scoped discovery | WP1-I and WP3 | Candidate Host entrypoints are `apps/api/src/private-agent-chat-preparation-request.ts` and `apps/api/src/private-agent-chat-preparation-lane.ts`; SDK entrypoints remain the exact WP1-I list above. Any new discovery schema/file is **UNKNOWN**; contract must assign disjoint exact paths. | discovery is scope-bound; unsealed tool cannot invoke; descriptor/schema/implementation/policy change causes reprepare/admit; measure real schema budget before expanding |

No package above authorizes a Host memory database, import from `agent.memory.projection`, deletion of conversation/Summary/history, deployment, or release. Focused tests named by the future contract are evidence only after running on its frozen subject; this document ran no product tests.

## Evidence limitations

- This is source-level evidence from SDK working tree and the stated Salesko prepared candidate. It does not prove deployment, database state, live provider/device behavior, or current Salesko main adoption.
- `Summary` has a reader/coverage validator but no production writer/job/API in the cited design; its future lifecycle is out of scope.
- UI approval semantics, proposal schema and retention/erasure policy remain Owner decisions. The CAS transport now has a candidate contract (`2026-09-28-hermes-device-memory-cas-contract.md`, carrier (a)); it is not approved for implementation until the Owner rules R3 and the related items there.
