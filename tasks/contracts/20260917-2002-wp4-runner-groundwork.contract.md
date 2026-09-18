# Task Contract: wp4-runner-groundwork

> **Status**: Fulfilled
> **Plan**: plans/plan-20260917-2002-wp4-runner-groundwork.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-18 00:15
> **Review File**: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md`
> **Notes File**: `tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why
WP3 (20260917-1628, gate PASS @ 772c08e1) registered two debts and left the S2 five-edge enablement to WP4. Debt 1: the SDK-minted custody commitments BYOK_SDK_CUSTODY_PARENT_DEPTH / BYOK_SDK_CUSTODY_LAUNCH_RECORD are unregistered launch lifecycle names, so the runner lane's future attested env re-verification fails closed on them. Debt 2: no same-bundle runner preset entry exists (helper runner branch throws 'not enabled'); plan 1459 stages WP4 as print entry [done] -> same-bundle runner -> five-edge one-shot enablement.

## Goal
A: the two custody names registered in TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES with the client-side exact pin updated in the same slice. B: a same-bundle runner preset entry (custody/pi-subagent-runner-entry.ts) reachable only via the direct `__byok_sdk_helper pi-subagent-runner` shape, with cross-platform direct-invocation coverage; helper runner branch routes to it. **This cut does NOT claim five-edge production enablement** — no vendor reroute, no seam presetting, no dispatcher routing beyond the helper branch.

## Scope

- In scope: packages/implementation-identity/src/identity.ts (enumeration + doc), packages/client/src/__tests__/tool-implementation-identity.test.ts (pin), packages/client/src/custody/** (runner entry, optional shared extraction), packages/client/src/sdk-reserved-helper-host.ts (runner branch), packages/client/src/__tests__/ (runner entry test, helper host pin), trio, tasks/todos.md.
- Out of scope: vendored tree, node_modules, vendor spawn sites (execution.ts / async-execution.ts / pi-spawn.ts), CI/workflow (WP1 face), push, maxDepth/assertion semantics, the print entry's POSIX-only seam preset.

## Stop Conditions
- Stop if the runner entry cannot reuse the print entry's validation core without duplicated authority; shared custody-entry helpers may be extracted under packages/client/src/custody/ in this slice instead.
- Stop if B would require vendor spawn-site or dispatcher routing changes (five-edge cut, not this one).
- Stop if any check command cannot run in this environment.

## Falsifier
Green arriving from a weakened path (stub writing the expected depth, skipped assertDescendantSpawn, or a vendor lane silently reaching the branch) disproves the claim; gatekeeper re-checks the pin family and the vendored-zero-byte diff.

## Workflow Inventory

- Source plan: `plans/plan-20260917-2002-wp4-runner-groundwork.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md`
- Notes file: `tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md`

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
  - plans/plan-20260917-2002-wp4-runner-groundwork.md
  - tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md
  - tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md
  - tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md
  - packages/implementation-identity/src/identity.ts
  - api-surface/implementation-identity.d.ts
  - packages/implementation-identity/src/__tests__/
  - packages/client/src/custody/
  - packages/client/src/sdk-reserved-helper-host.ts
  - packages/client/src/__tests__/
  - tasks/todos.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260917-2002-wp4-runner-groundwork.md
    - packages/client/src/custody/pi-subagent-runner-entry.ts
  artifacts_exist:
    - tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "identity-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/implementation-identity test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "共享包（枚举变更面）既有测试全绿。",
      "inputs": {"env": []}
    },
    {
      "id": "client-pin-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/client test -- src/__tests__/tool-implementation-identity.test.ts src/__tests__/sdk-reserved-helper-host.test.ts src/__tests__/custody-pi-subagent-runner-entry.test.ts src/__tests__/custody-charge-once-double-charge.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "A 的客户端 pin + B 的入口/helper 分支/回归 guard 四面同批绿。",
      "inputs": {"env": []}
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "全仓类型绿。",
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
      "necessity": "公共 API 面变更受控。",
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
      "id": "vendored-zero-byte",
      "kind": "command",
      "command": "git diff --stat 772c08e1..HEAD -- packages/client/vendor/ packages/client/node_modules/ && test -z \"$(git diff --stat 772c08e1..HEAD -- packages/client/vendor/ packages/client/node_modules/)\" && echo VENDORED_ZERO_BYTE",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "vendored 树与 node_modules 零字节改动。",
      "inputs": {"env": []}
    },
    {
      "id": "enumeration-exact",
      "kind": "command",
      "command": "/usr/bin/grep -q \"'BYOK_SDK_CUSTODY_LAUNCH_RECORD',\" packages/implementation-identity/src/identity.ts && /usr/bin/grep -q \"'BYOK_SDK_CUSTODY_PARENT_DEPTH',\" packages/implementation-identity/src/identity.ts && /usr/bin/grep -c 'BYOK_SDK_CUSTODY' packages/client/src/__tests__/tool-implementation-identity.test.ts | /usr/bin/grep -q '^[2-9]' && echo ENUM_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "两键注册 + 客户端 pin 同步（≥2 处出现）。",
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

- Changed behavior/boundary: enumeration registration (measurement projection) + runner preset entry behind the direct helper argv shape only. Five-edge production enablement explicitly NOT claimed; next-cut entrypoint = sdk-reserved-helper-host.test.ts runner pin family + vendor reroute per plan 1459 line 43.
- New test rationale: direct-invocation runner entry coverage incl. cross-platform spawn shape (no script association; the print entry's win32 gap stays in todos until the print seam is rerouted).
- Selected check IDs: identity-tests, client-pin-tests (four files same batch), typecheck, api-surface, version-authority, vendored-zero-byte, enumeration-exact, diff-whitespace. Full client suite runs in the gate phase if targeted set passes.
- Residual risks: shared-core extraction decision left to implementation (stop condition governs); runner entry target template semantics defined by the record, no dispatcher consumer yet.

## Rollback Point

- Commit / checkpoint: 772c08e1; revert this slice's commits restores WP3 acceptance state.
