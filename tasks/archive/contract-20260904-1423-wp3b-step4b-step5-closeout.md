> **Archived**: 2026-09-04 14:23
> **Related Plan**: plans/archive/plan-20260904-1324-wp3b-step4b-step5-closeout.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260904-1423
> **Archive Projection V1**: `plans/plan-20260904-1324-wp3b-step4b-step5-closeout.md` => `plans/archive/plan-20260904-1324-wp3b-step4b-step5-closeout.md`
> **Archive Projection V1**: `tasks/notes/20260904-1324-wp3b-step4b-step5-closeout.notes.md` => `tasks/archive/notes-20260904-1423-wp3b-step4b-step5-closeout.md`
> **Archive Projection V1**: `tasks/contracts/20260904-1324-wp3b-step4b-step5-closeout.contract.md` => `tasks/archive/contract-20260904-1423-wp3b-step4b-step5-closeout.md`
> **Archive Projection V1**: `tasks/reviews/20260904-1324-wp3b-step4b-step5-closeout.review.md` => `tasks/archive/review-20260904-1423-wp3b-step4b-step5-closeout.md`

# Task Contract: wp3b-step4b-step5-closeout

> **Status**: Fulfilled
> **Plan**: plans/archive/plan-20260904-1324-wp3b-step4b-step5-closeout.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-04 13:24
> **Review File**: `tasks/archive/review-20260904-1423-wp3b-step4b-step5-closeout.md`
> **Notes File**: `tasks/archive/notes-20260904-1423-wp3b-step4b-step5-closeout.md`

## Why

WP3B is not complete while the daemon still owns a dead WebSocket-first branch and current docs describe two transports after the server façade removed its WS endpoint. The public type surface, route constants, runtime code, and documentation must cut over together.

## Goal

Make long-poll the daemon's only bidirectional transport, remove all WS-only product code and public configuration, align current documentation and API goldens, close the architecture request, and deliver the exact accepted subject through a merged GitHub PR.

## Scope

- In scope: client daemon transport implementation/tests/public exports; protocol WS route constant; current docs and changelog; client/server API goldens; workflow/architecture closeout artifacts.
- Out of scope: wire v2 semantics, release/publish/deploy, downstream rollout, historical research rewrites.
- Taste constraints: no deprecated aliases, ignored WS flags, dual mode, heuristic fallback, or synthesized transport state.

## Falsifier

Any production import/reference to `WsTransport`, `ws-transport`, `BYOK_WS_PATH`, `toWsUrl`, WS fallback/probe state, or a current document claiming the daemon/server still supports WS; or any full-client/root/API/package-graph/architecture gate failure.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"longpoll-only-client","kind":"deterministic_test","paths":["*"]},{"id":"real-server-longpoll-cutover","kind":"runtime_readback","paths":["*"]},{"id":"public-api-golden","kind":"deterministic_test","paths":["api-surface/client.d.ts","api-surface/server.d.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/archive/plan-20260904-1324-wp3b-step4b-step5-closeout.md
  - tasks/archive/contract-20260904-1423-wp3b-step4b-step5-closeout.md
  - tasks/archive/review-20260904-1423-wp3b-step4b-step5-closeout.md
  - tasks/archive/notes-20260904-1423-wp3b-step4b-step5-closeout.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/workstreams/root/
  - packages/client/src/
  - packages/client/package.json
  - packages/protocol/src/
  - bun.lock
  - api-surface/client.d.ts
  - api-surface/protocol.d.ts
  - api-surface/server.d.ts
  - docs/
  - README.md
  - CHANGELOG.md
  - examples/basic/README.md
  - packages/AGENTS.md
  - packages/CLAUDE.md
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
      purpose: integration_and_release_gate
    explorer:
      mode: read_only
      purpose: sprint_scope_audit
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exact_subject_review
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
    - packages/client/src/daemon/connection-manager.ts
    - packages/client/src/daemon/long-poll-transport.ts
    - docs/architecture/sdk-architecture.md
    - docs/protocol.md
  tests_pass:
    - path: packages/client/src/__tests__/real-server-longpoll-only.test.ts
    - path: packages/client/src/__tests__/connection-manager-server-capabilities.test.ts
    - path: packages/client/src/__tests__/connection-manager-shutdown-drain.test.ts
  commands_succeed:
    - bun run --cwd packages/client test
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - node scripts/release/check-package-graph.mjs
    - repo-harness run check-architecture-sync
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: startup immediately establishes long-poll; current server capabilities come from poll responses; POST egress and bounded shutdown remain unchanged.
- Edge cases: handler failure redelivery, duplicate-only backoff, revocation abort, cursor-too-old terminal failure, and pending POST shutdown drain remain covered.
- Regression risks: public config/type removal, audit/status connection-state projection, and docs/API drift.

## Rollback Point

- Commit / checkpoint: `ad0aa2ba81d39202b741b4b8ca0bc3a4ae631cd6`
- Revert strategy: revert the final Step 4b + Step 5 PR as one unit.
