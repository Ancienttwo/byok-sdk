# docs/spec.md 修订草案：pi-durable 集成

状态：草案（2026-10-02 已合入 advisor 接受项与 Pi 1.0 step1 实测口径），未改 `docs/spec.md` 正文。owner 同意后再合入。
配套设计：`docs/researches/2026-10-02_pi-durable-integration-design.md`
行号以 2026-10-02 工作区为准。新增英文条文保持 spec 原有文风；每条前附中文说明。

---

## R1 — `### Recurring Host composition requirements`（约 2335 行）· D2

说明：现文"No SDK Conversation store is added."与设备端 durable.sqlite 字面冲突。改为：Host 仍是唯一权威，设备副本不是 Conversation store。

替换：
> The Host freezes a Conversation's selected continuity at creation and owns transcript, Turn/Execution association, queue settlement, context history and Summary jobs. No SDK Conversation store is added.

为：
> The Host freezes a Conversation's selected continuity at creation and owns transcript, Turn/Execution association, queue settlement, context history and Summary jobs. No SDK Conversation store is added as an authority. When the durable Pi lane is enabled, the device may keep a recoverable replica under SDK-private storeDir (slice 1 uses a per-execution file `<storeDir>/durable/<agent-binding>/durable-<taskId>.sqlite` outside the tool workspace). The configured replica root MUST be disjoint from canonicalHome after pathname validation; overlap is rejected before spawn. AgentRef/taskId/leaseId bind storage, and the canonical runtime cwd and sealed manifest remain unchanged. The replica is never authoritative for transcript, context or settlement, and may be deleted without product data loss; deletion only removes in-process recovery. No protocol message exposes replica contents except the explicitly selected result document of the current execution. Owner M1: every new execution resets the root from Host-supplied context and uses its own `durable-<taskId>.sqlite`. Before opening storage, journal/current-lease authority adjudicates leftovers; no prior execution pending work is resumed. Recovery of the same execution under the same lease does not append Host context a second time.

---

## R2 — `## Durable execution recovery`（约 2135 行）· D4

说明：保住"daemon restart never reruns committed runtime side effects"。新增一段，界定 durable 续跑的范围与工具重放策略。

在该节第一段末尾追加：
> On the durable Pi lane, checkpointed continuation is permitted only within one execution while the daemon still holds that execution's home lease (for example a crash of the `byok-pi-durable` child). It never survives a daemon restart as the same execution: the existing `daemon_interrupted` terminal rule applies, and any continuation is an explicit new Host execution with a new taskId. After a terminal that includes `daemon_interrupted`, the next execution MUST NOT resume leftover pending, running, or queued work from prior replica storage: use a fresh per-execution storage file, adjudicate leftovers before opening it, and discard unknown submissions before any `submit` or `resume`. Opening a replica whose last execution is terminal in the journal MUST NOT start the scheduler before the replica is reset. The durable submission `requestId` equals the execution taskId. Tool replay is off by default. Only tools on a frozen read-only allowlist may declare `replay: "safe"`; shell and every tool with write or external effects may not. Two layers: (1) the harness never auto-reruns a committed non-replayable tool call; (2) any model re-issue after an `interrupted` tool result is model behavior and is not covered by this daemon-restart promise. For slice 1, if the child crashes with an in-flight non-replay-safe tool, the execution ends in `task.fail` without `resume`. Slice 1 also sets harness `retry.maxRetries: 0` and `compaction.enabled: false`, which disables normal auto-retry but does not disable checkpoint model-request resends. Owner permits those resends only within the same execution and current lease, with no in-flight tool; usage is reported as ordinary observed usage, including any reported spend of the interrupted attempt, without a prepared charge-once guarantee.

---

## R3 — `### Pi credential launcher executable contract`（约 2357 行）· D3

说明：把 `byok-pi-durable` 纳入与 `byok-pi-prepared` 相同的 custody 合同；daemon 仍 credential-blind。同时需在 `docs/security.md:868-876` 加一句引用（附后）。

在该节末尾追加：
> The durable Pi lane runs in a separate `byok-pi-durable` executable launched through the same credential launcher and launch-binding contract as `byok-pi-prepared`. The credential launcher transfers the provider key over a private, one-shot JSON IPC channel bound to the launch config digest; it MUST NEVER place the key in the durable child's environment, argv, stdio RPC or replica files. The worker consumes it into model/provider memory and disconnects IPC before constructing tools or MCP children. Deleting process.env is not an isolation mechanism. Tool exec MUST force `inheritEnv: false` and an explicit allowlist. Conformance tests require no key in both inherited tool env and the worker's OS-introspectable initial environment (`ps eww` / `/proc/<pid>/environ`). The daemon communicates with it over stdio RPC, does not depend on `@byok-sdk/keys`, and never reads, proxies or forwards credentials. Its environment is rebuilt by the same EnvironmentBuilder allowlist with `BYOK_*` and loader-injection deny. One child exclusively owns one durable storage; because upstream pi-durable provides no cross-process lock, the child MUST acquire an OS exclusive lock (flock or sidecar lockfile) bound to the current leaseId before opening storage, and MUST fail closed if it cannot. The child exists only while its daemon holds the home's single-writer lease; lease release requires the child's disposal receipt or confirmed process-tree death (wait after KILL).

`docs/security.md` 第 868-876 行段末追加：
> The durable Pi lane (`byok-pi-durable`) is a custody-launched child under the same rule; it does not move credentials into the daemon.

---

## R4 — `### Official Pi migration security and installation contract`（约 2361 行）· D1

说明：现文冻结了 0.99.2 与"直接依赖恰好三个包、chord 为传递依赖"。升级到 1.0 并引入 pi-durable 会改变直接依赖集合，需要新的 ruling。

替换：
> Client direct Pi dependencies are exactly coding-agent, pi-ai and pi-agent-core at 0.99.2 and retain the existing direct-dependency purity guard. chord, pi-codemode, pi-mcp, pi-telemetry and pi-tui remain transitive.

为：
> Client direct Pi dependencies are exactly coding-agent, pi-ai, pi-agent-core, pi-durable and chord at 1.0.0 (exact pins), and retain the existing direct-dependency purity guard. The authoritative direct-dependency set is whatever `collect-official-pi-closure` reports for the pinned release; a mismatch fails the purity guard. pi-durable is experimental upstream: it is pinned exactly, and every version change requires fresh closure attestation and a fresh ruling. pi-codemode, pi-mcp, pi-telemetry and pi-tui remain transitive. Measured for the local Pi 1.0 tip: upstream commit `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`, closureDigest `7f010b1a1bf36bb08e479d6651e0aaa556c00abc2ab02a1275d31ba4c81a1d87`, nine official package names in attestation (was eight; added pi-durable), eleven Bun-resolved official package instances on the attesting host (was eight; duplicate peer instances remain exact 1.0.0). This step's checkout has no OAR package dependency and no `vendor/oar/`; OAR wiring remains a separate later step.

并把正文里"all eight official package instances"改为上述实测口径（9 names / 11 Bun instances；11 为该次 Bun 解析结果，其他包管理器布局仍须逐实例验证）。

---

## R5 — 新增小节 `### Durable Pi lane (experimental, flag-gated)`（放在 R3 所在节之后）

> The durable Pi lane is disabled by default and advertised only as an adapter capability; protocol intersection remains the execution gate. The first slice runs one harness with one root conversation per execution (per-execution replica required). The lane admits only the YOLO effective policy and refuses any other computed effective policy before spawning. Tool permission follows the owner's YOLO ruling: the `beforeTool` hook admits calls without Host approval and emits no `needs_approval`; a throwing hook blocks the call. Hard path denials apply only to tools with structured path arguments; bash is best-effort only (reject explicit `BYOK_*` / loader-injection assignments) and is not workspace-bound under YOLO—boundary is env isolation (`inheritEnv: false`) plus process/replica lock. YOLO does not relax replay: slice 1 declares no replay-safe tools; any future read-only allowlist requires a separate reviewed slice, and the environment allowlist still applies. Slice 1 is an unprepared ordinary path: harness `compaction.enabled` is false and `retry.maxRetries` is 0. This disables auto-retry, not checkpoint model-request resends; permitted same-execution recovery reports ordinary observed usage. Prepared-lane guarantees (first-request byte identity with counted artifact, at-most-once scoped fetch, prepared charge-once binding) do not apply. Harness events map onto existing AgentEvent variants using Pi 1.0 names: `run_end`→`turn_end`, `tool_execution_*`→`tool_use`/`tool_result`, `usage_changed`/`message_end`→`usage`, `task_failed`→`error`, result-doc writes→`artifact`; `snapshot` must not be replayed as live progress; needs_approval is unused; unmapped events follow the existing unknown-event rule. The final answer is written to a result document and delivered only through an explicitly selected `terminalProjection: result-document`. Background subagents, wake tasks, memory documents, fork, multi-client steering and remote execution environments are not part of this slice. Recurring schedules remain Host-driven; the device does not interpret cron.

---

## 不改动、但需同步标注的位置

- OAR 评估文档 Owner 决策第 2 条：标为 superseded（被第 7 条及 D3 取代）；引用前先在 OAR 文档实际标注（advisor m8）。
- `docs/architecture/sdk-architecture.md:2186` ADR-015：owner 2026-10-02 决定 Pi durable 走 YOLO，需改写为对该 lane Accepted（与 Claude `confirm` 去留一并处理）。R5 已按 YOLO-only 准入改写。

Durable replica retention: normal terminal disposal removes the current transcript sqlite and task launch config. A daemon SIGKILL can leave transcript replicas, launch configs (Host input/mcpEnv) and lock sidecars in the SDK-private store. They remain owner-only, never resume at daemon startup, and are not automatically swept in slice 1. Explicit offline maintenance may remove them only after the associated execution is terminal and no home lease or worker owns them; retention/GC is a follow-up, not an implicit deletion of active or unknown work.

Structured tool scheduling (slice 1): read/write/edit use the public sequential executionMode, making their entire tool round sequential. This closes the same-turn bash-symlink versus structured I/O race across the journal ACK. It is not a filesystem sandbox against independently running processes or YOLO shell code.

Automatic orphan GC remains blocked after the knife-6 namespace-swap probe: pathname lstat/realpath checks followed by asynchronous unlink can follow a concurrently substituted parent symlink. Home-lease/journal/lock proof alone does not pin filesystem namespace identity. No best-effort sweep is enabled; a follow-up must supply a validated fd-relative no-follow mutation primitive on each supported platform, or obtain an explicit narrower namespace-trust contract. No new continuation or deletion authority is inferred from replica metadata.
