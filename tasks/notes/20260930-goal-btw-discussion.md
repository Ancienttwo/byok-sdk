# Goal / btw collaboration

User authorization: discuss the integration with the freshly opened Herdr Claude and implement the resulting SDK change; Codex owns implementation. No release or deployment requested.

- Base: `ede2db31ad33072965434b04743cfd7e52b93e85`.
- Implementation worktree: `/Users/chris/Projects/byok-sdk-goal-btw`, branch `codex/conversation-goal-btw`.
- Main checkout retains the prior research files and unrelated `.claude/worktrees/`.
- Herdr partner: `w9:p1`, fresh idle Claude in `/Users/chris/Projects/byok-sdk`; read-only advisory role. `w9:p2` owns the independent Pi upgrade.
- Inherited HERDR_PANE_ID was stale (`w3:p7`); exact live identifiers were discovered from `agent list`, not inferred from focus. HERDR_ENV=1.

## P1

Cloud/server expose fresh recurring submission and durable attempt/offer/device-terminal readback. Host owns Conversation, Turn, Execution associations and queue settlement (`docs/spec.md`, recurring Host composition). Prepared Pi owns exact first request bytes and prohibits ambient extension/resource loading; ordinary RPC includes vendored subagents/web. Provider secrets and native execution identity stay device-owned.

## P2

Host recurring input -> strict schema -> capability/consumer gate -> persisted offer/mailbox -> TaskRunner per-home reservation before claim -> Pi/Claude/Codex adapter -> runtime -> device terminal/message decision. Existing steer is cloud control -> task.steer -> TaskRunner -> Session.steer. Session.followUp is an adapter seam without a TaskRunner production caller. Default one concurrent mutable execution per Agent home prevents an additional same-home btw task while the main task runs.

## Candidate discussed (not an upstream package installation)

Bounded Host-owned goal lifecycle plus independent explicit readonly btw execution. No wire/Pi pin change, no daemon second scheduler, no implicit continuation, no relaxed home limit. Prefer pure, stateless helper and existing execution primitives over native TUI plugins. Claude is asked to challenge whether a new generic goal store/controller is premature and choose the smallest verifiable cut.

## Evidence before implementation

`bun install --frozen-lockfile` succeeded in the isolated worktree (438 packages). Baseline `bun run build` and `bun run typecheck` passed. These are prerequisite/environment receipts, not change acceptance.

## Discussion status

Initial broad read-only trace was bounded after roughly six minutes; Claude retained context and was redirected to deliver a decision from the existing source evidence without expanding the investigation.
