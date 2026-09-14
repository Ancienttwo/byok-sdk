# Runtime input preparation / consume boundary

Status: proposed SDK contract with provider-free feasibility evidence. This document adds no public SDK API and does not replace accepted C05.

Current checkpoint: B-P1 documentation/evidence frozen on 2026-09-14; Owner locked the four §6 defaults (Building Group). Installed Pi has no pure compile/consume public seam. Stop at this native dependency; B-P2 and production activation remain unimplemented and unauthorized in this slice.

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
