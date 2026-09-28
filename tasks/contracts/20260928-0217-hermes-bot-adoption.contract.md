# Task Contract: Hermes Bot Adoption First-Wave Coordination

> **Status**: Active
> **Plan**: plans/plan-20260928-0217-hermes-bot-adoption.md
> **Task Profile**: code-change
> **Owner**: root dispatch coordinator
> **Capability ID**: root
> **Review File**: tasks/reviews/20260928-0217-hermes-bot-adoption.review.md
> **Notes File**: tasks/notes/20260928-0217-hermes-bot-adoption.notes.md

## Why

用户明确要求「落plan派工」。已有Hermes源码研究表明可借鉴记忆/身份/工具机制，但BYOK prepared lane现行契约排除reserved memory helper。先用一份有界机制交付明确实现条件，防止Host UI依赖不可达工具或增加第二authority。

## Goal

完成用户已批准的 WP1-I SDK prepared memory 闭环，并保留此前研究/规划/设计证据。当前交付为隔离工作树中的可核验 source 与本地 required checks；Host adoption、native tools、registry 和部署不在此 implementation slice。

### Approved follow-up: WP1-I-E expression gate

用户随后「批准」上一轮明确提出的 memory-only descriptor 表达能力验证。当前追加切片是源码追踪、严格协议探针与最小反例；交付追加到现有 SDK design、plan、notes/review，不改变八个 tracked allowed paths。忽略的 `_ops/hermes-memory-expression-gate/` 只保存本地探针和证据。允许读取 source-identical 原 checkout 的现有依赖来运行纯协议探针，不写该 checkout，不安装或修复依赖，不调用 provider/helper/memory。若当前契约不能表达 SDK-owned capability，交付准确缺口后结束本验证，不越过既定 falsifier 实施新 wire。

### Approved follow-up: WP1-I-C contract amendment

用户再次「批准」明确提出的 memory-only 契约修订。允许新增 `docs/researches/2026-09-28-prepared-agent-memory-contract.md` 并在 `docs/spec.md`、`docs/protocol.md` 标明待实现的版本切换契约；选择、准入、implementation identity、task-free descriptor、seal和claim后授权必须同一闭合。当前协议/产品代码仍不修改，不借设计批准宣称能力已启用。root独占全部文档写入；explorer只读。Claude规划会话提供设计咨询；最终裁定由source与root负责。忽略的 `_ops/hermes-memory-contract/` 保存咨询与本地检查证据。

### Approved follow-up: WP1-I-R operator retirement command

WP1-I acceptance gate FAIL（2026-09-28）指出 C6/验收第 7 条的 operator retirement 未实现也未登记延后；用户裁定「放进 WP1-I 实现」。追加范围：实现 operator 显式调用的一次性 `byok-agent` 子命令，把非当前 record version 的 `input-preparation/` 命名空间整体移入 store 内退役证据目录并写 manifest（各版本计数、records.jsonl sha256、artifact hash 清单）；不删除、不转换、不前向读取旧记录（结构化只读 version/pin 字段，不经 `replay()`）；默认只读列出/计数，`--yes` 才执行；daemon control online 或 owner lease 被占用即拒绝（复用 `doctor` 角色，不改 `daemon-owner.ts`）；任何 pin、混入当前版本、不可解析或未知版本即整体拒绝；路径限定在 storeDir，绝不触碰 Agent home/memory；严格启动拒绝保持不变。仅实现与测试，不对任何真实 store 执行。

### Approved follow-up: WP2-I-D device memory CAS transport design

用户经 Codex w2:pR 正式派发（2026-09-28）：补齐 WP2-I Host Bot 记忆提议生命周期所缺的 SDK device CAS 传输契约，交付可由 Owner 裁定的方案。仅研究与设计授权：不是 WP2-I 产品实现、发布或真实 store 操作授权。写入只限计划/研究/contract/notes/review 文档；新增 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md` 承载字段级契约，更新 `docs/researches/2026-09-28-hermes-host-lifecycle-design.md` 的 WP2-I 一节。SDK/Salesko 产品 source、tests、配置与真实数据只读。探索者只读；单一文档写入者；不 commit/push。

### Approved follow-up: WP2I-S1 protocol/core implementation

Owner 原话（2026-09-28，经 Codex w2:pR 转达）：「批准。与Claude讨论下一刀并派工」。Owner 未逐项提交问卷；以下映射是 Codex w2:pR 与 Claude w2:pT 协商后对该批准的解读：R3 = read 消费方向（作为后续 WP2I-H3 的目标；Salesko 当前运行事实仍为 `agentMemory: none`，本包不启用 read）；R16 = A release-time grant；R2 仅 lease 互斥，不承诺 next-turn-only；R5/WP2I-H3 的 Turn 暂缓只服务 liveness；R4 terminal purge、R6 canonical owner、R7 有限 forget、R9 用户 UI 起步、R10 `notes/host-<slug>.md`、R11 新 proposal 新审批且禁自动 rebase，均按已验收裁定表推荐记录。WP2-I-D 的 DESIGN ACCEPTED 保留；实现另需证据。

本包只实现 WP2I-S1：`docs/researches/2026-09-28-hermes-device-memory-cas-contract.md` 字段表中的 protocol/core schema 与 `operationDigest`，message/envelope/codec/capability/export 登记，两份新测试、两份 protocol golden、protocol/core API surface。单一 Claude 执行 worker 独占下列 S1 路径，coordinator 独占六份协调文档，二者不写同一文件。不改 package.json、client、cloud、server、Salesko、docs/protocol.md 或其他路径；保留 WIP 与 PR #239。R16=A：不引入 `releaseNotAfter`、`releaseDigest`、`release_expired`。R10 属 Host 路径政策，S1 不放宽 SDK 现有 path 安全边界。不启用 capability 或 memory helper，不 commit/push/PR/merge/release，不启动 S2/S3/H1–H3。

停点：既有 golden 条目任何变化；需要改 client/cloud/server/package.json；digest 不能复用既有 `canonicalizeJson`/content digest 原语；schema 需偏离已验收字段表；真实并发文件冲突；任何检查失败按每问题三轮 fail→fix→reverify 上限。

### Approved follow-up: WP2I-S2 SDK client implementation

用户在 w2:pT 直接指示「启动派工」（2026-09-28），作为 WP2I-S1 ACCEPTED 之后「下一刀 = WP2I-S2」建议的执行授权。本包只实现 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md` 的 WP2I-S2 行：daemon 侧 `agent.memory.intent.available` processor、`.byok/agent-memory-intents-v1.json` apply ledger（count-based reservation、windows 1–3、terminal 与 `ackedAt` durable barrier）、非 task 的 home-binding CAS 入口、capability 条件 advertise、Host transport hook 接口；plain-data snapshot 从 provider-provisioning 移出供两处复用。S1 验收转交的约束全部生效：无本地行 terminal-fetch 只接受 `host_terminal`/`recorded`/`idempotent`（`conflict` → `readback_invalid`，不 ack，零 ledger 写）；readback `conflict` 与 completion `conflict` 分别有正负用例；replace release 校验 `sha256(utf8(content)) === targetRevision`；`applied` 按 operation 校验（replace：`exists=true` 且 `revision === targetRevision`；delete：`exists=false` 且 `revision === sha256(empty)`，`targetRevision` 为 null），不重读当前文件推翻历史 receipt，不由 hash 推断 provenance；负控断言具体 issue path。

单一 Claude 执行 worker 独占下列 S2 路径；coordinator 独占六份协调文档；S1 源码文件本包不改（若必须改，停并报告，S1 verdict 随之作废）。不改 cloud、server、docs、package.json、Salesko；不启用任何真实 Host transport、不对真实 store 执行；不 commit/push/PR。WP2I-S3 不在本包（`docs/protocol.md` 与 PR #239 重叠，另行派工）。

停点（沿用设计 WP2I-S2 行 ①–⑤）：① 需放宽 `AgentMemoryTaskContext`；② 未能对 native 与 helper 两后端证明「conflict ⇒ 无 rename」（未证明的后端 conflict 映射 `uncertain`）；③ `AgentMemoryError` 无法用 typed 子类区分确定性失败与 I/O 失败（禁止解析 message）；④ 实测最大记录 + 分隔符 > `R_MAX`；⑤ ledger 写入无法证明 file fsync + rename + directory fsync 全部成功（该文件系统或 helper 后端不得 advertise）。另加：需要改 S1 源码、cloud/server/package.json；真实并发文件冲突；每问题 fail→fix→reverify 三轮上限。

### Approved follow-up: WP2I-S2 identity-gate fix

Codex w2:pR 裁定（2026-09-28）：`57aebf9f…` 最终 NOT ACCEPTED（identity-binding blocker），采用方案 A。只有与本机 enrollment 和 notice 绑定的 canonical intent 才能产生可持久化的 device completion。`validateRelease` 与 `validateWithheld` 先核对 intent `agentId`/`profileRevision` 等于 notice，再以本机 tenant/device 重算 `operationDigest`；任何身份或 digest 不符 → `fetch_invalid`，零 ledger、零 target CAS、零 completion、不 ack。content-only 缺陷同样先过该门。门后才允许 `path_invalid`/`content_invalid`/`memory_md_not_deletable` 或合法 withheld Host code 的 rejected。S1 两枚 rejection code 原样保留，无兼容消费路径。唯一写入者仅写 `packages/client/src/daemon/agent-memory-intent.ts` 与 `packages/client/src/__tests__/agent-memory-intent.test.ts`；公开 API 若需变化先停。不放宽 Host，不新增 terminal 或 operator 方法，不改 S1。此为 S2 第三次候选 gate、identity 问题首次修复；仍不通过则报告最小反例，不自动进入第四轮。

### Approved follow-up: WP2I-S3 SDK cloud notice producer + docs

依据用户 2026-09-29「批准」（经 orchestrator 派工）：实现 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md`「实施工作包」的 WP2I-S3 行。范围：`ByokCloud.enqueueAgentMemoryIntentNotice(tenant, deviceId, { intentId, agentRef })`，形同 §2.3 provisioning notice 的 producer：先用 S1 `AgentMemoryIntentAvailablePayloadSchema` 严格解析，再以既有 `assertAgentCapabilities` 读 durable device 行（无 `agent-memory-intent.v1`、行缺失或 revoked → `agent_capability_missing`，零 mailbox 行），再经既有 `enqueueAgentControlEnvelope` 以 `uuidFromSha256({domain:'byok:agent-memory-intent-notice', tenant, deviceId, intentId})` 为 messageId 追加，重试复用同一行与 seq；同一 intent 换 `agentRef` 的重试 → `mailbox_receipt_mismatch`。不新增门控机制、不记 cloud intent receipt（approval/release/completion/readback 属 Host）。文档：`docs/protocol.md` 新 §2.4 与 §2 catalog 一行、`docs/spec.md` Durable Agent homes 一段，只写 S1/S2/S3 已实现行为；`api-surface/cloud.d.ts` 用仓库 `check:api-surface -- --update` 重生，仅 additive。

单一 Claude 执行 worker 独占：`packages/cloud/src/cloud.ts`、`packages/cloud/src/index.ts`（仅导出 `AgentMemoryIntentNoticeInput`）、新 `packages/cloud/src/__tests__/agent-memory-intent-notice.test.ts`、`docs/protocol.md`、`docs/spec.md`、`api-surface/cloud.d.ts`，以及本 contract 与 notes 的 S3 条目。plan 复选框由 orchestrator 验收后勾选。S1（protocol/core）与 S2（client）源码冻结；不改 server、package.json、Salesko；不 push/PR/merge/tag/版本号/发布。

停点：需要改 S1 schema（即作废已验收 S1）；需要改 client/protocol/core/package.json；需要新的门控机制或第二 authority；文档需描述未实现行为；任何检查失败最多两轮 fix，源码修复后重新冻结 subject。

## Scope

- In scope: User approved WP1-I full SDK memory-only implementation under the accepted WP1-I-C contract. Implement protocol v8, descriptor/identity, prepared counting/sealing/runtime binding, operation ACL and focused regressions; run required checks in this isolated worktree. Dependencies may be installed using the frozen lockfile here.
- Out of scope: Host UI/proposals, native tools, external repo writes, release/deployment, executing retirement against any real store, commits/pushes, unrelated failures and original WIP. Prior docs-only boundaries apply only to their historical slices and are superseded here for explicitly listed implementation paths.
- Safe path: /Users/kito/Projects/byok-sdk-wt-hermes-bot-adoption only. Preserve original checkout and all prior docs. No destructive cleanup or production operation.
- Concurrent ownership: identity worker owns only listed implementation-identity files; helper worker owns only listed helper/descriptor files; root owns remaining protocol/integration/docs. Ownership handoff is sequential.

## Stop Conditions

- Maximum three fix/reverify rounds per issue; report unrelated failures without expanding scope.
- No compatibility/default mode/old wire read; no missing attestation represented as passed. If the approved contract cannot be implemented, provide the concrete counterexample.
- No provider/DB invocation, publication or deployment. No edits outside explicit allowed paths without updating this contract first.

## Falsifier

若source证明现有链路已完整覆盖所拟新增能力，改交复用路径与验证面，不再建议重复实现。若无法在当前sealed/accounting/身份契约下表达候选链，明确阻断点而非兼容fallback。

## Allowed Paths

```yaml
allowed_paths:
  - api-surface/client.d.ts
  - api-surface/protocol.d.ts
  - api-surface/cloud-dataplane.d.ts
  - api-surface/keys.d.ts
  - api-surface/implementation-identity.d.ts
  - api-surface/core.d.ts
  - api-surface/ui-runtime.d.ts
  - api-surface/cloud.d.ts
  - api-surface/server.d.ts
  - packages/client/src/__tests__/pi-adapter.test.ts
  - packages/client/src/__tests__/prepared-agent-memory-runtime.test.ts
  - packages/client/src/__tests__/agent-memory-embedded-entry.test.ts
  - packages/client/src/__tests__/reserved-mcp-wire-regression.test.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/prepared-agent-memory.ts
  - packages/client/src/mcp/client.ts
  - packages/client/src/__tests__/prepared-memory-lifecycle.test.ts
  - plans/plan-20260928-0217-hermes-bot-adoption.md
  - docs/spec.md
  - docs/protocol.md
  - docs/researches/2026-09-28-prepared-agent-memory-contract.md
  - tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md
  - tasks/notes/20260928-0217-hermes-bot-adoption.notes.md
  - tasks/reviews/20260928-0217-hermes-bot-adoption.review.md
  - tasks/contracts/20260928-hermes-prepared-memory-design.contract.md
  - tasks/contracts/20260928-hermes-host-lifecycle-design.contract.md
  - docs/researches/2026-09-28-hermes-prepared-memory-design.md
  - docs/researches/2026-09-28-hermes-host-lifecycle-design.md
  - packages/protocol/src/input-preparation.ts
  - packages/protocol/src/messages.ts
  - packages/protocol/src/http-api.ts
  - packages/protocol/src/index.ts
  - packages/protocol/src/version.ts
  - packages/client/src/input-preparation.ts
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/daemon/input-preparation-remote.ts
  - packages/client/src/daemon/input-preparation-service.ts
  - packages/client/src/daemon/input-preparation-store.ts
  - packages/client/src/daemon/prepared-tool-surface.ts
  - packages/client/src/daemon/prepared-offer-admission.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/tool-implementation-identity.ts
  - packages/client/src/daemon/agent-memory.ts
  - packages/client/src/types.ts
  - packages/client/src/adapters/pi/input-preparation.ts
  - packages/client/src/adapters/pi/prepared-tools.ts
  - packages/client/src/adapters/pi/prepared-session.ts
  - packages/client/src/adapters/pi/mcp-server-pool.ts
  - packages/client/src/adapters/pi/pi-adapter.ts
  - packages/client/src/bin/pi-prepared-host.ts
  - packages/client/src/daemon/index.ts
  - packages/implementation-identity/src/identity.ts
  - packages/implementation-identity/src/index.ts
  - packages/implementation-identity/src/spawn-binding.ts
  - packages/implementation-identity/src/__tests__/sdk-memory-identity.test.ts
  - packages/client/src/bin/agent-memory-mcp-server.ts
  - packages/client/src/bin/sdk-reserved-helper-runners.ts
  - packages/client/src/bin/byok-agent-memory-describe.ts
  - packages/client/src/sdk-reserved-helper-host.ts
  - packages/client/src/daemon/resolve-agent-memory-mcp-bin.ts
  - packages/client/src/agent-memory/prepared-capability.ts
  - packages/client/src/mcp-server/index.ts
  - packages/client/tsup.config.ts
  - packages/client/src/__tests__/prepared-agent-memory.test.ts
  - packages/client/src/__tests__/agent-memory-describe.test.ts
  - packages/client/src/__tests__/agent-memory-mcp.test.ts
  - packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
  - packages/client/src/__tests__/agent-memory-entry-constraints.test.ts
  - packages/client/src/__tests__/fixtures/reserved-mcp-wire-baseline.json
  - packages/cloud/src/input-preparations.ts
  - packages/cloud/src/handlers/input-preparations.ts
  - packages/server/src/relay.ts
  - packages/protocol/src/__tests__/freeze-guard.test.ts
  - packages/protocol/src/__tests__/golden/v1.envelopes.ndjson
  - packages/protocol/src/__tests__/golden/v1.frozen.json
  - packages/protocol/src/__tests__/input-preparation.test.ts
  - packages/protocol/src/__tests__/envelope-roundtrip.test.ts
  - packages/protocol/src/__tests__/envelope-field-requirements.test.ts
  - packages/cloud/src/__tests__/input-preparations.test.ts
  - packages/cloud/src/__tests__/agent-home-contract.test.ts
  - packages/cloud/src/__tests__/prepared-offer-enqueue.test.ts
  - packages/cloud/src/__tests__/mailbox-cursor.test.ts
  - packages/protocol/src/__tests__/mcp-toolsets.test.ts
  - packages/client/src/__tests__/prepared-offer-lane.test.ts
  - packages/client/src/__tests__/salesko-mcp-e2e.test.ts
  - packages/client/src/__tests__/create-daemon-mcp-launch-cwd.test.ts
  - packages/client/src/__tests__/prepared-launch-response-timing.test.ts
  - packages/client/src/__tests__/assertion-client.test.ts
  - packages/client/src/__tests__/pi-s2-bundle-resolution.test.ts
  - packages/client/src/__tests__/input-preparation-control.test.ts
  - packages/client/src/__tests__/tool-implementation-spawn-gate.test.ts
  - packages/client/src/__tests__/input-preparation-message-support-set.test.ts
  - packages/client/src/__tests__/pi-prepared-launcher.test.ts
  - packages/client/src/__tests__/real-cloud-salesko-mcp-e2e.test.ts
  - packages/client/src/__tests__/pi-runtime-launch-cwd.test.ts
  - packages/client/src/__tests__/prepared-tool-surface.test.ts
  - packages/client/src/__tests__/task-assertion-broker.test.ts
  - packages/client/src/__tests__/control-protocol.test.ts
  - packages/client/src/__tests__/input-preparation-remote.test.ts
  - packages/client/src/__tests__/unknown-message-type-tolerance.test.ts
  - packages/client/src/__tests__/input-preparation-model-parity.test.ts
  - packages/client/src/__tests__/journal-offer-family.test.ts
  - packages/client/src/__tests__/input-preparation.test.ts
  - packages/client/src/__tests__/mcp-toolsets.test.ts
  - packages/client/src/__tests__/strict-agent-only.test.ts
  - packages/client/src/__tests__/input-preparation-store.test.ts
  - packages/client/src/__tests__/pi-prepared-tools.test.ts
  - packages/client/src/__tests__/fixtures/prepared-tool-surface.ts
  - packages/client/src/__tests__/fixtures/prepared-offer-restart-daemon.ts
  - tasks/contracts/20260928-hermes-memory-identity.contract.md
  - tasks/contracts/20260928-hermes-memory-helper.contract.md
  - packages/client/src/daemon/input-preparation-retirement.ts
  - packages/client/src/bin/commands/retire-input-preparation.ts
  - packages/client/src/bin/byok-agent.ts
  - packages/client/src/__tests__/input-preparation-retirement.test.ts
  - packages/client/src/__tests__/retire-input-preparation-command.test.ts
  - packages/cloud/src/cloud.ts
  - packages/cloud/src/capabilities.ts
  - tasks/todos.md
  - docs/researches/2026-09-28-hermes-device-memory-cas-contract.md
  - packages/protocol/src/agent-memory-intent.ts
  - packages/protocol/src/messages.ts
  - packages/protocol/src/envelope.ts
  - packages/protocol/src/codec.ts
  - packages/protocol/src/version.ts
  - packages/protocol/src/index.ts
  - packages/protocol/src/__tests__/agent-memory-intent.test.ts
  - packages/core/src/agent-memory-intent.ts
  - packages/core/src/index.ts
  - packages/core/src/__tests__/agent-memory-intent.test.ts
  - packages/core/src/__tests__/constraints.test.ts
  - packages/client/src/daemon/agent-memory.ts
  - packages/client/src/daemon/agent-memory-intent.ts
  - packages/client/src/daemon/plain-data-snapshot.ts
  - packages/client/src/daemon/provider-provisioning.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/agent-home.ts
  - packages/client/src/index.ts
  - packages/client/src/__tests__/agent-memory-intent.test.ts
  - packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
  - packages/client/src/daemon/observer.ts
  - packages/client/src/bin/format.ts
  - packages/client/src/bin/audit-log.ts
  - packages/cloud/src/index.ts
  - packages/cloud/src/__tests__/agent-memory-intent-notice.test.ts
  - docs/protocol.md
  - docs/spec.md
  - api-surface/cloud.d.ts
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260928-0217-hermes-bot-adoption.md
    - tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md
    - tasks/notes/20260928-0217-hermes-bot-adoption.notes.md
    - tasks/reviews/20260928-0217-hermes-bot-adoption.review.md
    - tasks/contracts/20260928-hermes-prepared-memory-design.contract.md
    - tasks/contracts/20260928-hermes-host-lifecycle-design.contract.md
    - docs/researches/2026-09-28-hermes-prepared-memory-design.md
    - docs/researches/2026-09-28-hermes-host-lifecycle-design.md
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "required-0",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required frozen implementation verification.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "required-1",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required frozen implementation verification.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "required-2",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required frozen implementation verification.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "required-3",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required frozen implementation verification.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "required-4",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required frozen implementation verification.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "required-5",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required frozen implementation verification.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes

Current WP1-I acceptance requires the approved contract's negative cases, no wire v7 reader/default, source checks and required project checks on the frozen implementation. Historical documentation receipts are not implementation evidence. Product activation and Host adoption remain separate.

## Rollback Point

Preserve the original checkout. Review/revert only explicitly owned implementation changes if requested; do not automatically reset or remove prior files.
