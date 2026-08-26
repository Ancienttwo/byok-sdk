# Implementation Notes: agent-memory-phase2

> **Status**: Active
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Review**: tasks/reviews/20260826-1725-agent-memory-phase2.review.md
> **Last Updated**: 2026-08-26 17:56
> **Lifecycle**: notes

## Design Decisions

- `MEMORY.md` + `notes/**/*.md` remain the single local authoring authority.
  Hosted state is a one-way redacted latest-snapshot projection, never an
  import, merge, restore, semantic-search, or product-fact authority.
- The memory MCP is an SDK-owned reserved stdio helper injected only into
  strict Agent tasks. Identity and root path are reconstructed from the active
  task; the model supplies only a bounded relative file path and CAS revision.
- Hosted projection is default-off and requires all four local inputs:
  capability, opaque grant, non-identity redactor, and transport port. Cloud
  independently binds the authenticated tenant/device/task/exact AgentRef,
  session, runtime, grant, policy, and writer epoch.
- Postgres stores one bounded redacted head per tenant/Agent and immutable
  body-free metering receipts. Sequence gaps, stale epochs, and replay
  mismatches fail closed; exact replay returns the original receipt.

## Deviations From Plan Or Spec

- Existing generic `truth.records(kind=memory)` was not reused because its
  tenant + arbitrary key contract does not bind AgentRef/session/writer epoch.
- No identity redactor exists. The embedder must supply its policy; SDK checks
  obvious byte-for-byte pass-through and otherwise treats its output as opaque.
- Redacted snapshots use bounded Postgres `bytea` in this slice; R2 history,
  delta chains, and remote restore remain out of scope.
- Node lacks a cross-platform descriptor-relative filesystem API. Linux keeps
  `/proc/self/fd` + `O_NOFOLLOW`; macOS can use the separately verified,
  product-owned absolute-path Go helper with exact protocol/root identity.
  Windows remains fail-closed until its native junction/reparse matrix executes
  on a real runner. No PATH/native-addon compatibility fallback was added.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Generic truth memory | Rejected | Would create an unbound second Agent-memory authority. |
| Bidirectional sync | Rejected | Would require import, conflict, and multi-device authoring authority. |
| Local files + one-way projection | Selected | Preserves per-Agent cwd semantics and makes hosted consent/metering explicit. |

## Open Questions

- Downstream products still own consent UX, concrete redaction policy, pricing,
  legal retention, and the BFF that issues/revokes opaque grants.
- Cross-device restore or writer-epoch transfer requires a separate explicit
  export/import contract; this slice intentionally cannot do it.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Client focused tests: `packages/client/src/__tests__/agent-memory-mcp.test.ts`
- Hosted focused tests: `packages/cloud/src/__tests__/agent-memory-projection.test.ts`
- Postgres tests: `packages/cloud-dataplane/src/__tests__/agent-memory-projection.test.ts`
- SQL invariants: `tests/sql/control_plane_invariants.sql`
- Root verification: `bun run typecheck`, `bun run build`, `bun run test`, and
  `repo-harness run check-task-workflow --strict` all passed in the linked
  worktree on 2026-08-26.
- Cross-platform secure-fs contract: 13/13 strict checks passed; macOS helper
  Go/integration tests and Windows test cross-compiles passed. Windows runtime
  admission remains disabled.
- Linux disposable Node 22 + pnpm test: 2 files / 10 tests passed, including
  parent-directory symlink race and Pi/Claude/Codex strict injection.
- Disposable Postgres/MinIO: invariants + projection 2 files / 5 tests passed;
  compose substrate was removed afterward.
- `verify-sprint --prepare-acceptance` reran all contract rows successfully
  except the expected commit-bound `.ai/harness/checks/latest.json` artifact;
  the active contract is intentionally uncommitted because this task has no
  commit/push authority. Run snapshot:
  `.ai/harness/runs/run-20260826T183152-57581-20260826-1725-agent-memory-phase2.json`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
