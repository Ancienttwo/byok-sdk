# Task Contract: team-codex-relay

> **Status**: Active
> **Plan**: plans/plan-20260906-0107-team-codex-relay.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Review File**: tasks/reviews/20260906-0107-team-codex-relay.review.md
> **Notes File**: tasks/notes/20260906-0107-team-codex-relay.notes.md

## Goal

Implement the user-approved two-session Codex foreground team relay, retaining TeamWorkspace message/receipt authority and proving automatic peer-message notification without manual turns.

## Scope

One local room/two explicitly registered existing operator-owned sessions, metadata-only notifications, read-only snapshots, finite attempts, pause/resume/stop, fail-closed leases/queue failures and room exclusivity. Three prior probe defects are included. No native process/home management, cloud wire, tmux input, other harness binding, restart recovery, release or merge.

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/daemon/team-workspace.ts
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/bin/team-codex-relay.ts
  - packages/client/src/bin/commands/team-relay.ts
  - packages/client/src/bin/byok-agent.ts
  - packages/client/src/__tests__/team-codex-relay.test.ts
  - packages/client/src/__tests__/team-workspace.test.ts
  - api-surface/client.d.ts
  - packages/client/README.md
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - docs/architecture/index.md
  - docs/architecture/requests/
  - packages/AGENTS.md
  - packages/CLAUDE.md
  - docs/researches/2026-09-05_cross-harness-probe.md
  - docs/researches/evidence/2026-09-05-cross-harness/
  - plans/plan-20260905-2239-tmux-cross-harness-collaboration.md
  - plans/plan-20260906-0107-team-codex-relay.md
  - tasks/contracts/20260906-0107-team-codex-relay.contract.md
  - tasks/reviews/20260906-0107-team-codex-relay.review.md
  - tasks/notes/20260906-0107-team-codex-relay.notes.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/workstreams/root/
```

## Exit Criteria

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/bin/team-codex-relay.ts
    - packages/client/src/bin/commands/team-relay.ts
    - tasks/reviews/20260906-0107-team-codex-relay.review.md
  artifacts_exist:
    - docs/researches/evidence/2026-09-05-cross-harness/relay-smoke-results.json
  tests_pass: []
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"team-codex-relay-tests","kind":"deterministic_test","paths":["packages/client/src/__tests__/team-codex-relay.test.ts","packages/client/src/__tests__/team-workspace.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Stop Conditions

Fail closed on unknown delivery/expired lease; no workaround via keystrokes or another model. Preserve concurrent main work. Three fix/reverify rounds maximum per issue. Unrelated failures are report-only.

## Rollback Point

Source base f993f8e; remove new relay/snapshot surface without modifying existing messages/receipts.
