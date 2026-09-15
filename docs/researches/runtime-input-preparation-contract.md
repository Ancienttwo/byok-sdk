# Runtime input preparation / consume boundary

Status: proposed SDK contract with provider-free feasibility evidence. This document adds no public SDK API and does not replace accepted C05.

Current checkpoint: G2 native Session/RPC prepared consume PASS on the artifact-bound local evidence in §17 (`.artifacts/c07-native-input/g2-bridge-r3/`), building on the §16 G1 package declaration closure. The native bridge now admits a prepared first request through the real Session/RPC lifecycle with body equality, pre-transport drift rejection and a held reservation, verified against newly repacked local archives. Native package distribution is resolved per §18: the SDK pins the published fork `@byok-sdk/pi-coding-agent@0.85.1002` through an exact npm alias, so the §17 seam is reachable from an ordinary install. What remains unresolved is G3 trusted Execution/artifact binding (task-runner, pi-adapter, protocol), the B-P2 local primitive (frozen, §10), and G4 accounting/Host CAS/S0 activation; coverage remains `unknown`. Local package acceptance does not make first-batch token admission production-ready.

Owner authorized an independent contract and minimal offline spike on 2026-09-14. Source base: f811634c8c9ac6a16891c354eaf0adcb869004a2. Downstream authority remains Salesko frozen draft-3 §4.2/§7.3/§7.4, SHA256 c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678. Production numbers remain governed by S0.

## P1: ownership and gap

Host owns canonical source, ContextPack, admission readiness and atomic Execution creation. SDK owns exact runtime/provider selection, toolset authority and serialization. Provider owns token accounting. Current RuntimeAdapter.prepare receives a task offer and only validates runtime/profile constraints; Pi builds final provider input after claim/start. An ordinary SDK task cannot serve as a pre-Execution counting probe.

The new boundary must be independently callable before task submission. Preparation returns immutable input evidence, not an Execution, running task, tool grant, approval bypass or product result.

## P2: proposed data path

1. Host assembles one consistent ContextPack candidate, with exact owner, Agent, device, epoch, queue head, selection and revision.
2. SDK authenticates preparation through device/control authority and compiles complete runtime input under explicit disclosure/tool policy. No business tool or model execution occurs. Uncontrolled runtime startup code cannot participate.
3. Device-local credentials call the exact authorized counter endpoint. For the selected target it is https://api.z.ai/api/coding/paas/v4/tokenizer; general API endpoints are not interchangeable.
4. SDK returns an immutable artifact reference and evidence bound to full payload, counted projection, target, runtime closure, policies and coverage.
5. Host validates the input bound plus output/reasoning bound and uncounted overhead against the effective window, then performs the existing short CAS transaction. Network calls never hold PG row locks.
6. The committed Execution/offer binds that artifact. SDK launch consumes the same payload or refuses. Missing artifacts or identity/source/policy drift cannot trigger silent reassembly.

Wire names and versions remain unassigned. Production requires exact schema/capability/transport registration; experiment JSON is not a public protocol.

## Minimum semantic contract

| Part | Required evidence |
| --- | --- |
| Preparation request | Authenticated tenant/device/Agent ownership; exact selection/profile binding; source/ContextPack digest; disclosure/tool manifests; effective model identity |
| Prepared input | Immutable full request bytes/reference; compiler/runtime dependency fingerprint; endpoint and semantic options; authorized context/tool schemas; no credentials or nonce |
| Accounting | Exact counted projection and deterministic relation to full request; method/authority revision; count or proved bound; coverage gaps with independently proved bounds; output/reasoning enforcement and window evidence |
| Consumption | Expected artifact digest and exact target/source/policy; unchanged initial request at actual send boundary; later hooks cannot rewrite counted input |
| Lifecycle | No task/claim/business grant during preparation. Host commit remains the execution decision. Failed CAS leaves no dispatchable task. Post-commit artifact failure follows existing recovery and never substitutes new input |
| Authorization | Existing authenticated SDK/device authority; no caller-self-asserted identity or D2 task nonce before task existence. Digests prove content identity, not permission |
| Limits | Explicit required byte/call/retention policy, with no SDK defaults; missing or invalid policy refuses activation. SDK policy enforcement may be implemented before Salesko freezes its S0 values, but Salesko activation remains prohibited until that freeze. Experiment timeout/byte counts never become product defaults |

Receipt durability, retry availability, transport authentication, accounting equivalence, disclosure and cancellation during preparation must be specified before production activation. No mutable current-artifact authority or second Execution/job state machine.

### Owner-approved limits boundary — 2026-09-14

The owner selected required explicit policy with no defaults, and prohibited activation while Salesko S0 numerical values remain unfrozen. This supersedes the earlier requirement to freeze those values before implementing SDK policy enforcement. No numerical byte, call or retention limit is approved by this decision. Policy presence alone is not evidence of an S0 freeze; Salesko retains that activation gate. The independent native pure compile/consume prerequisite and all other acceptance requirements remain in force.

## P3: falsifier and sufficient condition

Let D be the immutable full request, P(D) its counted projection, N the authoritative count, U a proved bound for omitted semantic/provider framing, O the enforced output/reasoning bound and W the effective window. Require N+U+O <= W and proof that launch sends D under the same exact target/policy. CAS closes source-to-commit races; immutable consumption closes count-to-launch races. Byte equality does not prove token-accounting equivalence.

The cheapest falsifier is native compilation before task submission, a separate consuming launch and actual transport-body inspection. Altered artifact, target or authorized context must refuse before transport. A hook-only comparison cannot detect later serializer changes.

## Offline spike and result

Entrypoint: node scripts/experiments/runtime-input-preparation-spike.mjs.

Subject: installed Pi 0.85.1 and its bundled JavaScript closure, with an explicit Node binary. Repository production packages/dependencies are unchanged.

The probe creates a temporary cwd/agent directory with a synthetic AGENTS marker. Native Pi supplies its built-in system prompt, user input and four native tools; only the explicit artifact extension loads. Prepare exits at before_provider_request before SDK task submission or provider transport. A second native process validates artifact/binding and supplies the frozen payload. An Undici mock captures the POST body after serialization and returns fixed synthetic SSE.

| Case | Result |
| --- | --- |
| Prepare | Immutable request saved; no transport |
| Consume | Actual transport body equals prepared payload byte-for-byte |
| Alter artifact | artifact_integrity; no transport |
| Change Profile revision | binding_drift; no transport |
| Change authorized context | context_drift; no transport |

Current fixture payload is 6265 bytes, not a production budget. One mock transport request; zero external connections, credential reads, SDK task submissions or model generations. Source-bound result: _ops/c07-runtime-input/result.json. Disposable artifacts/logs remain local.

The first dispatcher mock failed safely: Pi configureHttpDispatcher overwrote it at startup and the socket guard refused the connection. Installing the same Undici mock from the final request hook fixes timing while preserving the independent socket guard. first-consume-blocked.log retains the failure. A subsequent refinement bound the full bundled JavaScript closure instead of only the entrypoint; all five cases passed.

## Proven boundary and limits

The controlled native serializer can produce a complete initial request before any SDK task exists. Its existing final payload hook can feed exactly those bytes into a separate native launch. This establishes feasibility of the input preparation/consume seam.

It does not implement a pure SDK compiler: prepare still starts an isolated CLI and writes disposable runtime files. Synthetic digest/binding is an experiment oracle, not authentication. Real MCP schemas, arbitrary extensions/private homes, artifact durability, Host CAS integration, counter equivalence and later tool-result iterations remain uncovered. Production must own or forbid every later payload writer and prove disclosure/side-effect constraints; it cannot simply ship this extension.

## Bounded next implementation decision

Specify SDK-owned preparation/consume API and authenticated artifact lifecycle around this seam, then prove preparation purity and real toolset/context projection. Keep production unsupported until these and counter coverage suffice. No release, package change, C05 amendment or production budget follows from this spike's PASS.

## C07 production 切片审议稿 — 2026-09-14（§6 defaults 已锁定；B-P1 freeze 见 §7）

本节把已通过的 offline spike 转成可审议的实施边界；**本轮只改研究文档和本地证据，不实施 production API，不改冻结 draft-3**。此前 required policy / no defaults 的决定继续有效，不重复请求数值冻结。Gateway probe 的结果不是本切片的授权或前置条件。

### 1. 本轮复核与首批请求的实际门

- S tokenizer checkpoint 的 8 个 artifact hash 全部匹配；原 pre-Execution path 的 13 个源文件 hash 全部匹配（SDK 路径在本独立 checkout 核对）。记录：`_ops/c07-runtime-input-production/production-slice-review.json`。
- Native dependency 的 8 个文件 hash、spike 的 4 个 source hash 及 probe 脚本 hash 均匹配；只读重新比较 retained `prepared.json.payload` 与 `consume-wire.json`，两者均为 6265 bytes，SHA256 同为 `463a47a0e2b85ecd7244ca36d44ef4e79d5d44d1c6d704bac268f1d6a6cc6bf3`。没有重启 native 或重跑旧测试。
- 当前 public exports 仍无完整 compile/consume；`buildSystemPrompt` 是 internal（native `dist/core/system-prompt.js:7`、`agent-session.js:738–767`），`buildParams` 是 private（`pi-ai/dist/api/openai-completions.js:581–650`）。normal launch 在 `:196–214` 先解析 credential/建立 client，再构造参数并经过 onPayload 到 transport，因此不能把该 streaming 入口称为 pure compile。独立只读复核与文件 hashes 一致。
- draft-3 仍为 `c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678`。原 Coding Plan tokenizer 200/1502、741、24 是旧 synthetic fixture 的有效观察，不是生产预算或完整 inference-equivalence 证明。`1502-741=761`、`741-24=717` 仅为 fixture 差值。
- `RuntimeAdapterPrepareInput.offer`（`packages/client/src/types.ts:222`）要求现成 task offer；`RuntimeAdapter.prepare` 的无副作用约束（`:317`）不等于已经具备完整请求 compiler。Pi 当前 `prepare` 先做准入检查，`operation.start` 才创建 MCP 配置、启动 Pi 并发送初始 prompt（`pi-adapter.ts:200,340,377,394`）。Host 需要的是更早、task-free 的独立入口。
- 首批 Main 请求从第一轮就必须覆盖 framing、合法 Summary、全部未覆盖历史、本轮输入、native system/harness 前置、实际暴露给模型的完整 tool schemas、明确授权的 home 内容。未授权 home/tool trajectory 不读取、不注入，预算贡献为 0；没有历史或 Summary 时也不能省略 runtime/tool 成本。
- 新的 preparation 能力须独立、明确宣告并绑定实际 runtime/compiler；名称与 wire 版本尚未分配。未宣告、无法纯编译或计量覆盖未知，返回 unsupported/unconfigured，不能使用 chars/4、经验 margin、事后 usage、模型别名猜测或未经证明的 upper bound。
- 保持 draft-3 两道门：新请求预算 readiness 未配置时零 input/Turn/outbox（原 receipt 优先）；已准入请求的队首准备失败时保留 input，零 Execution/dispatch。**这里的 token 是模型输入计量，不把既有 task-scoped authority nonce 当作计数证据，也不在 pre-Execution 阶段签发业务工具权限。**

### 2. P1 / P2 / P3 与最小可批准范围

**P1**：Host 是规范上下文和 Execution CAS 权威；SDK 是已认证选择、授权 tool/context snapshot、不可变 artifact 及消费绑定权威；Pi/native 是请求编译与 serializer 权威；provider 是计数语义权威。SDK 的 `mcpToolsetTools` 目前只有观察到的名字，不足以代表完整 schema，更不能代表 Pi 实际注入的 proxy/meta tools。完整 model-visible schemas 必须由正常 native tool projection 的同一实现产生。

**P2**：一致 Host snapshot → task-free 已认证 preparation → 纯 native compile 与 counter projection → 独立 counter 证据 → 保存不可变 artifact/receipt → Host 校验并短事务 CAS 创建 Execution → 原有 dispatch → native 消费同一 artifact → 最终 transport body 字节验证。任何网络计数、文件持久化或资源发现都在纯函数外，且不持有 Host PG 行锁。

**P3**：先补 native 缺失接口，再接 SDK；不把 final hook 的退出技巧、私有 deep import 或复制 serializer 变成生产实现。10 倍并发时首先承压的是远端计数调用、重复 preparation 和 artifact 容量；用显式 policy 与现有 request/receipt 幂等边界约束，不能新增第二个 Execution/job scheduler。

建议把实施拆成两个有明确停止条件的顺序边界：

| 边界 | 交付与候选源面 | 通过条件 / 停止条件 |
| --- | --- | --- |
| **B-P1：native-owned pure seam** | 在另行确认的 native 源码 checkout 中暴露纯 input compiler、provider-request preparation，以及消费冻结请求的 native 入口；与普通 launch 共用 system/tool 构造和 serializer。当前定位为 installed `dist/core/{system-prompt,agent-session,sdk}`、`pi-ai/dist/api/openai-completions` 的源码对应处；这些 installed 路径只读，不是写入 allowlist。 | 零 credential/file/session/process/tool/network side effects 的 preparation 测试；实际 mock transport body 与 D 相等；漂移在 transport 前拒绝。没有可用 native 候选就停，不在 SDK 仿制。 |
| **B-P2：SDK composition/consume** | 仅在 B-P1 可复用候选固定后实施：`packages/client/src/types.ts` 的独立 preparation 类型、`adapters/pi/pi-adapter.ts` 消费接线、`daemon/control-protocol.ts` / `create-daemon.ts` 的 task-free 已认证入口；候选新增 preparation/artifact 模块及直接测试，正式文件 allowlist 在实施契约中逐项登记。 | primitive、authenticated binding、immutable retention/idempotency 与 adapter consume 一起通过离线验收。Host CAS 接线/远程部署另属 S 边界；SDK 本地通过不能标 S C07 完成。 |

首个支持集建议固定为已选择的本机 Pi/zai/glm-5.3-flash/Coding Plan、初始 text request、显式授权 context 与完整 model-visible tool schema snapshot。effective profile/runtime/compiler 必须精确匹配；不是让 built-in catalog 覆盖已配置 Profile。任意 extension、隐式 cwd/home/skill 发现、动态工具 schema 或无法绑定的后置 writer 均明确 unsupported。真实 Main 所需工具若不能完整冻结，也须停在 unsupported，不能用四个 synthetic built-ins 冒充集成完成。多模态和后续 tool-result 轮次不在这次初始请求证明中；若产品启用要求包含这些路径，activation 继续关闭。

### 3. 纯 compile、计数和 consume 的接口语义

以下是语义分工，不是已发布的 API 名称：

1. **Pure compile / project**：输入只包含 caller 已获授权且固定的值对象、完整 schema snapshot、精确 Profile/endpoint/semantic options、native compiler fingerprint。输出 D（不可变完整 provider body 字节）、P(D)（tokenizer 所需投影字节）和 coverage manifest。函数不得读取 env/credential/home、分配 session、启动 MCP/CLI、请求网络或执行工具。缺项拒绝，不自行补齐。
2. **Count adapter**：现有 Coding Plan tokenizer 是 effectful HTTP，不能称为纯函数。真实 count 由独立、已认证、限额约束的 adapter 取得，绑定 `hash(P(D))`、model/endpoint、counter 方法/版本和 coverage。离线测试可注入 `test_fixture` counter，但结果永远不能进入 production readiness。若要求 count 本身也完全离线纯函数，当前没有已证明的 native/provider counter，必须保持 unsupported；不得自己造 tokenizer。
3. **Artifact/receipt**：保存 D、P(D) 的哈希/字节数、原始 source/context/tool/policy revision、effective target/compiler closure、counter evidence 和显式 expiry/retention policy；不含 credential、task nonce 或自报授权。内容寻址 digest 只证明完整性。读/消费权限来自现有已认证 scope/member/device/Agent 绑定。首个 SDK 接入建议本地 HMAC control unary；远程 Host 若缺 authenticated preparation transport，保持不可用，不能把现有 Agent-home receipt 的业务含义改成 preparation。
4. **Consume**：已提交 Execution 显式绑定 artifact、原输入 revision 和当前仍有效的授权。native transport 消费 D，所有影响 body 的 writer 必须在冻结前完成；之后只允许不改变 body 的 transport authentication。最终可观察的实际 body 必须等于 D；API client 若会改写或无法保证，native seam 不合格。不得重编译、重取当前 Profile/新 Summary 或覆盖 artifact 后继续启动。

纯 compile 与 effectful count/persistence 的分离不是少计 framing 的理由。设实际输入 token 为 I，计数为 N，未计入且有独立证明的上界为 U，强制输出/reasoning 上界为 O，有效窗口为 W；必须先有 `I <= N+U`，再检查 `N+U+O <= W`。两式合起来才对最坏情况充分。每个成本只算一次；任何 coverage、U、O、W 或其有效版本未知即拒绝。byte-equality 只闭合输入身份，不能单独证明 `I <= N+U`。

### 4. 幂等、并发和失败行为

- 独立 preparation request ID 绑定认证 scope 与完整 input digest；同 ID/同 digest 重放原 receipt，同 ID/不同 digest 冲突。它不是 taskId、Execution 或工具授权。超时/断线先查询原 receipt；不能悄悄发起另一个 counter 请求并掩盖计费/调用状态。
- 原 source/selection/tool/policy/compiler 任一变化，原 receipt 不能用于新输入。Host CAS 失败不创建 Execution，也不派发；未引用 artifact 按必填 retention policy 回收。
- 已引用 artifact 的 pin/retention 必须覆盖其合法消费与恢复期；不能为了节约空间提前删除。取消、超时、重启、expiry 与原 receipt 均须可观察；artifact 丢失/过期/授权撤销时拒绝消费，回到现有 Execution recovery，不创建影子任务或用新输入修补旧任务。
- 调用 byte/call/retention policy 无默认值；缺失/畸形拒绝启用。Owner 已批准可先实现 enforcement，Salesko S0 数值未冻结前仍不启用。

### 5. 必须的离线验收矩阵（本轮不伪称已执行）

| 验收面 | 原生候选必须提供的证据 |
| --- | --- |
| preparation purity | 独立拦截 fs/env-credential/session-id allocation/process/network/business-tool；编译只消费显式 synthetic 输入，所有副作用计数为 0 |
| initial request completeness | 正常 native system/context/tool projection 与 preparation 同源；中文、emoji、JSON escaping、framing、null Summary、完整历史、实际 proxy/meta schemas；未授权 home/trajectory 读取和注入均为 0 |
| consume equality | 分离 prepare/consume 调用；捕获最终 mock HTTP body 并与 D 逐字节比较；普通 launch 走同一 native serializer，零 live model generation |
| drift / integrity | D 篡改、Profile/model/endpoint、runtime closure、source/context/tool/policy 变化、缺 artifact、expiry/revocation、后置 body writer，均在 provider transport 前拒绝 |
| counter / budget | 精确 P(D) 绑定；fixture count 不能使 production ready；coverage/版本/上界缺失拒绝；等号边界通过、超一 token 拒绝；fixture 不证明 provider accounting |
| lifecycle | 同请求幂等、冲突拒绝、cancel、已持久 receipt 重启回读、并发 CAS loser 无 Execution/dispatch；持久化和计数副作用显式归入纯函数以外 |

本轮只做既有证据的 hash/算术复核，未运行新 native compiler、tokenizer、provider 或模型。已有 5-case hook spike 可复用为可行性基线，不能替代上表新的纯 API/真实工具覆盖验收。

### 6. Owner decisions — defaults locked 2026-09-14 (Building Group)

Owner has locked the four defaults below. Their original recommendation wording is retained as the decision record; it is no longer pending approval. This lock authorizes the B-P1 documentation/evidence freeze only in this work-package, not B-P2 implementation, publication or activation.

1. **Native 依赖路线与源码 ownership**：建议先在独立 native 源码 checkout 做 B-P1，产出可固定版本的正常 public export；确认可改的仓库/分支后才登记文件 allowlist。若只允许消费上游正式包，则等待具备该 seam 的版本，SDK 不绕过。
2. **首个支持集**：建议只承诺上述精确 Pi/Flash 初始 text 请求与完整授权 tool/context snapshot；不支持的 writer/动态能力 fail closed，真实 Main 缺必需 schema 时不降低验收。
3. **“纯 count”的边界**：建议批准纯 compile/project + 独立 effectful counter adapter 的语义分工；本轮及 B-P1 验收仅离线 fixture，真实计数覆盖验证需另行有界授权。若必须全离线 exact count，明确把 native/provider counter 列为先决依赖。
4. **SDK 与 Host 收口范围**：建议 B-P2 先交付本地 authenticated primitive + immutable consume 的完整离线证明；S 的远程 binding/CAS/production activation 单列后续门，仍不得宣称 C07 Main budget 闭合。数值 policy 冻结、发布和生产启用均不包含在这次批准中。

审议完成后的下一动作只应是冻结 B-P1 的源代码 owner、public seam 与测试 allowlist；现有安装包不提供该接口时，停在此方案和证据边界。


### 7. Frozen B-P1 — native public seam only (2026-09-14)

**Status: frozen documentation + evidence; blocked on missing native public API.** §6 defaults are Owner-locked (Building Group). The installed target is `@earendil-works/pi-coding-agent@0.85.1`, with bundled `@earendil-works/pi-ai@0.85.1`, for the selected `zai / glm-5.3-flash / Coding Plan` profile. This freeze does not change that profile or claim provider accounting readiness. PR #183 is already merged at `00855b57d8a22751ffd62bcc817aeffc4d9c98dd` and is outside this work-package.

**P1 — source owner.** Native Pi package maintainers own system/context/tool compilation and provider serialization. Installed package metadata identifies `earendil-works/pi`, `packages/coding-agent` and `packages/ai`; these are upstream responsibility locators, not approved writable paths. There is **no confirmed writable native checkout in this workspace, so a native file allowlist cannot yet be registered**. Installed distribution files are read-only evidence. SDK owns later authenticated composition; Host owns source snapshot and Execution CAS; provider owns token-accounting semantics.

**Public exports verified today (static reads of package export maps, declarations and implementation; no module execution):**

| Installed public surface / symbol | Observed boundary | B-P1 sufficiency |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` root: `createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionServices`, `createAgentSessionRuntime`, `AgentSessionRuntime`, `AgentSession`, `convertToLlm` | Session/runtime construction and message conversion. Export-map keys are `.`, `./rpc-entry`, `./client`, `./experimental/plugin`; the latter two use source conditions. | No standalone pure full-request compile/project plus frozen-D consume contract. Public types/hooks such as `BuildSystemPromptOptions` and `BeforeProviderRequestEvent` do not provide that contract. |
| `@earendil-works/pi-ai/api/openai-completions`: `stream`, `streamSimple`, `convertMessages` | Public via pi-ai's `./api/*` export map; these names belong to this provider subpath, not the coding-agent root. `convertMessages` produces messages only. | Streaming is effectful; conversion omits complete request/tool/options authority and frozen-D consumption. Insufficient. |
| `buildParams` | Private, unexported function in pi-ai `dist/api/openai-completions.js:581`; absent from its public declaration. | Not a public API; no deep import, extraction or SDK copy. |
| `buildSystemPrompt` | Internal module export in coding-agent `dist/core/system-prompt.js:7`; absent from root exports, and the internal subpath is not exposed by the package export map. | Not a package public API; no deep import or SDK copy. |
| Required **pure compile/project + consume frozen D** | No confirmed public export names or seam version in installed 0.85.1. Names must be assigned by the native owner in a future public release/candidate. | **Missing: stop B-P1 here.** Do not invent API names or promote hook feasibility into API acceptance. |

**P2 — concrete path.** Ordinary native launch rebuilds system/context/tool input in `dist/core/agent-session.js:738–767`; the selected zai provider selects openai-completions in pi-ai `dist/providers/zai.js:5–13`. Its streaming path resolves the credential/client before private `buildParams`, awaits `onPayload`, then sends through `client.chat.completions.create` (`dist/api/openai-completions.js:196–213`). Reading these files is not invoking the path. The retained hook spike demonstrated final-body byte equality, not a pure public compile/consume API; it was not rerun for this freeze.

**P3 — required seam and decision.** Native must expose pure compilation of explicit authorized context, complete model-visible schemas, exact target/options and compiler fingerprint into immutable full body bytes **D**, counted projection **P(D)** and coverage. Preparation has zero credential/env/file/session/process/tool/network side effects. Separate native consumption must send frozen D byte-for-byte using the **same system/tool projection and serializer as ordinary launch**, refusing integrity, target, source, context, tool, policy, runtime or later-writer drift before transport. Counter HTTP and persistence remain outside pure compilation. No hook workaround, recompile-on-consume or serializer copy is acceptable. At 10x load the previously identified counter/preparation/artifact pressure remains; this freeze adds no runtime machinery.

**Frozen allowlists and future gate:**

- Native production/test **file** allowlist: **unregistered**; no writable checkout or exact source revision is confirmed. Upstream source locators and installed `dist` paths confer no write authority.
- SDK production/test write allowlist: **`[]`**. B-P2 is not implemented; no SDK dependency change, serializer copy or new test implementation is authorized here.
- Test **scope** allowlist: exactly the six §5 matrix rows — preparation purity; initial request completeness; consume equality; drift / integrity; counter / budget; lifecycle. Execution is **gated on a future fixed public seam version**, confirmed native source owner/checkout/revision, and explicit native test/file registration. Cross-layer counter/artifact/Host cases remain acceptance obligations for their owning later slice, not permission to implement SDK/Host code during B-P1. Until then, no new matrix run and no claim that it passed.
- This freeze's documentation/evidence write allowlist is exactly `docs/researches/runtime-input-preparation-contract.md`, `_ops/c07-runtime-input-production/native-seam-blocker.md`, and `_ops/c07-runtime-input-production/source-map.json`. Only these two explicitly named, source-only ops records may be committed; other `_ops/` content stays ignored.

Evidence: `source-map.json` records the current native export maps, source hashes and freeze gate; `native-seam-blocker.md` records the stop. Existing native evidence hashes were checked rather than rerunning the spike. No live model/provider request, credential read, installed-package edit, native implementation or SDK B-P2 occurred. Documentation freeze is complete; native seam acceptance and C07 production readiness are not.

### 8. Native B-P1 source slice — authorized 2026-09-14

Owner approved the named next step: establish an isolated native checkout, pin source revision and file/test scope, then implement the shared pure compilation / frozen-consumption seam. This supersedes §7's missing-checkout stop for B-P1 only. Source: `https://github.com/earendil-works/pi.git`, tag `v0.85.1`, base `d981de1229ef899957bbe968bc8dcda02a21f477`, checkout `/Users/kito/Projects/pi-wt-c07-native-input`, branch `codex/c07-native-input`. Local file-backed plan: `plans/plan-20260914-2126-c07-native-input.md`; native repository ignores `plans/` and has no repo-harness registration. No global installation is modified.

Registered native file scope:

- `packages/coding-agent/src/core/system-prompt.ts`, new `system-prompt-renderer.ts` and `input-preparation.ts` in that directory; `packages/coding-agent/package.json` leaf export only.
- `packages/ai/src/api/openai-completions.ts`; existing `./api/*` export map exposes the provider module.
- `packages/ai/src/utils/pi-user-agent.ts`: move existing OS discovery from module import to the transport user-agent call. This directly removes the observed import-purity blocker without a second serializer.
- New `packages/coding-agent/test/input-preparation.test.ts`, `packages/coding-agent/test/input-preparation-provider.test.ts`, `packages/ai/test/openai-completions-native-input.test.ts`.

P1/P2/P3 remain as above: explicit authorized prompt/context/schema values feed the ordinary native renderer and serializer; the pure API performs no discovery. Ordinary streaming and frozen consumption share response handling. The artifact is serializable JSON, with SHA-256 integrity over its explicit body/model/input/runtime/policy/profile binding; consumption verifies a separately trusted expected digest and binding before auth/client/transport. A process-local WeakMap brand alone is insufficient because it would prevent later SDK persistence/restart. Caller authentication and lifecycle storage are still B-P2 responsibilities; hashing does not confer authority.

The exact target remains caller-resolved `zai / glm-5.3-flash / Coding Plan`. The initial checkout lacked generated provider catalog data, so tests supplied an explicit synthetic model descriptor. Subsequent restoration below supplies exact published catalog bytes for verification; it does not change that fixture or establish deployed model metadata/token accounting. No production policy values are assigned.

**Result: local native source candidate accepted; package publication/installation not performed.** Public candidate exports are `compileCodingAgentInput` in coding-agent `./input-preparation`, and async `prepareOpenAICompletionsRequest` / `consumePreparedOpenAICompletionsRequest` in pi-ai `./api/openai-completions`. Native source is uncommitted. The new source path shares the ordinary system renderer, `buildParams` and response parser. Consumption sends D as a raw string with explicit JSON content type; it never recompiles. SHA-256 covers the JSON artifact; independent expected model and input/runtime/policy/profile identities must match. Identities are caller-supplied facts, not native authentication or measurement of the actual runtime closure.

Initial evidence under native `.artifacts/c07-native-input/` (preserved; catalog blocker superseded below):

- `coding-agent-tests.log`: 37/37 tests across compiler, existing prompt behavior and cross-package integration.
- `provider-tests.log`: 11/11 tests across preparation/consume and existing retry/stop-reason regressions. Total 48/48 across six files. Isolated VM import/compile forbids process/require/fetch/clock/entropy; actual OpenAI mock transport body equals D and ordinary stream body; JSON roundtrip, tamper, drift and async mutation are covered.
- `check-final.log`: native `npm run check` stops at typecheck, exit 2. Formatting, pinned/runtime dependencies, relative imports, entry graphs and lock checks passed. Three new test typing errors in the initial run were corrected.
- `baseline-typecheck.log`: untouched base under the same installed dependencies has exactly the same 809 diagnostic lines as the final candidate, with no added or removed diagnostics. Generated catalog is absent; no catalog, provider metadata or test values were invented to make the check pass.
- `browser-smoke.log`: separate browser smoke PASS, because root check stopped before reaching it. `git diff --check` passes. `evidence.json` records final source/test/log fingerprints.

P(D) remains explicitly `coverage: unknown`, not an exact count or permission to enable Main. Explicit synthetic model/tool snapshots do not prove the deployed Profile, live model catalog or actual MCP/home discovery. The caller's injected fetch is part of the trusted transport boundary. SDK must later authenticate expected digests and source/runtime identities, own retention/revocation and bind Host CAS; those lifecycle tests are not claimed here.

**Catalog prerequisite and source acceptance closed after Owner approval.** The fixed npm release `@earendil-works/pi-ai@0.85.1` reports gitHead `d981de1229ef899957bbe968bc8dcda02a21f477`, exactly the native base. Downloaded tarball SHA-512 matches registry integrity; all 39 provider JSON files match the original manifest and source provider set, and also match the unchanged installed copies. Original manifest SHA256 `30e7f58cc33d5901dbcb64f0e00d0133620005737ffb73553b358ca23572bac8`. Only these exact bytes and manifest were copied into ignored native `packages/ai/src/providers/data/`; no regeneration, hand-authored data or live provider queries.

Native `npm run check:model-data` and full `npm run check` now both exit 0, including typecheck and browser smoke. The 809 inherited errors disappear with no source/dependency/checker changes. Nine candidate source/test hashes still match the earlier evidence, retaining 48/48 focused tests without an unnecessary rerun. Current evidence: `.artifacts/c07-native-input/catalog-acceptance/{provenance.json,model-data-check.log,native-check.log,acceptance.json}`. This is local native source acceptance, not a built/published/installed artifact or SDK lifecycle acceptance.

Next bounded work is to fix a consumable native dependency artifact and the SDK B-P2 authenticated preparation/artifact-consume implementation contract before SDK source edits. No full provider suite/build/live calls, commit/push/release or installed-runtime refresh occurred. The SDK production/test write allowlist remains `[]`; draft-3 stays unchanged. C07 Main budget stays PARTIAL, and unknown capability/accounting/upper bounds continue to fail closed.

### 9. Native local package checkpoint — 2026-09-14

Owner approved offline build/pack, external isolated installation and public export verification. Native source remains the exact nine accepted hashes on `codex/c07-native-input`, base `d981de1229ef899957bbe968bc8dcda02a21f477`; source is uncommitted. `npm run build:offline` uses the previously verified catalog without generation. Six runtime closure tarballs (chord, telemetry, ai, tui, agent-core, coding-agent) retain version label 0.85.1 and are distinguished by local paths/SHA-512 integrity, never bare registry version. Protocol/client/server are bundled build dependencies rather than installed public runtime dependencies.

Evidence root: `/Users/kito/Projects/pi-wt-c07-native-input/.artifacts/c07-native-input/package-candidate/`. `artifacts.json` fixes all six paths, SHA256/SHA512 and external consumer location. `verification.json` SHA256 `2cbf46d2e37e8a02db7d406d3ee42c5f5e1bd22c5375a1f83270a47e0d717a2a` records verification. Consumer lock SHA256 `13ece5dc6c0473c99dfe79c9c43e9596a05b323a9b206bd190945d53ca82a368`; all six selected local integrities and 2,477 installed file bytes match their tarballs. Key candidate SHA256: pi-ai `57daa2e51b35cb9137a5ad0cc9f33af7e2cca3edda6a5ac5b0f32b8d1d5c6284`; coding-agent `b40b06b3dbdf51dede5f4c0c951d8b4e499ee33e641582ce45b0f6adbbbdc189`.

**P1/P2/P3 package proof:** public coding-agent compiler -> public pi-ai prepare -> JSON roundtrip -> separately bound consume -> actual mock transport; ordinary stream sends identical body. Both module entrypoints resolve under the external consumer's node_modules, with no source alias/deep import. Native remains serializer authority; SDK will authenticate the bindings. Package hashes prevent accidentally selecting published 0.85.1 without the seam.

- PASS: build:offline; strict `npm ci --offline --ignore-scripts --omit=dev --no-audit --no-fund --userconfig=/dev/null` (128 packages); normal SDK imports; bundled/unbundled CLI `--version`; public runtime seam and API usage types (NodeNext, strict, skipLibCheck, no workspace aliases).
- PASS: prepared body equals both frozen consume and ordinary stream body: 2,185 bytes, SHA256 `174536641a17c43ffe217a40523b65f62002549d8386138e8d9297dea05e55f2`. Eight body/digest/input/runtime/policy/profile/model/endpoint rejection cases send zero additional requests. All fixture numbers are synthetic, not production budget evidence.
- BLOCKED: full consumer declaration check without skipLibCheck reports TS2307 in `@google/genai/dist/node/node.d.ts`: absent `@modelcontextprotocol/sdk/client/index.js`. This dependency issue is report-only; no source/dependency fix or full packaging acceptance claim. Narrow API typecheck does not supersede the blocked check.

Overall package result is **PARTIAL**, with fixed artifacts available for B-P2 contract review. Separate npm registry metadata/lock preparation preceded the strict offline install; this was not a zero-network task. No provider/model/tokenizer requests, real credential reads, lifecycle scripts, global install, commit/push/publication or SDK implementation. Original 48-test/native-check evidence remains source-bound; no rerun. `coverage: unknown` remains unchanged.

Next bounded milestone: register the SDK B-P2 authenticated preparation/artifact-consume contract against these exact artifact identities, including a full consumer declaration prerequisite and exact SDK file/test allowlist. Do not silently add the missing dependency, accept skipLibCheck as full dependency validation, or begin production implementation from this checkpoint. Host CAS, real runtime/schema binding, provider accounting bounds and S0 activation remain separate unresolved gates; no new budget values or draft-3 changes.

### 10. B-P2 semantic contract freeze — Owner-approved documentation boundary, 2026-09-14

**Status: semantics frozen; production implementation blocked on the gates below.** Approval of the named next milestone authorizes this section, its local source/hash evidence and the handoff update. It does not authorize dependency repair, SDK/native implementation, publication or S0 activation. This section is the single B-P2 design authority inside this research document; no second harness Plan/contract or terminal-Plan archive is created. Current SDK production/test write allowlist remains `[]`. The future file scope below is registered for implementation review, not presently writable permission.

#### 10.1 P1/P2/P3 and the observed integration gap

**P1 — owners.** Host owns canonical context and committed Execution; daemon owns authenticated local access, actual device/runtime/tool/profile resolution and durable receipt/artifact facts; native Pi owns renderer, provider serialization and its existing session/tool lifecycle. A counter owns authoritative accounting. A local control-key holder is a device operator; HMAC possession does not independently attest an arbitrary tenant, Agent, source snapshot or remote Host Execution.

**P2 — actual current path.** `daemon/control-protocol.ts:142–164` defines mutual HMAC challenge proof; `control-server.ts:409–458` dispatches post-handshake unary methods to `create-daemon.ts:3092`. Its `UnaryMethod(params)` supplies neither a per-request principal nor disconnect cancellation. New preparation handlers must resolve trusted local binding from daemon configuration/authority, and explicitly own cancellation; JSON scope fields cannot supply identity. Separately, `task-runner.ts:2276` seals `RuntimeOperationManifest`, claims, resolves the instruction and calls `prepared.operation.start` at `:2459`. `pi-adapter.ts:340–428` writes MCP config, loads five extensions, starts Pi RPC, sends `{type:'prompt', message}` and resolves the native session ID. Native `rpc-types.ts:22` and `rpc-mode.ts:394–415` accept a prompt and invoke `session.prompt`; they do not accept the new prepared request.

The §9 public consume returns a provider `AssistantMessageEventStream`. It is **not** an SDK `Session`, does not replace Pi's tool execution/session persistence, and is not wired into the above RPC path. `RuntimeOperationManifest` also has no prepared-artifact reference today. Therefore B-P1 provider-byte proof is a valid prerequisite but not proof of B-P2 execution integration. This trace corrects any earlier implication that fixing the package alone would make adapter consume ready.

**P3 — decision.** Reuse the local authenticated control channel and existing durable-write primitives for task-free preparation; preserve the native session as execution owner. Do not create an SDK provider-stream runner, construct fake session IDs, install a final-payload hook, tunnel artifact JSON through the instruction, or recompile on consume. Native must first supply an explicit supported initial-request consume bridge through its normal session/RPC lifecycle, with a complete supported tool/context snapshot. The future launch wire/manifest binding must be registered together with that bridge; absent either, consumption stays unavailable. At 10x concurrency the first pressure is counter calls and retained artifact bytes: bound both through required policy and one durable request record, not another task queue/scheduler.

#### 10.2 Fixed inputs and prerequisite gates

The exact six candidate artifacts in §9 are the **review baseline**, not a floating 0.85.1 dependency. `artifacts.json` SHA256 is `f013c5521cbafa9f1931a9084749b64a27368bf2260181316ae53c57e3ee61e8`; verification SHA256 is `2cbf46d2e37e8a02db7d406d3ee42c5f5e1bd22c5375a1f83270a47e0d717a2a`. Each local archive must match its SHA-512 before installation. Any replacement package/lock/closure invalidates affected package evidence and requires a new explicit receipt; never overwrite or relabel these artifacts as passed.

| Gate | Required fact before dependent implementation/acceptance | Current state |
| --- | --- | --- |
| G1 package declaration closure | External installation of the exact candidate closure passes full declaration checking without skipLibCheck or source aliases; any missing dependency gets native-owner diagnosis and an explicit fixed pin/provenance | BLOCKED: §9 TS2307; no repair authorized here |
| G2 native session consume | Supported native session/RPC entry consumes D while preserving real session IDs/events/tool lifecycle; actual first HTTP body equals D; post-freeze writers reject | BLOCKED: provider leaf exists; RPC prompt bridge absent |
| G3 authority and launch schema | Daemon can independently resolve device/Agent/profile/runtime/compiler/schema identity; typed committed-Execution artifact binding traverses protocol, sealed manifest and native start with registered ownership | BLOCKED: no typed artifact binding in current manifest; complete real proxy/meta schemas not proven |
| G4 production accounting/Host | Provider coverage and bounds prove admission; remote authenticated preparation and Host CAS proven; S0 numerical policy frozen | CLOSED to activation; expressly outside B-P2 local acceptance |

G1–G3 are not waived by this documentation approval. Local primitive fixtures may prove their own invariants after implementation authorization, but cannot satisfy these gates by supplying synthetic identities. G4 must stay false for any fixture counter or unknown coverage.

#### 10.3 Frozen local primitive semantics

Names below describe contract operations; exported symbol/wire names must be assigned once in the implementation registration, with one strict schema/version and no alternate shapes.

1. **Prepare / lookup / cancel.** A request includes a separate preparation requestId, exact canonical source revision/digest, explicit authorized prompt/context and complete model-visible schemas, exact selection/profile/options and required policy revision. HMAC is checked before handling. A configured authority resolver checks all claimed scope values against its trusted local device/Agent/Profile records and authorizes disclosure; unavailable authority rejects. It derives runtime/compiler identity from verified actual artifact closure, never caller text or version label alone. No task/claim/Execution/nonce is created.
2. **Pure portion.** Pass resolved immutable data to public native compile/prepare. No home discovery, CLI/session/MCP startup, business tool calls, credentials or network in this portion. Frozen output consists of D, P(D), lengths/digests, native format/compiler identity and explicit coverage. Unknown/unsupported input rejects rather than filling gaps. Caller input is copied before async work and cannot mutate retained artifacts.
3. **Counter boundary.** A separately authorized adapter consumes only bound P(D), target and explicit call/timeout policy. It returns method/version, count and coverage proof; this interface performs no live calls in B-P2 tests. Fixture results are marked test-only and cannot produce a production-ready receipt. No chars/4, heuristic padding, cached count from another projection or inference usage substitutes for an authoritative bound.
4. **Receipt authority.** Store immutable D/P(D) and scope/source/target/runtime/tool/policy binding plus counter evidence and expiry. Return a scoped reference and readiness reasons, not raw credential/home data. SHA proves content identity; local authenticated storage and fresh authorization grant lookup/consume rights. A reference/digest is not a bearer authorization token. Unsupported counting can return explicit not-ready evidence; it cannot admit an Execution.
5. **Idempotency and uncertainty.** One durable namespace is `(authenticated device/operator scope, Agent, preparation requestId)`, bound to the entire normalized request digest. Same key/digest returns the existing receipt or pending fact; a different digest conflicts. Reserve before counter invocation; persist result before success response. Disconnect is not cancellation because current unary dispatch has no disconnect signal. Explicit cancel/deadline updates the same durable record and aborts the owned counter when possible. An interrupted/unknown counter outcome stays observable and is never automatically repeated under the same request. A new requestId requires a caller decision and consumes policy allowance. Restart returns persisted facts; no fabricated success or second task state machine.
6. **Limits and retention.** Require explicit byte, per-scope aggregate byte, in-flight/call, deadline/wait and retention policy with no defaults. Validate finite safe integers/relations before enablement; fixture values are not S0 values. Persist enough usage/idempotency facts across restart to prevent counter-limit or duplicate-call bypass. Artifact and tombstone retention must cover the advertised retry horizon; an expired key cannot silently become a fresh call inside that horizon. Existing transport frame limits also apply; exceeding them rejects, not implicit chunking or policy enlargement.
7. **Pin / consumption obligations.** Only an independently validated committed Execution may bind/pin an artifact; a control client cannot submit a synthetic Execution ID as authority. Pin must precede dispatchability and include task/attempt/source identity. Reference, authorization, runtime closure, schema/profile/policy revision, expiry and counter readiness are revalidated before start; revocation always rejects, even when pinned. Native receives immutable D and independently trusted expected bindings; actual send bytes equal D. Retrying an existing Execution follows its recovery authority and preserves the same artifact, not a replacement input. A pin is a reference/retention fact, not a second Execution scheduler or proof of provider exactly-once execution.
8. **Failure/recovery.** Missing/corrupt/expired artifact, pin/CAS race, runtime/selection/schema drift or revoked scope yields a typed pre-transport rejection and existing recovery. Durable-write ambiguity is an error until record integrity is revalidated; reuse `util/atomic-write.ts` / `util/durable-jsonl.ts` semantics instead of treating rename alone as durability. GC cannot remove a pinned artifact; terminal release uses trusted execution recovery evidence, with explicit retention horizon. No automatic unpin merely because a timeout or socket disconnect occurred.

Worst-case admission remains: prove `I <= N + U` and enforce `N + U + O <= W`, hence `I + O <= W`. Unknown I-coverage, U, O, W or authority/version prevents readiness; byte equality proves which input is counted, not the inequality. Equality passes and exceeding the window by one token rejects, with each cost counted once.

#### 10.4 Exact prospective SDK local file/test scope

This is the local primitive implementation allowlist **proposal fixed for review**. It becomes an actual write allowlist only in the authorized implementation contract after gate resolution; current production/test authorization remains `[]`. The implementation must not silently grow these paths. Existing durable/auth infrastructure is reused read-only unless an observed blocker is separately registered.

| Owner/responsibility | Exact existing or proposed new paths |
| --- | --- |
| SDK preparation types/public export | `packages/client/src/input-preparation.ts` (new); `packages/client/src/index.ts`; `api-surface/client.d.ts` (generated public projection only) |
| SDK binding, request/receipt persistence and policy | `packages/client/src/daemon/input-preparation-service.ts` (new); `packages/client/src/daemon/input-preparation-store.ts` (new) |
| SDK local control parsing/configuration | `packages/client/src/daemon/control-protocol.ts`; `packages/client/src/daemon/create-daemon.ts`; `packages/client/src/bin/control-client.ts` |
| SDK native public package composition | `packages/client/src/adapters/pi/input-preparation.ts` (new); `packages/client/package.json`; `bun.lock` (only reviewed exact candidate dependency closure; local absolute paths must not enter a published package) |
| Direct new offline tests | `packages/client/src/__tests__/input-preparation.test.ts`; `packages/client/src/__tests__/input-preparation-store.test.ts`; `packages/client/src/__tests__/input-preparation-control.test.ts`; `packages/client/src/__tests__/pi-input-preparation.test.ts` |
| Existing impacted regression tests | `packages/client/src/__tests__/control-protocol.test.ts`; `packages/client/src/__tests__/control-client.test.ts`; `packages/client/src/__tests__/control-server.test.ts`; `packages/client/src/__tests__/daemon-control-socket.test.ts` |

Full Execution integration is **not hidden inside this local scope**. Its observed entrypoints are `packages/client/src/types.ts` (manifest/start), `packages/client/src/daemon/task-runner.ts`, `packages/client/src/adapters/pi/pi-adapter.ts`, `packages/client/src/adapters/pi/rpc-client.ts`, native session/RPC and the protocol/Host offer producers. Their write/test allowlists remain unregistered until G2/G3 fix the actual wire/schema and native ownership. No placeholder protocol, opaque instruction envelope or permissive manifest field may be added to evade that registration. Local primitive completion cannot be called full B-P2 completion.

#### 10.5 Acceptance and stop conditions

| Test family | Mandatory observable result |
| --- | --- |
| Auth/isolation | Unauthenticated calls never reach compile/store/counter; wrong device/Agent/source or forged resolver identity rejects; lookup/cancel cannot cross scope |
| Completeness/purity | Authorized full schemas and text snapshot are compiled; missing real schema unsupported; pure-stage fs/env/session/process/tool/network traps untouched; no task/nonce/Execution creation |
| Artifact equality/drift | Persistence/restart roundtrip preserves D; mutation and all binding drifts reject before mock transport; frozen consume and ordinary native first request are byte-equal |
| Durability/idempotency | Concurrent duplicates reserve/call once; conflicting digest rejects; lost response rereads receipt; write/sync faults, cancel and interrupted counter do not create false success or automatic second call |
| Policy/count | Missing limits refuse enablement; byte/call/retention enforcement survives restart; unknown/fixture coverage never ready; proved equality boundary passes, one-token overflow rejects |
| Execution/GC | After G2/G3: real existing Session lifecycle owns consume, CAS loser causes no dispatch, only committed binding pins, GC/pin races cannot delete a live artifact, cancel/restart follow existing recovery |

Implementation verification must use actual package commands: focused named `@byok-sdk/client` Vitest files, then repository required build/typecheck/test/API-surface/version-authority/workflow checks; no live provider suites. Full external consumer declaration check is an additional G1 gate. Native/provider test reruns are source/closure-bound and only repeated when their subject changes. This documentation turn performs only source/hash/whitespace checks; no test row above is claimed executed. Existing unrelated missing context metadata and historical Plan-count state are report-only, not tasks in this freeze.

**Task Breakdown for this documentation boundary:** [x] re-read authority and fixed candidates; [x] trace local authentication and real launch; [x] freeze semantics, prerequisite gates and exact prospective local file/test scope; [x] retain full Execution integration registration gap; [x] source/hash evidence and handoff. No production Plan has entered Executing.

**Next bottleneck:** obtain a native-owner design/contract for an initial-request consume bridge through the current Pi Session/RPC path, including the fixed complete tool/context snapshot. Bound the work to G2/G3 design and an exact source/test allowlist; no implementation or live model run follows automatically. G1 declaration closure remains a separate required prerequisite and must be retained in that review.

### 11. Native Session/RPC initial consume — frozen interface design, 2026-09-14

Owner approved this bounded design milestone following §10. This section assigns the native interface and prospective source/test scope. It authorizes no native/SDK code changes, provider/model calls, dependency repair, commit or release. The nine existing native candidate files and six §9 tarballs remain unchanged. G2 now has a concrete design; it is not a passed gate. G1/G3/G4 remain as in §10.

#### 11.1 P1/P2/P3: use the existing session and loop

**P1.** `AgentSession` owns prompt preflight, active tool registry, event persistence and settlement; agent-core owns the running loop and tool execution; `ModelRuntime` owns credential/transport resolution; pi-ai owns frozen body validation and consumption. SDK supplies independently trusted expected identities over its owned child-process pipe. Neither native RPC request IDs nor artifact hashes authenticate a Host Execution.

**P2.** Native `rpc-mode.ts:394` calls `session.prompt`. `agent-session.ts:1159–1329` can run slash commands, transform input, expand templates/skills, inject pending messages, resolve auth, compact and execute before-agent-start handlers. `_runAgentPrompt:1105` calls `agent.prompt`, then may retry/compact/continue. `agent-loop.ts:288–313` transforms context, converts messages, constructs full Context, resolves API key and calls the stream function; the same loop then executes returned tool calls and emits ordinary lifecycle events. `sdk.ts:314–366` adds current retry/timeout settings and provider/context hooks. `model-runtime.ts:573–610` may replace baseUrl from auth and merge env/headers. Those are real mutation/auth boundaries, not equivalent to the direct provider fixture in §9.

**P3.** Add an explicit prepared-input admission path on `AgentSession`, using the same agent run lifecycle, tools, events, session manager and abort machinery. Pass an immutable **run-scoped first-request override** into the existing loop; do not mutate `agent.streamFunction` globally or replace the session with a stream wrapper. On that first request the loop compares its actual full Context to the frozen native Context before credential resolution and transport, then uses pi-ai's existing frozen consume. This is a comparison, not a second provider serialization: it must never build a new D or substitute input. Ordinary prompt behavior remains its separate existing entrypoint; prepared requests never fall back to it on failure.

#### 11.2 Public interface and RPC contract

The following names and meanings are fixed for the future native implementation. They are not exports present in §9 packages.

| Surface | Frozen signature/shape and ownership |
| --- | --- |
| Pure `prepareCodingAgentSessionInput` in coding-agent `./input-preparation` | Explicit `CodingAgentInputSnapshot`, exact model/options/native binding and a model-visible tool manifest -> Promise of `PreparedSessionInputV1`. Uses existing compiler/provider preparation once; no resource loading, session allocation, auth or network |
| `PreparedSessionInputV1` | One strict JSON shape: `format: "pi.session.prepared-input"`, `version: 1`, `snapshot`, `context`, `providerRequest`, `toolManifest`, `digest`. `context` is the native compiler's deterministic projection, `providerRequest` contains D/P(D); the digest binds all fields except itself. No raw credential, function, path-to-be-read or task nonce. Keep the original low-level B-P1 request format unchanged |
| `PreparedSessionExpectedV1` | Independent `digest`, exact model and existing native binding (`inputIdentity`, `runtimeIdentity`, `policyIdentity`, `profileRevision`), plus exact tool-executor manifest digest. The trusted SDK caller supplies these from authenticated durable facts. Values inside the artifact cannot serve as their own expectations |
| `AgentSession.promptPrepared(input, expected)` | Promise of normal run completion, with native-owned accepted/rejected preflight callback for RPC integration. Reject unsupported/busy/replayed invocation; never queue a prepared request. Admission success is not run completion |
| RPC command | `{id, type: "prompt_prepared", input, expected}` with strict required fields, nonempty id and exact version. No `message`, images, streamingBehavior, file URI or compatibility variants. Unknown fields fail before admission |
| RPC response | Existing `{id,type:"response",command:"prompt_prepared",success,...}` family, exactly one preflight response. Success data binds `{sessionId, preparedDigest}` to the real SessionManager identity; failure includes a stable error code. Normal native events and `get_state` report execution/settlement; RPC success does not imply provider success, completed tools, durable Host outcome or exactly-once generation |

The envelope's snapshot/context/body representations have one authoring source: native pure preparation. Caller editing any projection invalidates the independently retained digest. The native session does not parse D back into transcript or tool definitions. ToolManifest binds model-visible schema/order and executable tool identity separately; schema equality alone does not prove the same executable closure or permission scope. Unknown executor/source identity rejects; no hash of Function.toString or tool-name guessing.

Preparation accepts caller-authorized values only. Consume/session construction occurs after committed Execution authority exists at the SDK boundary; native cannot establish that commitment itself. RPC must run on the SDK-owned child pipe with closure verification; exposing this command over a generic unauthenticated socket is prohibited.

#### 11.3 Snapshot, startup and writer constraints

1. Add a native internal projection from the same resolved registry/resource data used by `_rebuildSystemPrompt` and `_buildRuntime`. It includes ordered active tools, full schemas/descriptions, normalized snippets/guidelines, custom/append prompt, formatted skills, context files, docs paths, cwd, explicit history/current user message and exact effective options. `getAllTools()` omits prompt snippets and constrained-sampling details; SDK must not assemble a snapshot from that method. Unsupported constrained/multimodal/custom messages reject at this first support set.
2. Prepared admission requires an idle native session with no queued steer/follow-up/nextTurn/custom/bash input, active compaction/retry or prior live trajectory. An explicitly supplied canonical history prefix may be installed once through the existing SessionManager/Agent message path as a deterministic projection, with exact snapshot equality; no arbitrary resume-session history merge. The final user message is explicit and appended once. Timestamps are taken from the snapshot, not regenerated to alter its identity.
3. Prepared-mode session construction requires explicit settings, resolved model/runtime, SessionManager and an authorized immutable resource/tool snapshot. Use native `createPreparedAgentSession` through the coding-agent root export, delegating normal execution construction to the existing SDK factory after validating these required inputs. It must not default to `DefaultResourceLoader.reload`, `SettingsManager.create`, `ModelRuntime.create` or implicit home discovery. This factory is effectful session construction, **not** pre-Execution preparation. Existing default CLI startup is not eligible merely because it later accepts `prompt_prepared`; no `main.ts` shortcut or new bootstrap protocol is included here.
4. For this initial support set, reject loaded unregistered extensions and all input/context/before-agent-start/provider-payload/header transformation hooks, slash/template expansion, auto-compaction and application-level auto-retry. Do not run them and compare afterwards: hooks can execute side effects and their ordinary exception handling can continue. Default ordinary Pi behavior is not changed; this is eligibility validation for the explicitly declared prepared mode. A real SDK launch currently loads five extensions, so it remains unsupported until their full snapshot/executor/writer closure is explicitly registered. A zero-tool or synthetic built-in fixture cannot establish Salesko Main readiness.
5. Freeze body-affecting options in D. `ModelRuntime` performs transport-only auth resolution after first-request identity checks; an auth-resolved endpoint different from the independently expected endpoint rejects before network. Do not invoke ordinary `prepareRequest/streamSimple` to silently alter the model/env/body. Only explicitly permitted transport headers, credentials, timeout, abort and bounded retries may cross into the existing pi-ai consume; no env semantic writers. HTTP retry policy is explicit and not an exactly-once guarantee.
6. `AgentSession.agent` exposes mutable state. A setter revision alone cannot prove immutability. Immediately before the first stream, compare actual ordered system/messages/full schemas/options/model and executable registry binding to the trusted frozen Context/manifest; strict data copy prevents async mutation. Repeat the binding/registry comparison after async auth and before provider transport, and let the existing loop execute the same captured tool bindings. Hold an operation-local reservation while verifying and dispatching. Mutators/queued RPC calls that would affect the current input must reject during this reservation. Release on all preflight failures/abort/settlement; no process-global frozen artifact slot. The consume path compares the native Context projection and verifies the previously prepared D; it does not serialize a replacement D. A separate ordinary-session mock test establishes serializer equivalence.

#### 11.4 Run and failure semantics

The new agent-core input is an optional run-scoped `initialRequest` object containing frozen Context, a first-request validator and a stream thunk supplied by native coding-agent. It is captured by the existing `runAgentLoop` invocation, not attached to mutable provider-global state. This protects the cross-package identity invariant; it creates neither an extra agent loop nor a second execution scheduler.

For the first provider invocation, prohibit context writers, validate the actual Context/executor binding and cancellation, then resolve auth and invoke the existing frozen consume with D and independent expectations. Validation failures emit one preflight failure if not yet accepted; after acceptance they follow normal native failure/settlement events. No second success/failure RPC response is emitted after the preflight response. Admission must finish deterministic checks and reserve the real session before reporting success; late authority/transport errors remain observable through lifecycle events. No provider transport or business tool runs for a preflight rejection. Native initialization/persistence is effectful and is not claimed to leave zero filesystem changes.

Ordinary response parsing, tools, transcript append, sessionId, abort and settlement remain native-owned. The override applies to the first provider invocation of this admitted run only. It must not replay D for tool-result rounds, queued prompts, recovery, auto-retry or subsequent RPC input. Later model invocations retain their existing native path and **require their own SDK/Host budget authority before production activation**; this first-request design gives them no budget permission. Offline tests block external network and may exercise later rounds only with explicit synthetic authority. This limitation keeps G4 closed; do not advertise whole-run budget sufficiency.

Within one live Session, a repeated `prompt_prepared` request must not dispatch twice: reserve the accepted digest/run identity and reject duplicate admission, including a changed RPC id. Reject busy requests rather than queueing or replacing the active artifact. After restart, native-only state does not prove whether a provider effect happened; SDK's durable Execution/artifact receipt owns retry reconciliation. Do not add a native durable job table or promise exactly-once inference.

#### 11.5 Prospective native ownership and verification

These are exact proposed write paths for the subsequent native implementation contract. Current turn writes documentation/evidence only. Use the existing checkout/branch/base from §8 and preserve its nine prior WIP files. Overlapping files transfer ownership sequentially; no concurrent writers.

| Responsibility | Native relative paths |
| --- | --- |
| Pure session envelope and shared snapshot projection | `packages/coding-agent/src/core/input-preparation.ts`; new `packages/coding-agent/src/core/prepared-session-input.ts`; `packages/coding-agent/src/core/system-prompt.ts` (share projection only) |
| Session admission, explicit construction and transport | `packages/coding-agent/src/core/agent-session.ts`; `packages/coding-agent/src/core/sdk.ts`; `packages/coding-agent/src/core/model-runtime.ts`; `packages/coding-agent/src/index.ts` |
| Existing loop run-scoped initial request | `packages/agent/src/types.ts`; `packages/agent/src/agent.ts`; `packages/agent/src/agent-loop.ts` |
| RPC strict command/response dispatch | `packages/coding-agent/src/modes/rpc/rpc-types.ts`; `packages/coding-agent/src/modes/rpc/rpc-mode.ts` |
| New focused offline tests | `packages/coding-agent/test/prepared-session-input.test.ts`; `packages/coding-agent/test/rpc-prepared-input.test.ts`; `packages/agent/test/initial-request.test.ts` |
| Existing directly affected regression tests | `packages/coding-agent/test/input-preparation.test.ts`; `packages/coding-agent/test/input-preparation-provider.test.ts`; `packages/coding-agent/test/rpc-prompt-response-semantics.test.ts` |

Existing pi-ai consume, tool execution wrappers, SessionManager persistence, resource loader, default CLI, provider catalog and extension packages are read-only reuse surfaces. If implementation cannot preserve the contract without changing them, record the concrete dependency and revise this scope before editing. G1 dependency repair has its own scope; no package/lock edits are smuggled into this table. This design chooses a native factory/RPC boundary, not a new SDK launcher or wire artifact format; SDK/Host launch integration remains G3.

Required new offline proof: full Session -> RPC -> original loop -> mocked OpenAI transport D equality; ordinary eligible-session first body equality; actual session IDs/events/transcript and one RPC response; exact active schema/executor mapping; Context/registry/endpoint/options drift rejected; duplicate/busy/abort and cleanup; disallowed writers never invoked; mutation during async auth rejected; fixture tool executes via native loop, subsequent model request never reuses D. Pure envelope tests forbid fs/env/session/process/network. Use existing session test utilities/faux provider for lifecycle regressions and an explicit zai descriptor plus injected mock HTTP for provider bytes, never live APIs. No claims from direct leaf-stream tests alone.

Before implementation acceptance: native `npm run check`, the exact listed focused tests, then authorized offline build/pack and external full declaration/runtime verification against newly hashed candidate artifacts. Do not rerun unchanged expensive evidence or repack §9 originals. G1 must be resolved for a fully consumable package; G3/G4 stay separate. This design turn runs none of those future tests.

**Task Breakdown:** [x] trace native session/loop/options writers; [x] freeze envelope, public factory/method and RPC shapes; [x] identify snapshot/executor authority and unsupported extensions; [x] register exact prospective native source/test scope; [x] record hashes and handoff. Design complete; implementation and readiness unclaimed.

**Next bounded prerequisite:** diagnose and close G1's missing MCP declaration dependency in the isolated external consumer using the fixed artifacts, with exact native-owner dependency scope before any repair. This is the known failing package gate and can be handled without launching a model or implementing the bridge. After G1 closes, the §11 implementation scope is concrete for approval; SDK launch and production activation remain separate.

### 12. G1 declaration dependency diagnosis — confirmed, 2026-09-14

Owner approved diagnosis and determination of the smallest repair scope. This turn changes only disposable consumer state, local evidence, this document and handoff. Original native source, six candidate tarballs and original consumer lock remain unchanged; no production dependency repair or bridge implementation is inferred from the diagnostic result.

**P1 — dependency ownership.** `packages/ai/package.json` directly pins `@google/genai@1.52.0`, but has no MCP dependency. Genai's published `package.json:166–172` declares `@modelcontextprotocol/sdk: ^1.25.2` as an optional peer. Its published `dist/node/node.d.ts:3` nevertheless unconditionally imports `Client` from `@modelcontextprotocol/sdk/client/index.js`; `mcpToTool` exposes that type. The optional installation contract and unconditional declaration dependency are inconsistent for full consumer typechecking. This is not caused by C07 request serialization.

**P2 — concrete failure path.** Public Pi preparation types reach pi-ai `types.d.ts` -> `api/google-generative-ai.d.ts` -> `api/google-shared.d.ts` -> `@google/genai` node declarations -> missing MCP client declaration. Even an OpenAI/Zai consumer resolves this shared declaration graph. Node import/mock transport can succeed because the failing import is type-only. Native `tsconfig.base.json:9` sets `skipLibCheck: true`, explaining why root `npm run check` passes while the external check without that flag fails. The coding-agent shrinkwrap also lists the optional peer but does not install it; adding only a dev dependency or changing the test flag cannot repair published consumer closure.

**Causal proof.** Original §9 TS2307 evidence was retained. A new external temporary consumer copied the exact package/lock and installed modules; only diagnostic manifest paths were canonicalized and direct `@modelcontextprotocol/sdk@1.30.0` added. This exact version is already pinned in the SDK branch's bun.lock and satisfies Genai's peer range; it was not selected from a floating latest tag. `npm install --offline --ignore-scripts --save-exact` completed after separately caching the missing fixed `zod-4.6.5.tgz` registry artifact. It added 86 dependency lock entries, changed zero existing dependency versions, and retained all six candidate integrity hashes plus byte-identical Genai declarations. The same public API fixture then passed strict NodeNext full declaration checking with explicit `--skipLibCheck false`, exit 0. No stubs, suppression, source aliases or declaration edits.

Evidence root: native `.artifacts/c07-native-input/g1-diagnosis/`. `diagnosis.json` SHA256 `351df6d3e4f36e24331a238539357ed1e573bb16a92e572558a566d2de6825d1` records intervention, exact MCP lock integrity, added dependencies, logs and consumer path. `variant-package{,-lock}.json` preserves the differential fixture. Original consumer lock still SHA256 `13ece5dc6c0473c99dfe79c9c43e9596a05b323a9b206bd190945d53ca82a368`. Initial ENOTCACHED failure is retained; final install was offline, while cache preparation used npm registry. Provider/model/tokenizer calls and real credential reads: zero.

**P3 — minimal native repair proposal.** The upstream Genai declaration/optional-peer boundary is the originating defect. For a self-contained Pi candidate at the fixed Genai version, `packages/ai/package.json` should declare the real MCP package as an exact production dependency; pi-ai is the immediate owner of the exposed dependency graph. Do not push this requirement onto Salesko or add it only to the diagnostic consumer. Proposed pin is `@modelcontextprotocol/sdk: 1.30.0`, subject to the exact transitive lock/lifecycle review. The observed cost is 86 additional lock entries in the isolated consumer; no claim that the package is cost-free. Avoid wider provider-type refactors, copied MCP declarations or skipLibCheck as a product fix.

Proposed repair ownership/file scope is exactly native `packages/ai/package.json`, root `package-lock.json`, generated `packages/coding-agent/npm-shrinkwrap.json`, and `scripts/coding-agent-consumer.mjs` to add a full public-declaration regression check to the existing external packaging smoke. Reuse existing compiler tooling; no new benchmark or CI authority. Inspect added lifecycle-script flags against the existing shrinkwrap allowlist; an unapproved script rejects rather than widening the allowlist. Do not hand-edit generated shrinkwrap or replace original §9 artifacts.

Acceptance for that later repair: install/lock with ignore-scripts; existing shrinkwrap generation/check, native `npm run check`, package with a new artifact directory, and external full declaration/runtime smoke. Candidate pi-ai and coding-agent dependency closure must install without the consumer's diagnostic direct MCP dependency. Standalone pi-ai public declarations must also resolve. Retain exact integrity/version graph and byte-equality evidence; no live model suite. This diagnosis authorizes none of those production edits or rebuilds by itself.

Diagnosis complete; G1 remains **unfixed on the original candidate**, with a demonstrated repair and exact scope. Next bounded slice is the above native dependency/packaging repair and its full external-consumer acceptance. G2 bridge implementation and G3/G4 remain separate.

### 13. G1 dependency repair implemented; full package gate PARTIAL — 2026-09-14

Owner approved §12's repair. Native pi-ai now directly depends on exact `@modelcontextprotocol/sdk@1.30.0`; root lock and generated coding-agent shrinkwrap reflect it. Dependency review: 78 added root lock entries, zero removed entries, zero existing version changes and zero newly introduced install scripts; existing lifecycle allowlists remain unchanged. The original diagnostic consumer had 86 additions because its prior closure differed from the native root. Neither number is a token budget.

The first native check exposed a required generated projection omitted from the four-file scope: `packages/coding-agent/install-lock/package-lock.json`. It was explicitly recorded and regenerated with the existing generator as the sole directly blocking scope addition. Its companion package.json stayed byte-identical. No generator/checker policy was changed. Native `npm run check` passes, including shrinkwrap/installer consistency, typecheck and browser smoke; offline build passes.

`scripts/coding-agent-consumer.mjs` now runs full external public root declaration checks with strict NodeNext, resolveJsonModule for actual catalog JSON imports, and skipLibCheck=false. The regression rejected the original candidate with the exact missing-MCP TS2307. Two new archives were produced in native `.artifacts/c07-native-input/g1-repair/tarballs/`; four unchanged closure archives are reused from §9. New pi-ai SHA256 `66dd3e4a3e1e59834c7d4df8e0d3eec86a0fe240f846f6a9db0cb548f9f6acaa`; coding-agent SHA256 `c137bc9b339b387e0e981292d6a411be843df595fd7aeca6386b58e83a26db7b`. Original six archives and original nine native source/test hashes remain unchanged.

Two fresh external consumers installed offline with scripts disabled and **no direct consumer MCP dependency**. Standalone pi-ai full root declarations PASS. Coding-agent resolves the repaired MCP chain but its broader root check exposes **TS2694: path has no exported member PlatformPath**, in `dist/core/tools/find.d.ts`. Initial TS2732 catalog errors were corrected by enabling JSON module resolution in the test command, not suppressing checking. **Correction from §14:** the retained final log also contains 39 TS1543 JSON import attribute errors; the earlier statement that PlatformPath was the only error was inaccurate. The strict smoke remains failing. Original logs and verification receipts are preserved as historical evidence, not relabeled PASS.

Packaged preparation/consume mock test PASS: same 2,185-byte D as before, eight drift/tamper rejects, zero live provider calls. Bundled CLI --version PASS. All 2,477 installed candidate files match tarball bytes. These passing checks do not supersede the failing full root declaration gate. Native source-only focused tests were not redundantly rerun; new package behavior was checked directly.

Evidence: native `.artifacts/c07-native-input/g1-repair/{artifacts.json,verification.json,lock-review.json,consumer-results.json}` and retained logs. verification.json SHA256 `5c37cb86b26931663dddbb6cc54a468bd06dbe0146046157f9f56f36e9a4b04f`. This turn's dependency installs/build/package verification were offline; no provider/model/tokenizer calls, credential reads, commit/push, publication, global refresh or SDK implementation. Draft-3 hash remains c7288bdb…c6678.

**Stop:** original MCP dependency defect is fixed in local candidates, but G1 full package acceptance remains PARTIAL. The single direct scope extension was used for the mandatory installer lock; the separately surfaced PlatformPath issue is report-only. Next bounded work is diagnosis/repair registration for that generated declaration in `packages/coding-agent/src/core/tools/find.ts` and its installed Node type surface, then rerun only affected package checks. No bridge implementation or activation follows from these partial results.

### 14. G1 PlatformPath diagnosis and minimal repair registration — 2026-09-14

Owner approved diagnosis and repair registration only. Production `find.ts`, dependencies and all existing candidate archives remain unchanged. The isolated proof uses local installed compiler/types, extracted source and synthetic paths; no provider/model/tokenizer calls, tool execution, installation or package rebuild.

**P1 — ownership.** Native coding-agent owns the exported `relativizeFindResultPath` parameter type. Producer `@types/node@22.19.19` defines `path.PlatformPath`; the installed external consumer's `@types/node@26.5.1` does not. This is an exposed declaration dependency on an absent type name, independent of the repaired MCP dependency.

**P2 — failure path.** `packages/coding-agent/src/core/tools/find.ts:14–18` annotates `pathModule` with `path.PlatformPath`; emitted `dist/core/tools/find.d.ts:7` preserves that name. Full public root checking in the external consumer resolves its Node declarations and fails TS2694 before application execution. The function only consumes `sep`, `isAbsolute` and `relative`. Existing path behavior regression cases live in `packages/coding-agent/test/suite/regressions/6104-find-root-relativization.test.ts`.

**P3 — minimal candidate.** Replace only the parameter annotation with `Pick<typeof path, "sep" | "isAbsolute" | "relative">`. This states the actual required operations without copying Node declarations, pinning consumers to old Node types or adding runtime compatibility logic. Existing `path.posix` and `path.win32` remain valid; missing required operations reject. The tradeoff is a deliberately structural public parameter surface. There is no new runtime allocation or scaling pressure from this type-only change; broader C07 counter/retention limits remain separate.

| Isolated fixture | Node 22 declarations | Node 26 declarations |
| --- | --- | --- |
| Exact original function/type | PASS | FAIL TS2694 |
| Same function, proposed annotation only | PASS | PASS |

Both type environments use strict NodeNext with skipLibCheck=false. Positive POSIX/Windows calls and a negative missing-operations type case are included. Original and candidate emitted JavaScript are byte-identical under the producer compiler. Four pure POSIX/Windows runtime assertions pass. These are diagnostic fixtures, not full package acceptance or production source tests.

Evidence: native `.artifacts/c07-native-input/g1-path-diagnosis/diagnosis.json`, SHA256 `a1bd958d3407d7de3af04fcbb64f46bb982abdaeb6e711cfc86ef19bc3fb46d9`; `probe.py` and retained compiler/runtime logs are alongside it. Original `find.ts` SHA256 is `b06bcae6821a0e9fda1b63be613a7ce28eb0e66e1d01d16564e59e83f9ce10ea`. The source is not patched by this proof.

**Error inventory correction / separate boundary.** Re-reading the unchanged §13 `coding-agent-full-types.log` (SHA256 `af375fff64d59f3a5c07d45e3618474f22f991fdfa84ab02d13dfe95e238a60c`) gives exactly 39 TS1543 and one TS2694. Example: source `packages/ai/src/providers/zai.models.ts:4` imports JSON with `{ type: "json" }`; its emitted declaration imports the same JSON without that attribute. This is an observed source/declaration difference, not a diagnosed generator/compiler cause. No JSON generator, compiler policy, declaration or test suppression is changed here. The prior §13 receipt's abbreviated PlatformPath-only description is incomplete; this new record corrects it without overwriting the receipt or logs.

**Registered next repair scope (not applied).** One production file: `packages/coding-agent/src/core/tools/find.ts`, parameter annotation only. Reuse the existing pure path regression file and external declaration checker (`scripts/coding-agent-consumer.mjs`) unchanged; no new test authority. After implementation authorization, run those focused path regressions and required native check; any package proof must use new artifacts and retain originals. Success for this slice means TS2694 eliminated with unchanged runtime behavior. Full G1 still cannot pass while TS1543 remains; that separate issue needs its own diagnosis before repair. No SDK/Session bridge implementation or production activation is implied.

Task Breakdown: [x] producer/consumer trace; [x] before/after isolated proof; [x] corrected full log inventory; [x] exact one-file prospective repair registration; [x] research/handoff update. Diagnosis milestone complete; implementation and G1 acceptance remain open.

### 15. G1 PlatformPath source repair verified — 2026-09-15

Owner approved the registered one-file repair. Native `packages/coding-agent/src/core/tools/find.ts:17` now uses `Pick<typeof path, "sep" | "isAbsolute" | "relative">` for the `pathModule` parameter. This is the only production change in this slice; no dependency, runtime logic, regression test or checker policy was changed. P1/P2/P3 remain §14's traced declaration ownership and minimal structural type decision.

Verification completed once after the source edit:

- Existing `test/suite/regressions/6104-find-root-relativization.test.ts`: 11/11 PASS, including real source imports and custom-glob tool execution without filesystem search or provider calls.
- Native `npm run check`: PASS, including native typecheck, shrinkwrap/installer consistency and browser smoke. Biome reported no fixes; hashes of all pre-check tracked/untracked source files stayed unchanged.
- Existing package `tsconfig.build.json` with `tsgo --emitDeclarationOnly --outDir <fresh-temp>`: PASS. No production dist rewrite or package build/pack/install. The emitted `find.d.ts` contains the approved structural type and no PlatformPath reference.
- Fresh copy of the fixed §13 external consumer, replacing only `find.d.ts` with that compiler-generated declaration: existing `checkConsumerDeclarations` with strict NodeNext/skipLibCheck=false reports **zero TS2694 and exactly 39 TS1543**, with no other TypeScript diagnostics. This differential declaration check is not acceptance of a newly packaged archive; original consumer and candidate tarballs remain unchanged.

The exact current function bytes equal the previously proven §14 after-fixture, retaining its Node 22/26 type and emitted-JavaScript equality evidence without repeating the matrix. Original six and MCP-repaired artifact hashes, existing WIP and Salesko draft-3 hash are preserved. No credentials, live provider/model/tokenizer calls, dependency installs, commit/push/publication, SDK/Session-RPC implementation or adjacent task work.

Evidence: native `.artifacts/c07-native-input/g1-path-repair/verification.json`, SHA256 `a39282878e15cf81b2f35a08e265e4b90381f534572956e1e57b6adfcadeccca`; full command logs and the file-backed verifier are retained alongside it. Status is **source repair PASS; G1 package gate PARTIAL**. Previously packed archives still contain the old declaration and must not be relabeled fixed.

Task Breakdown: [x] approved single annotation edit; [x] existing path regressions; [x] required native check; [x] actual generated-declaration differential consumer check; [x] evidence/handoff. Next bounded bottleneck is diagnosis of TS1543: trace `packages/ai/src/providers/*.models.ts` through the existing declaration compiler/configuration into emitted JSON imports and reproduce one provider offline. Register the minimal native-owner repair from evidence; do not edit 39 generated declarations, regenerate live catalogs or weaken consumer checking. Full package acceptance must await that separate issue and newly fixed artifacts.

### 16. G1 full package declaration closure PASS — 2026-09-15

Owner instructed continuing in-scope reversible diagnosis, repair and affected acceptance without repeated per-slice approval. This checkpoint closes the observed G1 declaration blockers with new local artifacts. It does not extend into Gateway, SDK/Session-RPC implementation, live accounting, S0 freeze, publication or merge. Historical §9–§15 receipts remain unchanged; their failed artifacts are not relabeled.

**P1 — map.** Native `generate-models.ts` owns provider shard source generation; the existing grouped JSON and manifest own catalog data; native declaration emit owns published `.d.ts`; the external consumer's NodeNext compiler validates that public graph. A complete read of the generator confirmed that its ordinary entrypoint invokes live catalog fetches, so that entrypoint is not used for offline regeneration. The source template is now a pure native `scripts/model-catalog-source.ts` renderer shared by the existing generator, a bounded offline regeneration script and its compiler regression.

**P2 — Root Cause Evidence.** Symptom: 39 generated `.models.d.ts` files fail TS1543. Reproduction: a synthetic JSON import used both as a runtime value and in an exported `typeof` declaration produces an attribute-free ordinary import under both installed tsgo and tsc; strict NodeNext consumer checking fails. Cause: the source uses the runtime value import as its public type reference, and these installed compilers strip the runtime import attribute during declaration emit while retaining an ordinary import. Intervention: give the exported catalog type an explicit `import type CatalogValues` from the same JSON; retain the original runtime `values` import. The resulting declaration passes, and emitted JS is byte-identical. `verbatimModuleSyntax` alone was also tested and still fails. No claim is made about untested compiler releases.

**P3 — decision/scope.** Fix the native source-generation template, not emitted declarations or the consumer checker. One grouped JSON file remains the value/type authority. The change adds a type-only reference without new runtime behavior, broader model types or compatibility code. Scope: `packages/ai/scripts/generate-models.ts`, new `packages/ai/scripts/model-catalog-source.ts`, its 39 existing `.models.ts` projections and new `packages/ai/test/model-catalog-declarations.test.ts`. The offline writer imports the shared renderer and existing `validateGeneratedModelData`/`readModelDataProviderIds`; it verifies all planned output differences before any writes. It preserves every JSON/manifest byte and the aggregator. No permanent offline CLI or new provider discovery path is added. At 10x catalog size, regeneration/check cost scales with existing shards; no runtime allocation or budget policy changes are introduced.

Acceptance after source freeze:

- 16/16 focused tests PASS: new emitted-declaration consumer regression, existing model API/ID/provider literal coverage, and model-data validation. The new regression includes an unknown-model-key type rejection and proves the type-only name is absent from emitted JS.
- Native `npm run check` and full existing `build:offline` graph PASS. The check applied no formatter fixes; all source/WIP hashes remained stable during verification. All 39 emitted provider `.models.js` files are byte-identical to the prior build.
- New pi-ai and coding-agent archives packed with lifecycle scripts disabled; four unchanged closure archives reused. Two fresh external consumers installed offline with no manually added MCP dependency, no source aliases and no edited declarations. **Both full public-root declaration checks PASS** with strict NodeNext, resolveJsonModule and skipLibCheck=false.
- Normal SDK imports and bundled/unbundled CLI version smokes PASS. Public native prepare -> serialized artifact -> consume and ordinary stream send the same 2,185-byte fixture body, SHA256 `174536641a17c43ffe217a40523b65f62002549d8386138e8d9297dea05e55f2`; eight drift cases reject before transport. Coverage remains `unknown`; fixture counts are not production accounting.
- All 2,477 installed candidate files match their exact archive contents. All earlier archives, nine original B-P1 source/test hashes, catalog JSON/manifest/aggregator and frozen draft-3 are preserved. No new dependency/lock changes were needed in this slice.

New artifact identities (local uncommitted candidate version label remains 0.85.1):

| Package | SHA256 |
| --- | --- |
| pi-ai | `22b7c4b22c6be3b4a47b2f466d262060be30fe42cbc23cdf321af2e6ba1e50eb` |
| pi-coding-agent | `eb9ca44131efa33feb6bd18affb25f242d751d47d311b754d0254eb484524816` |

Evidence root: native `.artifacts/c07-native-input/g1-json-repair/`. `verification.json` SHA256 `ef9da5659199468b747697d91bf3e3349ca0bbb188421d889b25a9493519686b`; `artifacts.json` SHA256 `a82ac418b364a1f32f918ef7a8611f5e9372ec915fefc85679aeb74a23ab3ccd`. Full logs, lock readbacks, regeneration manifest and public mock result are retained. Root-cause records under sibling `g1-json-diagnosis/`: diagnosis SHA256 `7896750ee134e1e3e83d563d6ce4e541abc30542b0d4e7f6975f36a5011f4dbc`, variant proof SHA256 `f40a56bff483df22e5e016f575aaa435a446bcc01675f4caa8a67fcb90afd51e`.

Task Breakdown: [x] reproduce compiler boundary; [x] choose/prove type-only source repair; [x] shared native generator integration and offline projections; [x] focused/native checks; [x] new package and external acceptance; [x] evidence/handoff. **G1 PASS applies only to this pinned local artifact closure.** No commit/push/release/global install, live provider/model/tokenizer requests, credentials or adjacent work occurred.

Remaining first-batch path: public leaf consume still returns a provider stream rather than the real Session/RPC lifecycle. The next implementation boundary is the existing §11 G2 native bridge with actual tool/context snapshot and zero preflight side effects, using these fixed artifacts as the package baseline. G3 independently trusted Execution binding and G4 authoritative accounting/Host CAS/S0 remain required; undeclared capability or unknown coverage continues to fail closed. This source/package milestone is not production token readiness.

### 17. G2 native Session/RPC consume — implemented and packaged, 2026-09-15

The §11 design is now implemented in the native checkout and bound to new local artifacts. This checkpoint adds no SDK source, no public SDK API and no publication; G3/G4 remain closed and §9–§16 receipts are unchanged.

**Implemented scope.** agent-core takes an optional run-scoped `initialRequest` — frozen Context, first-request validator and stream thunk — in `packages/agent/src/{types,agent,agent-loop}.ts`, captured by the existing `runAgentLoop` invocation rather than attached to mutable provider-global state, exactly as §11.4 required. coding-agent adds the pure envelope and shared snapshot projection in new `src/core/prepared-session-input.ts` and the effective provider idle-timeout resolution in new `src/core/provider-timeout.ts`. `agent-session.ts` implements `promptPrepared`, prepared eligibility validation, the operation-local reservation and `hasActivePreparedReservation`; `sdk.ts` implements `createPreparedAgentSession`; `index.ts` and `package.json` publish the root exports and a new `./prepared-session-input` subpath. `modes/rpc/{rpc-types,rpc-mode}.ts` implement the strict `prompt_prepared` command behind a `PREPARED_RESERVED_COMMANDS` / `PREPARED_ALLOWED_COMMANDS` partition guard. New focused tests are `packages/agent/test/initial-request.test.ts` and `packages/coding-agent/test/{prepared-session-input,rpc-prepared-input}.test.ts`; `scripts/coding-agent-consumer.mjs` resolves the positive subpath, `scripts/coding-agent-consumer.test.mjs` declares its fixture dependencies — repairing the 3/3 scripts regression the WIP declaration checker had caused — and `scripts/check-entry-graphs.mjs` records the coding-agent budgets.

**Gate history.** Gatekeeper PASS; then a fix delta (idle timeout fallback through `resolveProviderTimeoutMs`, the subpath export, reservation refusal, internal exports removed); then a focused re-gate **FAIL** on 12 uncovered mutating RPC commands; then the repair (a 15-command refused set, a single guard before the switch, and `prepared_timeout_unbounded` rejection when `httpIdleTimeoutMs === 0`); then re-gate PASS; then hardening with type-level partition exhaustiveness, an allowed-command table test and a forbid list. The intermediate FAIL is retained here: the first PASS did not cover the mutating-command surface.

**Deviations from §11, accepted by the orchestrator.** Pure `prepareCodingAgentSessionInput` ships on the new `./prepared-session-input` subpath rather than `./input-preparation`, keeping the B-P1 leaf import-clean. The method is `promptPrepared(input, expected, options?)`. `projectPreparedSnapshot` is public. `CreateAgentSessionOptions` gains `{baseToolsOverride, fetch, preparedInput}`. The reservation is held for the whole admitted run, which is stricter than §11.3.6's verify-and-dispatch window.

**Verification.** Native `npm run check` PASS, with a pre/post hash manifest proving biome modified no file under `packages/`, `scripts/` or the three locks; full `build:offline` PASS; focused tests coding-agent 7 files/101, agent 3 files/49, ai 4 files/22, root scripts 3/3. Repacked pi-ai, pi-agent-core and pi-coding-agent plus three reused closure archives install offline into fresh external consumers; public-root and both subpath declarations pass with strict NodeNext and `skipLibCheck=false`; SDK/CLI smokes pass; prepared and ordinary paths send the same fixture body with the prepared digest bound, drift rejects before transport, and the reservation is observed held during the open stream and released on settlement. All 2,485 installed candidate files match their archive bytes.

| Artifact | SHA256 |
| --- | --- |
| `verification.json` | `bf29dada5fcf7359bf867eccce86ddff7894ff7984880c36caa050670c16ac6d` |
| `artifacts.json` | `db3117f166d209bb777fb36dfa773178bd45d325863686c8251ea3968aca1d0e` |
| pi-ai | `22b7c4b22c6be3b4a47b2f466d262060be30fe42cbc23cdf321af2e6ba1e50eb` |
| pi-agent-core | `8c0997c15ff42404ff89c09c2f7bb60a6608355e6abeed20404681da8d647e89` |
| pi-coding-agent | `0d3b01532612fe2404a8a505c737e3fd4848fb628637d9fc25005add9bcc27e1` |

Evidence root: native `.artifacts/c07-native-input/g2-bridge-r3/`. It supersedes `g2-bridge-r2`, which supersedes `g2-bridge`; r3 was required because `rpc-types.ts`, `rpc-prepared-input.test.ts` and `check-entry-graphs.mjs` changed after r2 was produced. Local version label remains 0.85.1 and is not a registry release.

**Declared limits.** Header-level request equivalence is not proven; only body equality is. Prepared mode admits only openai-completions/zai per the B-P1 validator. Coverage remains `unknown`, so undeclared capability continues to fail closed. G3 trusted Execution binding and G4 accounting/Host CAS/S0 are untouched. Native package distribution is unresolved: this checkout is a fork of upstream `earendil-works/pi` while the SDK depends on registry 0.85.1, so no SDK consumer can import the surface yet. Everything is uncommitted; no commit, push, publication or global install occurred. Draft-3 remains SHA256 `c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678`, now resolved from salesko-new git `checkpoint/local-updates-20260915` after the main-checkout untracked copy was committed there and removed from disk by a concurrent process at 2026-09-15 01:51.

Task Breakdown: [x] run-scoped initial request in the existing loop; [x] pure envelope, prepared admission and explicit construction; [x] strict RPC command with partition guard; [x] focused tests, native check and offline build; [x] repack and external consumer acceptance; [x] evidence and handoff. **G2 PASS applies only to this pinned local artifact closure.** Next bounded bottleneck is the Owner decision on native distribution — upstream PR, own-scope publish, or vendored tarball — which gates SDK G3 launch binding and the B-P2 local primitive alike.

### 18. Fork distribution — 2026-09-15

The §17 native closure is now a registry artifact and the SDK pins it. `@byok-sdk/pi-ai`, `@byok-sdk/pi-agent-core` and `@byok-sdk/pi-coding-agent` are published at `0.85.1002`; inside them the `@earendil-works/pi-ai|pi-agent-core` edges are `npm:@byok-sdk/<same>@0.85.1002` aliases, while chord/tui/telemetry stay exact upstream `0.85.1`. `packages/client/package.json` declares `"@earendil-works/pi-coding-agent": "npm:@byok-sdk/pi-coding-agent@0.85.1002"`.

**Why own scope + alias.** Publishing under `@byok-sdk` is the only distribution the SDK controls; waiting on an upstream PR would leave the §17 seam unreachable by any consumer. The alias keeps the import specifier and the installed `node_modules/@earendil-works/pi-coding-agent` path unchanged, so no import site, extension path or launcher argument moves, and the change stays a one-line pin rather than a rename spread across the client. The consequence is that the specifier and the installed identity are now two different facts; they are split with one authority — `PI_PACKAGE_NAME` resolves, `resolvePiRuntimeIdentity()` parses the same manifest line for the exact installed name and version, and a resolved manifest that does not match fails closed with no PATH fallback.

**Version scheme.** `<upstream base>.<fork build>`: upstream `0.85.1` plus fork build `1` gave `0.85.1001`, fork build `2` gives `0.85.1002`; each stays an exact stable SemVer patch above every upstream `0.85.x` release, so an accidental upstream resolution can never satisfy the pin. The fork manifest records `byokFork: {upstreamBase: "0.85.1", upstreamCommit: "d981de1229ef899957bbe968bc8dcda02a21f477", forkBuild: 2}`, and the release gates assert that commit on the installed artifact. The upstream base commit does not move between fork builds — only `forkBuild` does.

**Fork build 2 — `0.85.1002`.** Added over `0.85.1001`, same upstream base `d981de1…`, fork source head `8329c5c`:
- a pure `projectSystemPromptSnapshot` (no I/O, no ambient state), so the prepared envelope can be compiled without touching the project;
- `RPC_MAX_FRAME_BYTES` plus `rpcFrameByteLength(message)` / `fitsRpcFrame(message)` in `dist/modes/rpc/rpc-types.js`, one authority for the transport frame cap;
- depth-1 id recovery on the RPC path.

Declared limit: `0.85.1002` ships those symbols but its `exports` map has no subpath reaching `rpc-types` (`.`, `./input-preparation`, `./prepared-session-input`, `./rpc-entry`, `./client`, `./experimental/plugin`) and the root entry does not re-export them, so no SDK consumer can import the frame cap without a deep import into a non-exported dist path. The pre-count frame check therefore stays unimplemented until the fork exports the subpath.

**`npm-shrinkwrap` dropped.** The native checkout builds its archives with a shrinkwrap; it is removed from the published fork tarball. A shipped shrinkwrap would pin the whole transitive graph inside a dependency, overriding the consumer's own resolution and re-introducing an upstream `@earendil-works/pi-ai` alongside the aliased one.

**Retirement condition.** The fork is deleted — not maintained — when upstream ships the prepared-session-input seam and the SDK pins that upstream release directly. At that point the alias reverts to a plain exact version, `resolvePiRuntimeIdentity()` reduces to the upstream name, and the `@byok-sdk/pi-*` packages are deprecated on the registry. No compatibility path keeps both alive.

**Declared limit — nested peer resolution differs by installer (resolved).** ~~Under bun the dev tree links `pi-mcp-adapter`'s optional peer `@earendil-works/pi-ai` (declared `^0.84.1`) to the fork, whereas an npm production install keeps a nested upstream `0.84.x` copy; neither path is exercised by `scripts/release/pi-launcher-smoke.mjs`, which stubs `resolveExtensions` and so never loads the real MCP extension.~~ Both halves are obsolete: `pi-mcp-adapter` is retired (absent from `packages/client/package.json` and `bun.lock`), so there is no nested MCP peer to resolve and no second MCP authority in the graph; and the launcher smoke now drives the real MCP extension from a task MCP config rather than stubbing extension resolution.

This slice pins and verifies the runtime only. Prepared-input consumption in the SDK (task-runner, pi-adapter, protocol) is untouched and remains the next slice.

### 19. G4-remote channel shape — implemented, 2026-09-15

The remote authenticated preparation lane is now real in the SDK. A Host authenticates against cloud, cloud appends one strict server→device envelope, the device prepares **in-process** and reports a receipt summary back over a direct authenticated HTTP call. Salesko Host wiring stays out of this slice.

**Channel.** `agent.input.preparation` (server→device, `task_id` FORBIDDEN, `seq` REQUIRED) is structurally the twin of `agent.home.projection` — with one deliberate divergence, the unconfigured failure posture: `agent.home.projection` throws (retaining the row and the cursor for operator repair) where `agent.input.preparation` reports a terminal rejection. A distinct message type rather than an optional field, so a daemon predating the contract answers `UnknownMessageTypeError` and skips it instead of stripping an unknown optional field and behaving as though it had prepared something. Capability `agent-input-preparation`; cloud lane declaration `agent.input.preparation`. The reply leg is `PUT /byok/input-preparations/:requestId/completion` plus a device-authenticated `GET /byok/input-preparations/:requestId`; both mount unconditionally, because the completion route is the device's only way to discharge a row the same deployment handed it.

The payload carries `{requestId, agentRef, profileId, policyRevision, source, selection, deadlineAt, context, requiredToolsets}` and nothing else. No tools, no `toolExecutors`, no runtime or compiler identity — those are local observations. No `tenantId`/`deviceId` — those come from the device's own authenticated record. `profileId` rides beside `agentRef` rather than inside it because `AgentRefSchema` is the frozen generic Agent identity every other message shares; widening it would break all of them.

**The 64 KiB control channel is bypassed by the remote path.** `input-preparation-remote.ts` calls `inputPreparationService.prepare()` directly and imports nothing from `control-protocol.ts`, `control-client.ts` or `node:net`; `input-preparation-remote.test.ts` fails any case that opens a socket. Inline context is bounded by the wire's own `MAX_INLINE_BYTES` (64 KiB, the same constant every inlined artifact uses) with a `BlobRef + contentHash` form above it — no preparation-specific enlargement, no implicit chunking, and the device re-hashes the decoded bytes before compiling. This is the evidence Owner ruling 3 (2026-09-15, §15) attached its condition to: G3-frame / plan A is not required on the production remote path. `fitsRpcFrame` on the complete RPC message before the counter remains mandatory regardless, and the `NdjsonLineReader.push` non-determinism recorded in §17 B is untouched here.

**Idempotency.** One key, `(deviceId, agentRef, requestId)`, minted by the Host and carried unchanged through the cloud request receipt, the device's durable namespace and the completion. Cloud conflict is whole-body: re-binding one requestId to a different model, context or deadline is the substitution the immutable receipt exists to prevent. A Host that times out re-reads status; it never mints a second id, so a duplicate cannot become a second counter call. Re-delivery to the device resolves through the store's `reserve` → `existing` path — one compile, one counter call, two equal completions.

**Deadline.** Only tightening: `prepare` takes an optional per-call deadline applied as `min(deadlineAt - now, limits.preparationDeadlineMs)`, and an already-elapsed deadline refuses before compiling.

**Failure posture.** Every business refusal is reported as a terminal completion so the row is discharged and the cursor advances — `input_preparation_unconfigured` included, because throwing there would freeze the device's redelivery cursor behind a row it can never answer. Only a failure to record the outcome throws, so the cursor never moves past an envelope whose result cloud never learned.

For that to hold, cloud has to ACCEPT the rejection, so the completion route asserts **no device capability**. A daemon with no `inputPreparation` section does not advertise `agent-input-preparation` (`create-daemon.ts`'s `computeCapabilities`), so a capability assertion on `PUT /byok/input-preparations/:requestId/completion` would have refused exactly the one completion such a device can produce: the PUT would throw inside the completion client, the envelope handler would never resolve, and the strictly seq-ordered cursor would stall behind that row and every envelope after it. The device flag is the **admission** gate and lives on `enqueueInputPreparation` alone — a device without it is never handed a row. Completion authority is the row's own binding (authenticated device, exact `AgentRef`, `profileId`, `policyRevision`) checked by `recordInputPreparationCompletion`, plus the first-terminal-outcome conflict rule; neither is weakened. The one authority reduction this accepts, stated plainly: revoking `agent-input-preparation` after enqueue no longer refuses an in-flight completion — that row was legitimately admitted, its receipt stays not-ready and G4 is closed to activation — so revocation stops NEW admissions only. Evidence is a real-route test, not a stub: `packages/cloud/src/__tests__/input-preparations.test.ts` drives an unconfigured device's rejection through the actual cloud handler and asserts 200, a durable `rejected` status, and a mailbox cursor ACKed past the envelope.

**Measured delivery latency (Step 0).** Cloud holds `GET /byok/events` open for `longPollHoldMs` (default 50 s), re-reading the mailbox every `longPollIntervalMs` (default 250 ms); the client sleeps `idleDelayMs` (default 250 ms) after an empty page. Steady-state device delivery is therefore **≈250 ms + RTT typical, ≈500 ms + RTT worst normal case**. Degraded paths back off to `retryDelayMs` (default 2 s) with ±20 % deterministic jitter and **no exponential escalation**, so a flapping route settles at ~1.6–2.4 s per attempt. Three paths are unbounded and are the reason a Host must not block a PG transaction on this: the device being offline; a stalled cursor (the mailbox is strictly seq-ordered, so a preparation behind an envelope whose handler keeps throwing is never delivered); and `cursor_too_old`, which stops the transport until an operator resync. A Host CAS that waits synchronously is therefore only safe behind a short timeout that falls back to an async trigger plus status readback — `getInputPreparationStatus` exists for exactly that.

**Declared limits.** This lane compiles the observed MCP toolset tools only; Pi's own native tools are selected by a runtime policy the task-free path never resolves. No remote cancel in this slice. No counter implementation, no S0 numbers, no `RuntimeOperationManifest`/task-runner change: `coverage: unknown`, a fixture counter authority and `executor_identity_unproven` all still keep a receipt not-ready, so G4 stays closed to activation.

**Deliberate golden regeneration.** `packages/protocol/src/__tests__/golden/v1.frozen.json` and `v1.envelopes.ndjson` were regenerated because the diff is purely additive per docs/protocol.md's freeze rule — one new message type, one new capability flag, four new HTTP schemas, nothing changed, removed or retyped. `PROTOCOL_VERSION` stays 1.
