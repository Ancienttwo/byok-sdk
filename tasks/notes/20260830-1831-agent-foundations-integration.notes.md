# Implementation Notes: agent-foundations-integration

## Frozen local candidate

- Branch: `codex/agent-foundations-integration`; source feature commit `1c82ea2`, Pi merge `9a1cbd2`, strict MCP initialization fix `98463ed`.
- Pi defaults: hard package dependencies `pi-subagents@0.60.0`, `@juicesharp/rpiv-todo@2.8.0`, `pi-web-access@0.24.1`, `pi-mcp-adapter@2.27.0`; subagent policy retains the readonly ceiling.
- TeamWorkspace authority: `<storeDir>/team-workspaces/v1/state.json`, atomic fsync-backed state, CAS member revision, one active short-lived lease per member, ordered broadcast messages, durable delivered/ack receipts, fixed quotas with fail-closed exhaustion.
- MCP: reserved `byokagentteam` helper with exactly `post_team_message`, `read_team_messages`, `ack_team_messages`; workspace/sender identity derives only from opaque lease context.
- tmux: feature-scoped native prerequisite supplied as an absolute binary; launcher only executes `new-session` with a read-only watcher and never `send-keys`/`capture-pane`.

## Verification

- `bun install --frozen-lockfile`: pass after Pi merge.
- `bun run build`: pass; client bundle contains team MCP and Pi subagent policy entries.
- `bun run typecheck`: 15 packages pass.
- `bun run test`: pass; client 1556 passed, 11 skipped; all workspace packages pass.
- `repo-harness run check-task-workflow --strict`: `[workflow] OK`.
- packed artifact smoke: pass at source `d598313`; all 10 package tarballs close exactly (manifest version remains 0.10.2, so this is validation only, never publication proof).
- real tmux smoke: `/opt/homebrew/bin/tmux 3.7c` created disposable `comm` pane running `sleep`, readback `byok-smoke-*:comm:sleep`, then session removed.

## Publication boundary

No push, tag, npm publish, registry readback, downstream install, deployment, or production change occurred. The additive features target the next minor train; manifest/version preparation remains a separate release gate after review.

> **Status**: Active
> **Plan**: plans/plan-20260830-1831-agent-foundations-integration.md
> **Contract**: tasks/contracts/20260830-1831-agent-foundations-integration.contract.md
> **Review**: tasks/reviews/20260830-1831-agent-foundations-integration.review.md
> **Last Updated**: 2026-08-30 18:31
> **Lifecycle**: notes

## Design Decisions

- ...

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
