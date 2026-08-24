# Task Contract: windows-credential-native-ci

> **Status**: Active
> **Plan**: plans/plan-20260825-0156-windows-credential-native-ci.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-25 03:36
> **Review File**: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md`
> **Notes File**: `tasks/notes/20260825-0156-windows-credential-native-ci.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR #87 cannot merge because the real Windows IPC and WinSW smokes both fail
before pairing writes an enrollment: the OS credential bridge returns a
provider error for a never-written target. Skipping those jobs or selecting a
process-local/file fallback would ship an unproved secret authority and make
the downstream Local Agent release unsafe.

## Goal

Make a unique Windows Credential Manager target pass absent -> replace ->
separate PowerShell-process read -> clear through the production bridge, then
make the real Windows IPC and WinSW jobs pass without weakening fail-closed
behavior or changing package/release identity.

## Scope

- In scope:
  - bounded non-secret native-provider diagnostics;
  - the Windows Credential Manager bridge and its focused unit/native tests;
  - Windows IPC/control-socket/WinSW smoke composition and CI workflow;
  - a per-invocation, non-secret OS-temp C# console bridge whose real process
    exit replaces PowerShell result/exit propagation;
  - this plan, contract, notes, review and check projections.
- Out of scope:
  - macOS/Linux provider semantics, Salesko source, package versions/lockfile, registry/tag/release/deploy/migration, real user credentials, and any plaintext/in-memory production fallback.
  - No new dependency or public SDK API is expected.
- Taste constraints: no target name, enrollment field, request body, token,
  key, credential blob, or exception message may enter diagnostics. A numeric
  Win32 code or HRESULT is the maximum provider detail allowed. The approved
  phase probe may attach only static numeric stage/kind codes to that HRESULT.
  The compiled bridge path may contain only a unique OS-temp location; the
  executable is static code, is never reused as state, and must be removed
  after the child exits. Crash scavenging may select only SDK-owned prefix,
  old, real directories and must never follow a symlink.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the hosted Windows runner cannot provide a usable native credential
  session without a plaintext/shadow authority, or if closure requires a
  product fallback, new dependency, package publication, or Salesko edit.

## Falsifier

A Windows-only native test uses a unique product id and the real bridge. It
must observe absence, replace a bounded fixture record, read the exact record
through another fresh PowerShell invocation, clear it, and observe absence.
Any provider error, secret-bearing output, disk fallback, process-local-only
success, or skipped real IPC/WinSW job falsifies completion.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260825-0156-windows-credential-native-ci.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md`
- Notes file: `tasks/notes/20260825-0156-windows-credential-native-ci.notes.md`
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
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - .github/workflows/ci.yml
  - packages/client/src/daemon/device-credential-store.ts
  - packages/client/src/__tests__/device-credential-store.test.ts
  - packages/client/src/__tests__/device-credential-store.native.test.ts
  - packages/client/scripts/ipc-smoke.mjs
  - packages/client/scripts/control-socket-check.mjs
  - templates/service/winsw/smoke-test.mjs
  - plans/plan-20260825-0156-windows-credential-native-ci.md
  - tasks/todos.md
  - tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md
  - tasks/reviews/20260825-0156-windows-credential-native-ci.review.md
  - tasks/notes/20260825-0156-windows-credential-native-ci.notes.md
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

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/__tests__/device-credential-store.native.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260825-0156-windows-credential-native-ci.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/device-credential-store.test.ts
    - path: packages/client/src/__tests__/device-credential-store.native.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/client test -- src/__tests__/device-credential-store.test.ts src/__tests__/device-credential-store.native.test.ts
    - bun run --filter @byok-sdk/client typecheck
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: exact Windows IPC and WinSW jobs must pass on the final
  PR head after the native round-trip test passes.
- Edge cases: absent target, replace/read/clear, provider unavailable, bounded
  error classification, and cleanup after failed assertions.
- Regression risks: Windows P/Invoke/session behavior and accidental secret
  output; macOS/Linux provider code must remain unchanged.

## Rollback Point

- Commit / checkpoint: branch head before this slice is
  `d0940f131cac4df44be506dc9d05153f1fb58e2f`.
- Revert strategy: revert only this slice's commits; retain prior Gate A source
  and unpublished RC evidence.
