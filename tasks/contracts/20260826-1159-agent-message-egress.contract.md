# Task Contract: agent-message-egress

> **Status**: Fulfilled
> **Plan**: plans/plan-20260826-1159-agent-message-egress.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-26 12:05
> **Review File**: `tasks/reviews/20260826-1159-agent-message-egress.review.md`
> **Notes File**: `tasks/notes/20260826-1159-agent-message-egress.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Private Agent Chat needs one assistant-authored message while retaining metadata/status-only activity. Treating that message as `task.complete.document`, runtime stdout, or contentful trajectory either assigns routing authority to the model or widens cloud disclosure. The SDK lacks a task-scoped message capability, durable local message outbox, exact disposition, and required-message completion gate.

## Goal

Produce an unpublished packed RC that exposes a distinct Agent-initiated message lane for fresh and resume Agent egress offers. The model supplies only bounded plain text/Markdown through an SDK-owned task-scoped operation; authenticated task identity and server-held opaque destination binding supply all routing. Local durable outbox and exact accepted disposition gate required task success, while activity remains metadata/status-only.

## Scope

- In scope:
  - Add `agent-message-egress`, strict `messageEgress {mode, contract, contentType, maxBytes}`, distinct publish/disposition envelopes, and capability admission.
  - Persist product destination/freshness authority in server-side authenticated task context without exposing it to the model, daemon message input, or message envelope.
  - Add Agent-local append-before-send message outbox with stable ids/cursors, exact accepted retirement, held/refused retention, quota/backpressure, and restart retry.
  - Add a content-only task-scoped MCP sender across Pi, Codex and Claude, backed by authenticated daemon context; stdin-only CLI input may be used internally, never argv content.
  - Gate required-message `task.complete` on exact message acceptance and reject missing, stale-task, wrong-session, wrong-Agent and mismatched dispositions.
  - Add in-memory and durable cloud/server persistence/readback tests plus packed-RC Salesko consumption.
- Out of scope:
  - Salesko schemas, conversation storage, target parsing, model-authored routing fields, stdout/session-file parsers, terminal-document authorization, contentful activity, attachments, workspace/transcript/artifact transfer, publish/tag/merge/push/deploy/migration/secrets.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if the frozen Salesko 0.8.1 falsifier remains red against exact packed bytes, if a model-visible input can set any routing identity/target, if content enters activity envelopes or argv, if a required task completes before an exact accepted disposition, or if restart/duplicate/held/refused paths lose or retarget local content. Cheapest proof: `bun test ./apps/local-agent/src/private-agent-chat-message-egress.falsifier.ts` against the packed protocol/client train.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/protocol/src/messages.ts` strict Agent egress offers have no message declaration and `packages/client/src/daemon/task-runner.ts` has no task-scoped message authority or completion dependency; the only durable outbound store is activity/content-receipt scoped.
- repro: run the frozen Salesko command `bun test ./apps/local-agent/src/private-agent-chat-message-egress.falsifier.ts` against released BYOK 0.8.1; it reports 0 pass / 2 fail because the capability is undefined and both strict schemas reject `messageEgress`.
- regression_guard: packages/protocol/src/__tests__/agent-message-egress-contract.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/20260826-1205-agent-message-egress-pre-fix.txt

Post-RC reconciliation evidence:

- root_cause: `packages/client/src/daemon/task-runner.ts` invoked the host-global `resultDocument.extract` for every `turn_end`, including an exact accepted required-message task whose offer carried no structured-result authority.
- repro: `bun test apps/local-agent/src/private-agent-chat-summary-egress.test.ts` in the frozen Salesko consumer worktree; the message consumer and exact disposition succeed before the extractor causes `task.fail`.
- regression_guard: packages/client/src/__tests__/agent-message-completion-gate.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/20260826-agent-message-terminal-projection-pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260826-1159-agent-message-egress.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260826-1159-agent-message-egress.review.md`
- Notes file: `tasks/notes/20260826-1159-agent-message-egress.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-message-contract-suite","kind":"deterministic_test","paths":["*"]},{"id":"packed-rc-salesko-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/2026-08-26_agent-initiated-message-egress-contract.md
  - docs/protocol.md
  - docs/architecture/sdk-architecture.md
  - docs/host-local-storage-layout.md
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260826-1159-agent-message-egress.contract.md
  - tasks/reviews/20260826-1159-agent-message-egress.review.md
  - tasks/notes/20260826-1159-agent-message-egress.notes.md
  - .ai/harness/active-plan
  - .ai/harness/active-worktree
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/protocol/
  - packages/core/
  - packages/cloud/
  - packages/cloud-dataplane/
  - packages/server/
  - packages/client/
  - packages/sdk/
  - packages/testkit/
  - packages/ui-runtime/
  - package.json
  - bun.lock
  - scripts/release/
  - artifacts/release/
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
    - docs/spec.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260826-1159-agent-message-egress.notes.md
    - artifacts/release/release-manifest.json
    - artifacts/release/byok-sdk-core-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-protocol-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-server-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-cloud-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-client-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-cloud-dataplane-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-ui-runtime-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-testkit-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-0.9.0-rc.1.tgz
    - artifacts/release/byok-sdk-keys-0.3.2.tgz
  tests_pass:
    - path: packages/protocol/src/__tests__/agent-message-egress-contract.test.ts
    - path: packages/client/src/__tests__/agent-message-outbox.test.ts
    - path: packages/client/src/__tests__/agent-message-completion-gate.test.ts
    - path: packages/client/src/__tests__/terminal-projection-selection.test.ts
    - path: packages/cloud/src/__tests__/agent-egress-contract.test.ts
    - path: packages/server/src/__tests__/agent-egress-contract.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Fresh and resume Agent offers admit the same required message contract while activity stays metadata/status-only.
- The model-visible tool accepts content only; authenticated context supplies exact task/Agent/session and server-held destination.
- Exact accepted disposition is required before business success and alone retires the local message.
- Edge cases:
- old daemon capability omission, malformed/oversize contract/body, argv content, stale task, pre-handoff fresh race, wrong Agent/session/hash/cursor, duplicate, held/refused, disconnect/restart, quota, and hook/consumer failure fail closed.
- Regression risks:
- Existing activity reliable egress, content receipts, task terminal document, Agent-home projection and runtime session semantics remain unchanged.

## Rollback Point

- Commit / checkpoint: base `cdb424867e255d3024878e6fb261cd46ceff7b8f` in isolated worktree.
- Revert strategy: discard the unpublished feature branch/tarballs; no registry or production state is changed.
