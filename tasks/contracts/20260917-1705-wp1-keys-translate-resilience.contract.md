# Task Contract: wp1-keys-translate-resilience

> **Status**: Active
> **Plan**: plans/plan-20260917-1705-wp1-keys-translate-resilience.md
> **Task Profile**: bugfix
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 17:08
> **Review File**: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md`
> **Notes File**: `tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why
Owner ruling (2026-09-17, execution-layer ownership exception): lowpriv lane's last red is a pre-existing product bug — WINDOWS_PROJECTION_ACL_SCRIPT translates every ACE identity eagerly; SystemRoot carries identities a non-privileged token cannot translate, so the owner-mismatch typed refusal never fires (admin tokens translate them, masking it in #193's gate).

## Goal
Per-ACE resilient sid resolution in the script (~6 lines): SecurityIdentifier passthrough, Translate in try/catch, failure -> sid=$null. Node validator unchanged and fail-closed (sid=null -> pi_projection_acl_invalid_ace); SystemRoot under lowpriv yields pi_projection_owner_mismatch. Local gates green; round-5 CI to validate warm-up + fix together.

## Scope

- In scope: packages/keys/src/pi-provider-launcher-core.ts (script string only), packages/keys/src/__tests__/** (script-text pins if any), plan/contract trio, tasks/todos.md.
- Out of scope: Node-side validation semantics, pi-projection-windows.test.ts expectations, other product code, vendored tree, CI workflow, push (orchestrator does the gate + push).

## Stop Conditions
- Stop if passing requires changes beyond the script's sid resolution or its direct test pins.
- Stop if Node-side validation would need weakening for sid=null.
- Stop and report if an Exit Criteria command cannot run here.

## Falsifier
If the owner-mismatch test goes green by loosening assertions or bypassing the script (not by resilient translation), the round-5 CI + gate diff review catches it; if sid=$null ever validates as an authorized ACE, the fail-closed contract is broken and the gate fails.

## Root Cause Evidence

- root_cause: pi-provider-launcher-core.ts WINDOWS_PROJECTION_ACL_SCRIPT rules loop (~:261) eagerly calls $_.IdentityReference.Translate($sidType); SystemRoot DACL contains identities untranslatable by a non-privileged token, throwing MethodInvocationException before the owner check is reportable.
- repro: Windows CI lowpriv lane, keys suite `refuses the real Windows directory owner rather than the current token` (queries SystemRoot); round-4 run 35200434840 job 105133623925.
- regression_guard: packages/keys/src/pi-projection-windows.test.ts (Windows CI lowpriv lane).
- pre_fix_failure_artifact: round-4 job log (notes transcription in tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md).

## Workflow Inventory

- Source plan: `plans/plan-20260917-1705-wp1-keys-translate-resilience.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md`
- Notes file: `tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md`
- Scope gate: edit only paths listed under `allowed_paths`.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260917-1705-wp1-keys-translate-resilience.md
  - tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md
  - tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md
  - tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md
  - packages/keys/src/pi-provider-launcher-core.ts
  - packages/keys/src/__tests__/
  - tasks/todos.md
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
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260917-1705-wp1-keys-translate-resilience.md
  artifacts_exist:
    - tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "全仓类型绿（script 是字符串常量，类型面不变）。",
      "inputs": {"env": []}
    },
    {
      "id": "keys-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/keys test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "keys 包既有测试全绿（windows 专属文件在 darwin 自跳过；行为验证在 round-5 CI lowpriv lane）。",
      "inputs": {"env": []}
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "公共 API 面不变。",
      "inputs": {"env": []}
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "版本权威未被触碰。",
      "inputs": {"env": []}
    },
    {
      "id": "resilient-sid-present",
      "kind": "command",
      "command": "grep -c 'Translate($sidType)' packages/keys/src/pi-provider-launcher-core.ts | grep -qE '^[1-9]' && grep -A3 'is \\[System.Security.Principal.SecurityIdentifier\\]' packages/keys/src/pi-provider-launcher-core.ts | grep -q 'Translate'",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "脚本内存在 SecurityIdentifier 直取 + try/catch Translate 的容错路径。",
      "inputs": {"env": []}
    },
    {
      "id": "vendored-zero-byte",
      "kind": "command",
      "command": "git diff --quiet d4dcf961 -- packages/client/vendor/ && echo VENDORED_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "vendored 树零字节改动。",
      "inputs": {"env": []}
    },
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": {"env": []}
    }
  ]
}
```

## Acceptance Notes (Human Review)

- Changed behavior/boundary: PS 脚本内每条 ACE 的 sid 解析容错；Node 校验零改动、fail-closed 不变（sid=null -> pi_projection_acl_invalid_ace）。
- Coverage: 行为判据在 round-5 CI lowpriv lane（4/4 期望绿）；本地跑 typecheck/keys/api-surface/version-authority + 结构 grep。
- Execution/baseline: 基线 d4dcf961（keys 字节当前与之一致），期望 diff 仅 script 字符串与可能的 pin 测试。
- Residual risks: SystemRoot 上仍有可翻译 ACE 全部照常返回；若存在第四种身份类别（如 NTAccount 解析成功但非 SID 形态）—— Translate 输出即 SID string，无此风险。

## Rollback Point

- Commit / checkpoint: 分支 claude/wp1-windows-ci-on-193 @ 25a4efc1（keys 与基线字节一致）。
- Revert strategy: revert 本切片 commit 即回基线字节；无其他面需要清理。
