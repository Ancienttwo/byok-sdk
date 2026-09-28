# Hermes Bot Adoption — Dispatch Notes

## Authorization and boundaries

用户「落plan派工」授权总体计划与首批派工。总体plan：`plans/plan-20260928-0217-hermes-bot-adoption.md`。首轮为docs-only；后续批准已扩至WP1-I SDK source实现与本地验证，当前结果见末尾实施记录。Host实现与release不在授权范围。独立worktree与branch见plan；原BYOK、Salesko、Hermes WIP全部保留。

## Planning receipt

- repo-harness-plan create流程与geju framing已完成；inspector mode=audit，无drift signal。
- Claude planning session `4b64b581-4869-4367-862f-170022f2cdb8`成功返回。原始输入/结果在原BYOK checkout `_ops/hermes-bot-plan-20260928/`。其输出为咨询，不是设计权威；parent拒绝自动memory snapshot envelope和SDK业务proposal事件，保留现有MCP接入待证路线。
- capture-plan生成 `plans/plan-20260928-0217-hermes-bot-adoption.md`，Status Approved仅覆盖明示第一波。
- 两份delegation contract初次preflight指出Scope缺少结构化In scope/Out of scope；修正格式后两份均preflight_pass。无产品改动。

## Readiness dispatch

- `/root/bot_sdk_readiness`：SDK prepared memory可达性只读，首批input。
- `/root/bot_host_readiness`：Host只读。main路径不得代表prepared候选；已派补核 `salesko-new-wt-c07-host`，保留其todos WIP。

## Next deliveries

WP1-D、WP2-D分别独占一份research文档，root独占plan/contract/notes/review。交付收取结果追加到本节，不能仅靠会话内通知恢复工作。

## Collected deliveries

- WP1-D `/root/prepared_memory_design`: RESULT DONE. Delivered the descriptor/count/seal/handler candidate, source evidence, exact implementation entrypoints and negative controls. One parent correction round addressed lifecycle ordering, authentication/execution binding and legitimate recall visibility.
- WP2-D `/root/host_lifecycle_design`: RESULT DONE. Delivered existing ContextPack reuse, local/Host authority, lifecycle and forget boundaries. One parent correction round addressed exact ownership, receipt/current revision distinction and live-memory visibility.
- Both workers handed write ownership back to root. Root normalized the principal row, switched focused commands to the existing package test script, corrected Mermaid labels and removed the duplicate generated Task Breakdown.
- WP1-D, WP2-D and WP0-G are complete. The program remains Executing, with WP1-I through WP5 incomplete. No product implementation or product test execution is claimed.
- Two contract gaps remain explicit: SDK persisted descriptor representation; Host approved intent to device-local CAS, including visibility/lease semantics if next-turn-only visibility is required.
- Final parent scope/format/workflow results are recorded in the matching review.

## Approved follow-up: WP1-I-E

用户批准 expression gate 后，root执行协议与runtime链追踪，`/root/memory_descriptor_representation` 只读核查类型/持久化表达。结论与最小反例追加到 SDK design 的 WP1-I-E；current source证明通用容器可复用，但SDK-owned memory没有selector/registry/task-free observation/runtime闭环。原有falsifier成立，因此不修改产品代码。

本地 `_ops/hermes-memory-expression-gate/` 保存探针、subject与结果。纯协议正控+三个unknown-key负控 exit 0；完整assembler探针因现有依赖缺失未成功运行，未修复依赖。625个tracked source与同HEAD原checkout逐字节一致，避免借用不同source结果。WP1-I-E完成，WP1-I-C与产品实现保持未完成；原WIP保留。

`/root/memory_descriptor_representation` 已回传 FINDINGS COMPLETE，支持“通用容器可用、授权 capability 不可达”的结论。parent引用以自己核实的source为准：exact session manifest compare在prepared-session.ts:308；executor builder具有native参数分支但当前两端传空。不会把“binding没有task credential”解读成应把credential存入artifact，仍要求执行期晚绑定。

## WP1-I-C: approved contract amendment

用户批准后，root在同一隔离树完成规范 `docs/researches/2026-09-28-prepared-agent-memory-contract.md`；`docs/spec.md`/`docs/protocol.md`明确链接待实现v8 scoped cut，当前v7产品行为没有改变。原allowed_paths按批准扩为11个准确文档路径。explorer复用 `/root/memory_descriptor_representation` 只读交付定位；root独占写入。

Claude planning session `7c9e4f75-6b09-4c3d-914e-92b11ac9cf92` 成功返回（`_ops/hermes-memory-contract/`保留输入与结果）。采纳单一classification authority、完整descriptor parity、post-claim失败清理、所有v8模式统一digest v2。根据真实source拒绝其confirm/plan读能力建议、memory名称改写和另建stdin credential transport建议。代码证明Pi两模式均拒绝；新helper subject必须显式处理context env投影，不可假定当前attested gate已接受memory凭据。

定案：required agentMemory none/read/read-write；scope resolver给出local ceiling；prepared read-token在daemon入口也不能save；新增descriptor-only helper和真实sdk-helper identity subject；trusted launch在memory-only仍存在；按同一链compare/seal/pin/claim后才绑定授权。record/wire v8、digest v2 one-shot，outer v1；不引入新artifact内容格式、不扩大native/tools/UI。

验证采用本次docs-only边界；上一轮协议探针只证明v7严格性，不重跑也不当v8实现证据。产品实现、dependency修复、Host adoption、版本激活均未执行。

## Current-source corrections and actual dispatch

- 两个explorer均交付，WP0-C完成。SDK直接阻断点是task-runner preparation条件，且prepared runtime manifest没有reserved memory registration。不能只改注入if。
- Host基线已更正：c07-host候选有ContextPack与完整prepared入口；main缺失不能泛化。Summary生产writer仍未在该候选实现。准确候选与入口在plan和WP2-D中。
- `/root/prepared_memory_design` 已接受WP1-D，独占prepared-memory-design.md；`/root/host_lifecycle_design` 已接受WP2-D，独占host-lifecycle-design.md。两人agent_type=fast-worker，fork_turns=none，引用各自preflight-pass contract。
- capture-plan自动建立了本隔离worktree的active marker。首次strict因缺少同stem协调contract失败；已补齐父contract并将notes/review对齐canonical stem，父contract preflight_pass。原worktree marker未修改。


## WP1-I: approved SDK implementation

用户批准 accepted memory contract 后，root 在同一隔离树执行完整 SDK slice。两名写 worker 先分别完成 identity/helper，再顺序接手 admission/runtime；交回 ownership 后 root 集成 protocol、preparation、task lifecycle、测试与文档。原 checkout、Salesko 和 Hermes 未修改；没有 commit、push、publish 或 deploy。

P1：严格 local/remote preparation 请求与本地 ceiling，SDK descriptor/identity，既有 compiler/store，prepared admission，Pi host 与 daemon memory CAS。P2：显式 mode -> ceiling -> reserve -> 无 task credential 的 descriptor -> count/freeze -> offer/live identity 比对 -> seal/pin/claim -> token -> execution helper 重测与完整 descriptor parity -> tool call -> helper/daemon ACL -> quiesce/revoke。P3：复用 compiler/artifact/home/CAS 与 Pi provider authority；memory 是独立 SDK capability，不借用 Host registry。wire/record v8 与 digest v2 同刀切换，无旧 reader/default。

真实 descriptor 子进程经 existing Pi compiler 的测试证明 read 只计入 recall、read-write 计入两个工具且请求无 task credential。真实 TaskRunner 的 memory-only 测试证明 claim 前无 token，claim 后私有执行绑定，occupied-pin loser 不启动；identity/probe 外边界在此测试中显式 mock，物理 helper 度量由独立 identity/descriptor 测试覆盖。Pi runtime 测试证明私有调用路由、完整 parity 及失败关闭，不冒充 live provider 验证。

冻结 source subject：`_ops/hermes-memory-implementation/source-subject.json`，1362 文件，SHA-256 `24e00d0a079c21479ef002752b7b93afad6f25114742c2c3dc4265c058c1178e`。此 fingerprint 覆盖 packages、API snapshots、root manifest/lock；文档后续更新不改变实现 subject。

验证过程：首轮 full test 发现旧 fixture 缺少必填 mode，已修复；admission-deadline 独立复验通过。Bun MCP cwd 测试在首轮及 targeted 复验超时；未修改其断言/timeout。base e83e685 的 client source 在 ignored disposable 目录、相同依赖和当前 workspace dist 下运行该测试 3/3 通过，仅证明此运行通过，不能据此认定候选无回归或确诊环境问题。冻结后 final full test 是该问题的第三轮候选验证，禁止继续循环。最终 disposition 见 matching review。

最终 build 后顺序 typecheck 通过。曾将 typecheck 与会清理 dist 的 build 并发，导致 example 临时找不到 client 声明；该无效运行已废弃，后续只采用 build 完成后的 typecheck 结果。

Final test outcome: root command FAIL with exactly one client timeout (3123 pass / 1 fail / 11 skipped); other 12 workspace suites separately PASS (2427 pass / 130 skipped). Build, post-build typecheck, API and version checks PASS. Canonical Obsidian BYOK project note updated with source/validation/adoption boundaries. WP1-I remains open; no further candidate retry.

## 2026-09-28 Claude takeover (w2:pT)

Coordination moved from Codex w2:pR to Claude w2:pT at the user's direction. Bounded diagnosis (root-cause-prover, writes only in ignored `diagnosis-mcp/`) proved the Bun MCP timeout is environmental: the bloated default `$TMPDIR` makes Bun's ancestor-directory scan slow, identical on base and candidate. The user approved an isolated-TMPDIR acceptance run (round four, invalidated by an over-long socket path chosen in the dispatch) and a short-path rerun (round five, all 13 workspaces PASS on the old subject). First gatekeeper FAIL findings were fixed by one writer; the user ruled that v7 operator retirement belongs in WP1-I (contract section WP1-I-R, allowed_paths amended). Live-pin semantics mirror `replay()` last-line-wins per `recordId`. Final subject `09a81ce1…f616`, all required checks PASS once; re-gate blocked only on a stale spec sentence, fixed and rechecked. Disposition in the matching review.
