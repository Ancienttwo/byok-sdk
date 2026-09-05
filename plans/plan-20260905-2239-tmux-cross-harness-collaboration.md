# Plan: 跨 harness 本地协作集成

> **Status**: Draft — integration and notify probes recorded; Claude capability blocked
> **Created**: 20260905-2239
> **Slug**: tmux-cross-harness-collaboration
> **Artifact Level**: work-package
> **Planning Source**: 用户授权；现有 Claude/Fable 5.1 pane 讨论；三 harness 原生协议实测。
> **Promotion Reason**: 确定已有通信能力与尚缺自动通知/终端生命周期之间的边界。
> **Verification Boundary**: 本轮仅探针及文档；未授权执行下方产品实现。
> **Rollback Surface**: 删除本轮研究/探针/Draft 与 contract scope additions；不删除 native home 或用户 pane。
> **Spec**: `docs/spec.md`，产品权威未改变。
> **Research**: `docs/researches/2026-09-05_cross-harness-probe.md`
> **Task Contract**: `tasks/contracts/20260905-0114-public-package-topology.contract.md` 中明确 probe-only 路径。
> **Source Baseline**: `12278dc429bd15660190e237e0f6c97d654d5643`

## Goal

让独立配置、模型和 native session 的 Claude/Codex/Pi 通过现有 TeamWorkspace 交换消息，并在受控生命周期内自动继续讨论。通信核心独立于 tmux；tmux 是可见终端 host 的候选。用户不必安装自己不使用的 harness。

当前不需要大规模重构。先验证必要入口，再按实际缺口集成。普通 Windows 用户的安装成本是产品决策输入；可见交互终端是否必须、native Windows 与 WSL 优先级尚未裁定，不预设 WSL 是所有用户的前提。

## P1: Architecture Map

- TeamWorkspace：本地成员/租约/消息/seq/delivered/ack 唯一权威，现有三 MCP 工具已能被三种 harness 调用。
- Team MCP/helper/local control：保留，避免第二份聊天数据库或屏幕正文解析。
- 原生 harness：拥有模型循环、上下文、session 和审批；共享 tool result 不代表共享私有记忆。
- tmux：当前仅 watcher/view；未来可以承担自有交互进程终端承载，尚未实现 managed host。
- TaskRunner：保留 cloud Attempt admission。现有 AgentHome lease manager 计数与 TaskRunner cap 分工不同，单独 acquire 不证明跨 lane 排他。
- packages/server/cloud：同机协作不需要新增依赖；不替换远端派工。

## P2: Concrete Trace

已验证：operator commit challenge → native protocol 请求 turn → model 调 Team MCP read → authenticated local control → durable workspace → tool result 进入该 session → post reply → read → ack → 原生完成事件。第二轮复用同一进程及 session。

未存在的闭环：peer post commit → 确定接收方 native session/input ownership → 合并通知 → native turn acceptance → 完成/预算/暂停。探针由外部 driver 主动发送 turn，不是自动唤醒。

## P3: Decision and Trade-offs

保留通信核心，先做原生通知入口与目标交互形态验证。三种协议的两轮 MCP 集成均 PASS，因此没有证据支持消息层重写、额外 scheduler、通用插件框架或新 package。

tmux 复用终端能力有价值，但不能由此推导能安全控制正在审批/输入的 TUI。首选结构化 native queue/extension；失败应明确报告，不能静默 fallback 到 send-keys。capture-pane 不作为 ready、授权、投递或完成 authority。

10x 首先受全量 state、未读 backlog、重复通知/token 消耗影响。仅在实施明确契约时补 bounded read、稳定 caller request identity 和预算，不从正文猜语义、不承诺外部副作用 exactly-once。

## Verified Capability Boundary

| Harness | 本次实测版本 | native protocol launch | 同 session idle 两轮 | MCP attach/read/post/ack | TUI notify / restart resume |
|---|---|---|---|---|---|
| Claude | 2.1.261 | PASS stream-json | PASS | PASS | unverified |
| Codex | 0.153.4 | PASS app-server stdio | PASS | PASS | unverified |
| Pi | package-local 0.84.2 | PASS RPC | PASS | PASS | unverified |

macOS 实测；global Pi 0.84.4 不作为 SDK acceptance。6 回复、12 read、6 ack 的精确记录见 research evidence。没有测试 Linux/native Windows/WSL；没有把 headless 当作 interactive acceptance。

## Candidate Implementation Boundaries

以下是候选下一步，须以单独 scope/contract 固定，不是已获准的重构列表：

1. **原生通知探针**：在自有目标 session 验 Codex queue、Pi extension/RPC 与 Claude 持续输入；区分 headless 与 TUI。只测 idle、busy、approval、人类草稿、错误状态，不修改产品。
2. **最小 local binding**：仅在入口证据充分后，连接 existing workspace 与 native session。绑定精确 member/agent/profileRevision/home/session/owner generation；重启 identity 不明拒绝第二 writer，不 adopt 用户 pane。
3. **长期运行契约**：共享 home admission、helper lease 续期/撤销、bounded read、发布重试和通知预算。每项须有具体失败场景与必要消费者，不一次性铺开。
4. **终端 host 与产品验收**：目标需要可见 CLI 时优先评估 tmux；按平台实际支持验证，不创建预支的 host plugin 架构。验三 harness 群、三对双向私信、非成员拒绝及 crash/restart。

自主建群/邀请、多 room、跨设备、现存 pane adopt 不在当前 slice。

## Invariants and Rollback

- 消息正文/成员/cursor 只有 TeamWorkspace authoring authority；pending 是可重建投影。
- accepted、native queue accepted、turn complete、ack、业务完成分别表示；ack 不等于业务成功。
- token 不进 argv/title/prompt/证据；配置隔离不是 OS sandbox。
- 超时不证明旧进程死亡；停止只清理自有进程，不 kill-server 或删除用户 home/session。
- 不通过 Ctrl-C/Ctrl-U 清人类输入，不通过屏幕推导 input ownership。
- 失败保留 durable 消息；有限重试、暂停和预算必须可观察。

## Discussion Provenance

现有 Claude/Fable 5.1 pane `%6`；持久讨论记录：
`/Users/kito/.claude/projects/-Users-kito-Projects-byok-sdk/77947b83-8e45-4dfd-9cbe-eedecf893af6.jsonl`。

共同结论：先复用现有通信层，三种 harness 都纳入验证；tmux 与通信分层。未采纳“acquire 同一 execution lease 就天然互斥”的说法，当前代码仍需共享 admission 证据。

RAFT 对照限于本地固定 `raft-daemon@1.0.16` tarball；扫描无 tmux 引用，Claude persistent JSONL、Codex app-server、Pi SDK 的形态提供复用方向，不证明本项目的交互终端需求。不得外推所有 RAFT 版本。

## Task Breakdown

- [x] 现有通信、view、home、TaskRunner 边界核对。
- [x] 与现有 Claude 讨论三 harness/tmux 方案。
- [x] 用户批准的 Team MCP + native same-session 两轮探针。
- [x] 记录实际 SDK control/store/helper 回执，清楚限定 headless evidence。
- [x] 将原大范围重构草稿收窄为集成与未验证缺口。
- [x] 用户批准的 native notify/TUI 状态探针已执行并记录通过/反例/受阻；不代表所有矩阵格通过。
- [ ] Claude busy/approval/TUI capability 验收受阻；provider refusal 后未重试。
- [ ] 产品实现前固定 Pi pending-interaction authority；isIdle 不能证明无 UI 确认。

## Verification Record

研究 verifier PASS：3 native sessions，6 exact durable replies，12 reads，6 covering acknowledgements。进程在完成后由 driver 终止，SIGTERM 是探针 cleanup。

本轮只加研究/探针/Draft 和明确 contract scope，不改产品代码、不切换 active plan、不 stage/commit/publish。保留原有其他 WIP。早前 repo-harness CLI export mismatch 本次 live strict workflow 已通过；未由本任务修工具链。文档与脚本静态检查、git diff --check 作为本轮最小充分验证，产品全套测试不适用。

## Native Notify Probe Ruling — 2026-09-06

- Codex 0.153.4：queue 的 idle/busy/MCP approval 三项通过；实际 TUI 草稿在 queue 执行期间未提交，随后显式 Enter 的 native userMessage 与原文相同。
- Pi package-local 0.84.2：实际 TUI followUp、工具内确认和草稿保留通过；但 idle 状态的 UI confirm 不阻挡新 turn。自动 binding 不能只检查 isIdle，也不能把一套扩展自己的 pending 标志当所有扩展的统一权威。
- Claude 2.1.261：本轮 idle print 通过；busy setup 遇 provider reasoning_extraction refusal（subtype success 但 is_error true），审批未测。隐藏 UDS TUI 尝试在 workspace trust 前置条件超时，无发送证据；未改模型或重写请求重试。
- 通信层保留，不实施通用 scheduler 或 tmux 键盘 fallback。Claude 仍是三 harness 自动协作验收缺口。
- 完整矩阵、P1/P2/P3、探针调整和清理边界见 `docs/researches/2026-09-05_cross-harness-probe.md` 后半部。`verify-notify.py` 的 PASS 只证明证据一致性，不把受阻格升级为通过。

## Claude Continuation Result — 2026-09-06

一次同配置/同请求重验仍在 busy setup 收到 provider reasoning_extraction refusal；idle 再次通过，busy/approval 仍未建立能力证据。停止后续模型请求。

独立无模型 TUI 启动检查通过：显式信任自有临时目录后，MCP child 收到 native socket/auth metadata。startup 前置条件已闭合；未发送 UDS 消息，因此 TUI notify/draft 仍未验证。只有临时项目 trust entry 被 native exact-path purge 清理，不修改现有项目。

剩余阻塞以 research 中 request ID 和 `claude-notify-recheck-results.json` 为入口。重复批准不是 provider 恢复证据；不再通过重复同类探针消耗预算。
