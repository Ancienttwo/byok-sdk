# docs/spec.md 修订草案：pi-durable 集成

状态：草案，未改 `docs/spec.md` 正文（该文件当前在 `pi-0.99.2-context-usage` 分支有未提交改动）。owner 同意后再合入。
配套设计：`docs/researches/2026-10-02_pi-durable-integration-design.md`
行号以 2026-10-02 工作区为准。新增英文条文保持 spec 原有文风；每条前附中文说明。

---

## R1 — `### Recurring Host composition requirements`（约 2335 行）· D2

说明：现文"No SDK Conversation store is added."与设备端 durable.sqlite 字面冲突。改为：Host 仍是唯一权威，设备副本不是 Conversation store。

替换：
> The Host freezes a Conversation's selected continuity at creation and owns transcript, Turn/Execution association, queue settlement, context history and Summary jobs. No SDK Conversation store is added.

为：
> The Host freezes a Conversation's selected continuity at creation and owns transcript, Turn/Execution association, queue settlement, context history and Summary jobs. No SDK Conversation store is added as an authority. When the durable Pi lane is enabled, the device may keep a per-home recoverable replica (`<home>/.byok/durable.sqlite`). The replica is never read by the Host, never authoritative for transcript, context or settlement, and may be deleted without product data loss; deletion only removes in-process recovery. When Host-supplied context and the replica disagree, the Host context wins and the replica is reset from it.

---

## R2 — `## Durable execution recovery`（约 2135 行）· D4

说明：保住"daemon restart never reruns committed runtime side effects"。新增一段，界定 durable 续跑的范围与工具重放策略。

在该节第一段末尾追加：
> On the durable Pi lane, checkpointed continuation is permitted only within one execution while the daemon still holds that execution's home lease (for example a crash of the `byok-pi-durable` child). It never survives a daemon restart as the same execution: the existing `daemon_interrupted` terminal rule applies, and any continuation is an explicit new Host execution with a new taskId. The durable submission `requestId` equals the execution taskId. Tool replay is off by default. Only tools on a frozen read-only allowlist may declare `replay: "safe"`; shell and every tool with write or external effects may not. An interrupted non-replayable tool is reported to the model as interrupted with its stored partial output and is not rerun. A model request interrupted mid-stream may be resent by the harness; this is not a committed side effect but is visible as additional usage.

---

## R3 — `### Pi credential launcher executable contract`（约 2357 行）· D3

说明：把 `byok-pi-durable` 纳入与 `byok-pi-prepared` 相同的 custody 合同；daemon 仍 credential-blind。同时需在 `docs/security.md:868-876` 加一句引用（附后）。

在该节末尾追加：
> The durable Pi lane runs in a separate `byok-pi-durable` executable launched through the same credential launcher and launch-binding contract as `byok-pi-prepared`. Provider credentials are visible only to that child. The daemon communicates with it over stdio RPC, does not depend on `@byok-sdk/keys`, and never reads, proxies or forwards credentials. Its environment is rebuilt by the same EnvironmentBuilder allowlist with `BYOK_*` and loader-injection deny. One child exclusively owns one durable storage; it exists only while its daemon holds the home's single-writer lease, and lease release requires the child's disposal receipt.

`docs/security.md` 第 868-876 行段末追加：
> The durable Pi lane (`byok-pi-durable`) is a custody-launched child under the same rule; it does not move credentials into the daemon.

---

## R4 — `### Official Pi migration security and installation contract`（约 2361 行）· D1

说明：现文冻结了 0.99.2 与"直接依赖恰好三个包、chord 为传递依赖"。升级到 1.0 并引入 pi-durable 会改变直接依赖集合，需要新的 ruling。

替换：
> Client direct Pi dependencies are exactly coding-agent, pi-ai and pi-agent-core at 0.99.2 and retain the existing direct-dependency purity guard. chord, pi-codemode, pi-mcp, pi-telemetry and pi-tui remain transitive.

为：
> Client direct Pi dependencies are exactly coding-agent, pi-ai and pi-agent-core at 1.0.0, plus pi-durable at exactly 1.0.0 and chord when the durable lane is built, and retain the existing direct-dependency purity guard. pi-durable is experimental upstream: it is pinned exactly, and every version change requires fresh closure attestation and a fresh ruling. pi-codemode, pi-mcp, pi-telemetry and pi-tui remain transitive.

并把"all eight official package instances"按 1.0 实测 closure 数量更新（待 collect-official-pi-closure 重跑后填写，不预填）。

---

## R5 — 新增小节 `### Durable Pi lane (experimental, flag-gated)`（放在 R3 所在节之后）

> The durable Pi lane is disabled by default and advertised only as an adapter capability; protocol intersection remains the execution gate. The first slice runs one harness with one root conversation per home. Tool permission follows the owner's YOLO ruling: the `beforeTool` hook admits calls without Host approval and emits no `needs_approval`; it retains only hard policy denials, and a throwing hook blocks the call. YOLO does not relax replay: the read-only `replay: "safe"` allowlist and the environment allowlist still apply. Harness events are mapped onto the existing AgentEvent variants (progress, tool_use, tool_result, artifact, turn_end, error, usage; needs_approval is unused on this lane); unmapped events follow the existing unknown-event rule. The final answer is written to a result document and delivered only through an explicitly selected `terminalProjection: result-document`. Background subagents, wake tasks, memory documents, fork, multi-client steering and remote execution environments are not part of this slice. Recurring schedules remain Host-driven; the device does not interpret cron.

---

## 不改动、但需同步标注的位置

- OAR 评估文档 Owner 决策第 2 条：标为 superseded（被第 7 条及 D3 取代）。
- `docs/architecture/sdk-architecture.md:2186` ADR-015：owner 2026-10-02 决定 Pi durable 走 YOLO，需改写为对该 lane Accepted（与 Claude `confirm` 去留一并处理）。R5 已按 YOLO 改写。
