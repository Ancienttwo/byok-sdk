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
