# Task Contract: issue-180-send-agent-message-grants

> **Status**: Active
> **Plan**: plans/plan-20260918-2229-issue-180-send-agent-message-grants.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-18 23:05
> **Review File**: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md`
> **Notes File**: `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Issue #180: the reserved `byokagentmessage` server is granted per adapter through `resolveReservedMcpToolGrants`, not through `PermissionPolicy.allowTools`. Codex consumes all reserved grants; claude filters them down to the memory server only, and pi has no reserved-grant path at all. A host task whose offer carries `messageEgress` can therefore satisfy a required Agent message only under codex — claude mounts the server but auto-denies its single tool; pi unregisters it under any emitted `--tools` allowlist.

## Goal

Claude and pi adapters grant the reserved `byokagentmessage.send_agent_message` tool from the shared pre-grant table exactly as codex does: claude emits it in the same `--allowedTools mcp__<server>__<tool>` shape it already emits for reserved memory grants; pi authorizes the bare tool name inside any `--tools` allowlist it emits. Absence of the server changes nothing; codex behavior is unchanged; the approval-channel server stays out of the pre-grant table.

## Scope

- In scope: `packages/client/src/adapters/claude/claude-adapter.ts` (drop the memory-only filter), `packages/client/src/adapters/pi/permission-mapping.ts` (reserved-grant allowlist merge), `packages/client/src/adapters/pi/pi-adapter.ts` (reserved grant resolution), the claude reserved-grant expectation in `packages/client/src/__tests__/toolset-mcp-grant.test.ts`, and a new `packages/client/src/__tests__/agent-message-reserved-grants.test.ts`.
- Also in scope, same grant path: `packages/client/src/bin/pi-rpc-host.ts` re-derives the expected delegated tool flags from `mapPermissionPolicyToPiArgs(config.policy)` and refuses any deviation ("delegated tool flags differ from policy"). Once the adapter folds reserved grants into the projection, policy alone can no longer reproduce it, and the real pi child would refuse to start with the exact projection the policy calls for; the host must re-derive the reserved grants from its own config (`config.mcp.mcpServers`, the same server projection the adapter resolved against). Its test `packages/client/src/__tests__/pi-rpc-host.test.ts` gains the reserved-server delegated-flags case. This is the pi adapter's own runtime host inside `packages/client/src/bin/`, not a protocol or daemon change.
- Out of scope: PermissionPolicy semantics, readonly native toolset widening, codex adapter behavior, daemon message-egress paths (already pinned runtime-agnostically by `agent-message-completion-gate.test.ts`), the pi prepared-input lane.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the pi fork's `--tools` flag governed only builtin tools and not extension-registered tools, appending reserved bare names to the allowlist would be the wrong mechanism. Cheapest proof: `@earendil-works/pi-coding-agent` `dist/core/agent-session.js` `_refreshToolRegistry` filters extension tools through the same `allowedToolNames` set as builtins — already read and confirmed at capture time.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/adapters/claude/claude-adapter.ts:218-219` filters `resolveReservedMcpToolGrants` output to `AGENT_MEMORY_MCP_SERVER_NAME`, and `packages/client/src/adapters/pi/pi-adapter.ts` `prepare()` never calls it, so `byokagentmessage.send_agent_message` is never granted on either runtime.
- repro: `bun test packages/client/src/__tests__/agent-message-reserved-grants.test.ts` on the unfixed tree (claude `--allowedTools` missing `mcp__byokagentmessage__send_agent_message`; pi `--tools` missing `send_agent_message`).
- regression_guard: `packages/client/src/__tests__/agent-message-reserved-grants.test.ts`
- pre_fix_failure_artifact: `tasks/runs/20260918-2229-issue-180-prefix-failure.txt`

## Workflow Inventory

- Source plan: `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md`
- Notes file: `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

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
  - packages/client/src/adapters/claude/claude-adapter.ts
  - packages/client/src/adapters/pi/permission-mapping.ts
  - packages/client/src/adapters/pi/pi-adapter.ts
  - packages/client/src/bin/pi-rpc-host.ts
  - packages/client/src/__tests__/toolset-mcp-grant.test.ts
  - packages/client/src/__tests__/agent-message-reserved-grants.test.ts
  - packages/client/src/__tests__/pi-rpc-host.test.ts
  - tasks/runs/
  - tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md
  - tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md
  - tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
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

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/__tests__/agent-message-reserved-grants.test.ts
  artifacts_exist:
    - tasks/runs/20260918-2229-issue-180-prefix-failure.txt
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {"id":"build","kind":"command","command":"bun run build","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree builds","inputs":{"env":[]}},
    {"id":"typecheck","kind":"command","command":"bun run typecheck","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree typechecks","inputs":{"env":[]}},
    {"id":"package_test","kind":"command","command":"bun test packages/client/src/__tests__/agent-message-reserved-grants.test.ts packages/client/src/__tests__/toolset-mcp-grant.test.ts packages/client/src/__tests__/claude-adapter.test.ts packages/client/src/__tests__/pi-adapter.test.ts packages/client/src/__tests__/codex-agent-message-permission.test.ts packages/client/src/__tests__/agent-message-completion-gate.test.ts","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"regression_guard + 相邻 adapter/grant/gate 套件零回归","inputs":{"env":[]}},
    {"id":"api-surface","kind":"command","command":"bun run check:api-surface","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"golden","inputs":{"env":[]}}
  ]
}
```

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: claude now consumes the whole reserved pre-grant table (message + memory) exactly like codex; pi's mapper/adapter thread the reserved grants; the pi RPC host drift gate re-derives the expected delegated flags from policy + its own server projection. Covered by `agent-message-reserved-grants.test.ts` (8 tests), the updated `toolset-mcp-grant.test.ts` expectation, and two new real-host cases in `pi-rpc-host.test.ts`. Remaining gap: none on this surface.
- New test case/file rationale, or why existing coverage is sufficient: issue cases (a) direct tool call authorized+delivered are pinned per adapter at the argv/config level (grant shape + mounted server); cases (b) final-text→Agent-message and (c) one message body per turn are daemon-level, runtime-agnostic invariants already pinned by `agent-message-completion-gate.test.ts` (62 tests, green) — adapters do not participate in those paths, so duplicating them per adapter would test nothing new.
- Selected check IDs and why their coverage is sufficient; omitted coverage: build, typecheck, package_test (guard + adjacent adapter/grant/gate/host suites), api-surface — plus `check:version-authority`, `check-task-workflow --strict`, and the full `bun run test` run for extra confidence. Omitted: none.
- Full/expensive check justification and expected cost, if applicable: full suite (~2 min) run once; result 2882 passed / 1 failed, the failure being the documented pre-existing local-only `pi-s2-bundle-resolution.test.ts:327` bun registry tripwire, reproduced on a clean tree earlier this session (stash-verified) and known from the N1 contract; CI is authoritative for it.
- Execution/baseline references, subject, current delta and disposition: pre-fix RED run captured at `tasks/runs/20260918-2229-issue-180-prefix-failure.txt` (5 failed / 3 passed, PRE_FIX_EXIT=1); post-fix all targeted suites green.
- Residual risks and incomplete observations: report-only latent pi issue — readonly `--tools` base list does not name qualified host-toolset tool names, so a projected host toolset under readonly may rely on operators listing them in `allowTools` (see notes Promotion Candidates); not touched, outside this task's surface.

## Rollback Point

- Commit / checkpoint: branch `claude/issue-180-send-agent-message-grants` fix commit (see `git log -1` on that branch).
- Revert strategy: `git revert` of the fix commit restores the memory-only claude filter, the policy-only pi mapper, and the policy-only host drift gate; the two new test files then fail RED, matching the pre-fix artifact.
