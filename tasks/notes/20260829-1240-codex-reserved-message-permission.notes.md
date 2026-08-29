# Implementation Notes: codex-reserved-message-permission

> **Status**: Active
> **Plan**: plans/plan-20260829-1240-codex-reserved-message-permission.md
> **Contract**: tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md
> **Review**: tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md
> **Last Updated**: 2026-08-29 12:44
> **Lifecycle**: notes

## Design Decisions

- Keep Codex's global `approval_policy=never`; project a one-tool `enabled_tools` allowlist and `approval_mode="approve"` only for SDK-reserved `byokagentmessage/send_agent_message`.
- Centralize the reserved MCP server/tool identifiers so TaskRunner injection, helper preflight, and Codex permission composition cannot drift.
- Fail closed in adapter `prepare()` before task claim/runtime execution when Codex is older than 0.149 or cannot read back the exact reserved-tool policy.
- Use real `codex exec` against a one-tool stdio fixture as the native authority that the reserved call executes without opening unrelated MCP approvals.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Global approval relaxation | Reject | It would authorize unrelated native tools and MCP servers. |
| Per-server default approval | Reject | Per-tool approval plus a one-tool allowlist is narrower and directly expresses the invariant. |
| Exact reserved per-tool approval | Use | It permits only the required terminal protocol action while preserving the daemon's global non-interactive posture. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix: `.ai/harness/runs/20260829-codex-agent-message-permission/pre-fix.txt`
- Native smoke: `packages/client/scripts/codex-agent-message-permission-smoke.mjs`
- Packed-host smoke: `packages/client/scripts/single-file-sdk-helper-smoke.mjs`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
