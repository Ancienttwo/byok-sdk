# Implementation Notes: agent-message-egress

> **Status**: Verifying
> **Plan**: plans/plan-20260826-1159-agent-message-egress.md
> **Contract**: tasks/contracts/20260826-1159-agent-message-egress.contract.md
> **Review**: tasks/reviews/20260826-1159-agent-message-egress.review.md
> **Last Updated**: 2026-08-26 12:49
> **Lifecycle**: notes

## Design Decisions

- `agent.message.publish` / `agent.message.disposition` are distinct from Agent activity and terminal-document envelopes.
- `messageEgress` remains the frozen Salesko shape: required mode, opaque contract discriminator, text content type, and byte ceiling.
- Product destination lookup is server-side authenticated task context. No target, tenant, device, AgentRef, task, or session field is accepted by the model-visible MCP tool.
- The bounded opaque `AgentMessageServerContext` is persisted after exact task reservation and before the offer mailbox becomes visible; it never enters an offer/message envelope and is passed only to the host consumer after exact matching.
- Local MCP publication uses a daemon-issued two-UUID sealed context token. The control RPC does not accept a task id, and decline/finish revoke the token.
- Exact acceptance revokes the token immediately; cloud/server lock the first immutable message payload per task so a second message id/body is rejected while exact replay remains idempotent.
- Activated outbox records bind authenticated tenant identity and are recovered from canonical Agent homes on daemon restart; active and recovered sends retry while no exact disposition exists, and cross-tenant recovery fails closed.
- Fresh-runtime calls may append a staged draft before session handoff; send activation occurs only after the exact handoff is fsynced.
- Any exact disposition stops transport replay. Only exact `accepted` retires bytes and releases `task.complete`; `held`/`refused` retain bytes and require a separate authenticated product action, while mismatches remain unacknowledged.
- Codex task MCP uses `--ignore-user-config` plus task-only `-c mcp_servers.*` overrides; local `codex exec --help` confirms both flags exist and auth remains under `CODEX_HOME`.

## Deviations From Plan Or Spec

- The draft design showed a destination binding on the daemon wire. Final implementation keeps the destination entirely server-side and keys the host consumer from authenticated task context, which is stricter and matches the frozen no-model/no-retarget semantics.
- The aligned unpublished RC is `0.9.0-rc.0` because this adds a new capability/message family; independently versioned keys remains `0.3.2`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reuse `task.complete.document` | Rejected | It would widen or conflate activity/terminal privacy semantics. |
| Reuse reliable activity payload | Rejected | Message content needs separate authorization, storage, ack, and completion dependency. |
| SDK-reserved task MCP | Selected | Pi/Claude already project task MCP; Codex now truthfully does so with task-only config. |

## Open Questions

- None.

## 0.9.0-rc.1 reconciliation slice

- Downstream subject `apps/local-agent/src/private-agent-chat-summary-egress.test.ts`
  (`sha256:4e217393a3e3be37dcbe1cd2f304f5b38a76431c5bfaca82eaa74dcf63323f9e`)
  proved the message body and exact accepted disposition were durable before
  the task failed. The remaining failure was the daemon-wide Research
  `resultDocument.extract` being invoked for the message-only Chat task.
- The generic repair adds additive `terminalProjection` selection and the
  `terminal-projection-selection` capability. Required-message tasks are
  message-only when no second projection is selected; explicit
  `result-document` carries an opaque contract into `ResultDocumentTask` and
  requires a document. This preserves the frozen consumer unchanged and
  avoids task-id/output heuristics or a downstream task registry.
- Pre-fix artifact authority is the frozen Salesko artifact
  `sha256:baac15146c5ad5aeaac8f2dbc660e3de390477fafc79d9a9a5d58d5b2535ffbe`.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Frozen downstream composite: `sha256:5b1bde061de45995b74b5cc72f0e18a113db17cb01dc094d4659832ab85a6f80`
- Pre-fix artifact: `.ai/harness/runs/20260826-1205-agent-message-egress-pre-fix.txt` (`PRE_FIX_EXIT=1`, 0/2).
- `bun run build` PASS.
- `bun run typecheck` PASS.
- Final frozen-source `bun run test` PASS: client 1429, cloud 213, cloud-dataplane 74, protocol 344, server 266, remaining workspaces all green.
- Pi/Claude/Codex task-scoped injection canary PASS: 5 files / 91 tests; each adapter projects the sealed context env through its native MCP configuration path.
- `repo-harness run check-task-workflow --strict` PASS.
- `node scripts/release/check-package-graph.mjs` PASS: 9 aligned manifests at `0.9.0-rc.0`, keys `0.3.2`.
- Independent gate PASS after three concrete blockers were fixed: host-only server context, caller-selected local task authority, and exact-disposition restart replay. Focused protocol/client/cloud/server gates pass; held/refused settlement survives restart and exact transport duplicates do not re-invoke the product consumer.

## Packed RC and downstream readback

### 0.9.0-rc.1 reconciliation candidate

- Final RC source commit: `96b93002a38af5d943478998f75d1090ca9f80df`.
- Manifest: `artifacts/release/release-manifest.json`, SHA-256
  `b25da4a6a473d8347a678f9a61a7565eda9f43c476284885fb9e6457f203a1a8`.
- Salesko corrected the metadata-only assertion to require progress body absence
  and added only two non-null assertions to expected fixtures for its TypeScript
  gate. Final consumer subject SHA-256 is
  `f53fddc5260e518c8bf7c1aceec1de209be46fa404b0adb41c8dc1240e15e774`;
  fresh/resume message delivery, body-free activity/task completion,
  `terminalProjection: none`, and zero Research extractor calls all pass.
- Registry remains unpublished. The user separately authorized PR, push, and
  merge for this accepted source plus the existing root architecture/context
  WIP; no package publish, tag, deploy, migration, or production wiring is
  authorized.

- Frozen source commit: `1f5ae35a7e1cb626dd704e504711bcfcfd74694b` (tree `5c9ea5b5b401f5dd0cfe01e609b422bd3f58ea02`).
- `bun run check:release-pack -- --out-dir artifacts/release` PASS from a clean source commit. It packed and isolated-installed 10 packages; all nine aligned packages are `0.9.0-rc.0`, keys remains `0.3.2`, internal edges close exactly, and cloud-dataplane contains all 13 migrations.
- Frozen manifest: `artifacts/release/release-manifest.json`; its `sourceGitSha` exactly equals the source commit above.
- Public surface: protocol exports `AGENT_MESSAGE_EGRESS_CAPABILITY`, strict `AgentMessageEgressRequirement`, publish/disposition schemas and host-only `AgentMessageServerContext`; cloud/server accept host-only `agentMessageContext` and expose the authenticated consumer input; client adds the `byok-agent-message-mcp` binary and task-scoped daemon lifecycle.
- Frozen Salesko commit `299728a0e08741c2521c59ab8f56b350782ef089` was recovered from Git object storage after its worktree had been cleaned. Its falsifier hash remained exact: `fe586f1b52daaea74d03471fbf8b87ca84f963b6c672bf7c6d65a6d69729403c`.
- Exact protocol tarball overlay resolved to `@byok-sdk/protocol@0.9.0-rc.0`; `bun test ./apps/local-agent/src/private-agent-chat-message-egress.falsifier.ts` PASS 2/2 and `bun test ./apps/local-agent/src/private-agent-chat-summary-egress.test.ts` PASS 1/1. The original Salesko source file was unchanged.
- Registry state: unpublished. No tag, merge, push, deploy, migration, production wiring, or secret operation was performed.
- Superseded untracked `1141 terminal-egress` artifacts were moved out of the worktree to `/tmp/byok-superseded-1141-20260826/`; they are recoverable and are not part of this subject.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
