# Task Contract: agent-provider-profile-binding

> **Status**: Partial
> **Plan**: plans/plan-20260826-1405-agent-provider-profile-binding.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-26 14:08
> **Review File**: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md`
> **Notes File**: `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Salesko accepts any bounded Pi provider id and seals it into a BYOK dispatch
selection, while the credential-custody launcher resolves only four fixed
provider ids and one global `custom` slot. A Profile such as `openrouter` can
therefore be saved and projected successfully but fail only after runtime
admission. The fixed provider identity also cannot represent two independent
custom endpoints or the image-input capability shown by the product's custom
provider mode.

## Goal

Deliver an unpublished provider-profile binding RC in which an Agent task names
one exact, non-secret, device-local provider profile identity and revision/hash;
the daemon validates that profile, exact model, and requested capabilities
before claim, seals them in the immutable operation manifest, and the Pi
credential launcher revalidates the same authority before projecting its local
endpoint and OS-custodied secret. Multiple custom profiles must be possible and
credential bytes must never enter protocol, status, manifest, logs, or RC
evidence.

## Scope

- In scope: typed provider-profile identity/revision/capability declarations;
  `@byok-sdk/keys` local registry and Pi projection; client pre-claim resolver,
  manifest, and launcher binding; exact-device non-secret status/readback only
  where the frozen consumer requires it; focused negative tests; docs; an
  unpublished packed RC and downstream consumer acceptance.
- Out of scope:
  - Salesko Profile schema implementation, cloud secret storage, provider-specific product labels, merge, push, npm publication, deployment, or production migration.
- Taste constraints: one local provider-profile authority; no steady-state
  dual-read from the fixed enum; no secret or Base URL in Agent offers; no
  provider fallback; no SDK knowledge of Salesko description/research fields.
- Destructive-action boundary: this slice does not delete or migrate existing
  provider records, credentials, Agent homes, sessions, branches, tags, or
  registry packages. Any persistent cutover requires a separately approved
  operator-invoked migration.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is falsified if `openrouter` or a second custom profile still
reaches a late launcher rejection; if missing/stale/model-mismatched or
capability-mismatched local state reaches claim/runtime; if image capability is
lost before Pi `models.json`; if secrets/Base URL appear in transport or
manifest; or if the exact packed Salesko consumer cannot select and read back
the same profile identity. The cheapest pre-fix proof is the keys/client
regression guard over two custom profiles plus the released fixed-id launcher.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260826-1405-agent-provider-profile-binding.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md`
- Notes file: `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"provider-profile-authority","kind":"deterministic_test","paths":["packages/protocol/src/","packages/keys/src/","packages/client/src/"]},{"id":"packed-provider-consumer","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260826-1405-agent-provider-profile-binding.md
  - tasks/todos.md
  - tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md
  - tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md
  - tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/protocol/src/
  - packages/protocol/README.md
  - packages/protocol/package.json
  - packages/keys/src/
  - packages/keys/README.md
  - packages/keys/package.json
  - packages/client/src/
  - packages/client/README.md
  - packages/client/package.json
  - packages/cloud/src/
  - packages/cloud/package.json
  - packages/cloud-dataplane/src/
  - packages/cloud-dataplane/package.json
  - packages/server/src/
  - packages/server/package.json
  - packages/core/package.json
  - packages/sdk/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - docs/protocol.md
  - docs/security.md
  - docs/host-local-storage-layout.md
  - docs/architecture/sdk-architecture.md
  - artifacts/agent-provider-profile-binding/
  - bun.lock
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
    - packages/protocol/src/messages.ts
    - packages/keys/src/provider-profile.ts
    - packages/client/src/adapters/pi/pi-adapter.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md
    - .ai/harness/runs/20260826-1405-agent-provider-profile-binding/pre-fix-provider-profile-binding.txt
  tests_pass:
    - path: packages/keys/src/provider-profile-binding.test.ts
    - path: packages/client/src/__tests__/agent-provider-profile-binding.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - bun run check:release-pack
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: exact device-local profile binding is admitted before
  claim and sealed through Pi launch; multiple custom profiles and image-input
  capability are representable without secret transport.
- Edge cases: malformed/oversize reference; missing profile; stale revision or
  hash; exact model mismatch; unsupported capability; restart readback;
  cross-device/Agent confusion; secret exclusion; no-claim/no-runtime refusal.
- Regression risks: persistent provider profile identity changes cannot ship
  with a steady-state compatibility fallback; release remains blocked until a
  one-shot migration decision and exact packed consumer acceptance exist.

## Rollback Point

- Commit / checkpoint: branch base `cdb424867e255d3024878e6fb261cd46ceff7b8f`.
- Revert strategy: discard this unpublished worktree/RC as one unit; no registry
  or downstream production authority changes in this slice.
