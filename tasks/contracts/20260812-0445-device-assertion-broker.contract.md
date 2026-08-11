# Task Contract: device-assertion-broker

> **Status**: Active
> **Plan**: plans/plan-20260812-0445-device-assertion-broker.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 04:46
> **Review File**: `tasks/reviews/20260812-0445-device-assertion-broker.review.md`
> **Notes File**: `tasks/notes/20260812-0445-device-assertion-broker.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

host 同装自家 CLI 与 daemon,需要「配对一次两者授权、撤销一次同死」。缺口:client 无任何公开 control 入口。做错的风险极高——这是新的本地认证面:shutdown 铸币窗口、「同步失效」过度宣称、公开面失控、域混淆任一疏漏都是真实安全洞。设计轮(deep-reasoner, HIGH confidence)已定案,orchestrator 批注采纳。不触碰 runtime CLI 凭证隔离铁律(daemon 自己的 device 密钥,非 ~/.claude 等)。

## Goal

daemon 经既有 authenticated control socket 提供 `assertion.issue`:六道 fail-closed 闸(disabled/params/audience/shutting_down/revoked/not_paired),用 device 私钥现读现签 `byok-device-assertion-v1\n` 域分隔的 canonical claims(version/issuer/productId/deviceId/audience 单值/jti 128bit/iat/exp),TTL 默认 120s 硬上限 300s。core 导出信封 + `verifyDeviceAssertion`(revoked 为必传参数)+ golden 冻结。client 唯一新公开导出 `requestDeviceAssertion`(绝不导出 control client)。审计单一 `device-assertion` kind,签名/信封字节不进事件。功能默认关闭(audiences 空)。对基点(codex/result-document-channel)之外的 packages/protocol/server/cloud/cloud-postgres、deploy、scripts 零 diff。

## Scope

- In scope: packages/core/src/(device-assertion 信封/verify/golden/测试)、packages/client/src/(control-protocol、create-daemon、observer、bin/audit-log、新 assertion-client、index 导出、测试)、docs/。
- Out of scope: host 侧 exchange 路由、product session 语义、jti 重放缓存、device→账号映射、audience 命名注册表、通用 credentials.get、runtime CLI 凭证、TLS。
- Taste constraints: 签名信封克隆 attestation 机制(canonicalize + golden);六道闸顺序固定且注释;审计走结构性隔离非事后脱敏。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if 实现需要缓存或导出 device 私钥、或需要 audience 前缀匹配才能满足消费方——两者都推翻设计前提,回报。

## Falsifier

先写域分隔测试:`byok-device-assertion-v1\n` 与 `byok-nonce-v1\n`、`byok-device-proof-v1\n` 两两不等且互不为前缀;一个 nonce 签名过不了 verifyDeviceAssertion,反之亦然。若任一为另一前缀,域设计错误,STOP。

## Root Cause Evidence

n/a (not bugfix)

## Workflow Inventory

- Source plan: `plans/plan-20260812-0445-device-assertion-broker.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0445-device-assertion-broker.review.md`
- Notes file: `tasks/notes/20260812-0445-device-assertion-broker.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/core/src/
  - packages/client/src/
  - docs/
  - plans/plan-20260812-0445-device-assertion-broker.md
  - tasks/todos.md
  - tasks/contracts/20260812-0445-device-assertion-broker.contract.md
  - tasks/reviews/20260812-0445-device-assertion-broker.review.md
  - tasks/notes/20260812-0445-device-assertion-broker.notes.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/core/src/device-assertion.ts
    - packages/client/src/daemon/assertion-client.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260812-0445-device-assertion-broker.notes.md
  commands_succeed:
    - pnpm --filter @byok-sdk/core run typecheck
    - pnpm --filter @byok-sdk/core run test
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/client run test
    - git diff --quiet fcbf2aa170ed4a0c428b93f1086faea5ce428e71 -- packages/protocol packages/server packages/cloud packages/cloud-postgres deploy scripts
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: 六道闸各自独立拒发且顺序固定;audience 白名单精确(前缀攻击拒);TTL>300s 构造期抛;签发成功 audit.jsonl 不含签名/信封 substring 但含元数据。
- Edge cases: revoked 三分支(not_paired/isRevoked/shutting_down);跨域签名互不通过;并发双发 jti 不同;params 五负向、配置五负向。
- Regression risks: control socket 既有方法零行为变化;凭证隔离审计零命中;private 密钥无缓存无导出。

## Rollback Point

- Commit / checkpoint: `fcbf2aa170ed4a0c428b93f1086faea5ce428e71`(栈于 result-document 分支)
- Revert strategy: revert;默认关闭,零迁移。
