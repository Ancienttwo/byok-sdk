# Plan: P0 — prepared offers carry message egress; input-preparation wire v6 (SDK 0.21.0)

> **Status**: Executing
> **Created**: 20260924-1600
> **Slug**: p0-prepared-egress
> **Planning Source**: orchestrator-dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: origin/main @ 99a1b238. Owner approvals of 2026-09-24: P0 before SummaryJob; freeze the Pi fork; P0 stays on fork 0.86.1001; official 0.87.1 migration follows as a separate work-package. Frozen contract: Salesko `docs/researches/20260924-byok-018-c02-amendment-2-prepared-execution.md` (sha256 471851e3…), receipt alongside.
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `bun run check:release-pack`, `repo-harness run check-task-workflow --strict`; gatekeeper PASS.
> **Rollback Surface**: revert branch `claude/p0-prepared-egress`. The v6 cut is one-shot with no dual token and no dual read.
> **Spec**: `docs/spec.md`

## Why

Salesko user Turns execute a fresh instruction offer carrying a legacy transcript handoff. They never execute the prepared document D that bounded admission measured. Three consequences follow: I13 is not closed at execution, a Summary is never consumed, and a thread wedges after about 12 Turns or after any non-answered Turn.

The SDK's `task.offer_prepared` cannot carry `egressPolicy` / `messageEgress` (`packages/protocol/src/messages.ts:415-421`), and `enqueuePreparedOffer` cannot carry `agentMessageContext` (`packages/cloud/src/cloud.ts:387-391,1880-1895`). This package makes prepared offers able to run the chat lane.

## Invariants

- **Zero changes to the Pi fork packages** (fork frozen). If a change inside the fork proves necessary, stop and report.
- One authority, no dual path, no fallback. Wire v6 is a single cut: no dual token, no dual read. The capability token follows `INPUT_PREPARATION_WIRE_VERSION`.
- D is unchanged. The 14-point admission is unchanged. The message tool is never part of D.
- A prepared offer always runs under strict egress, and outbound envelopes are sanitized.
- The body of a prepared Execution is daemon-authored at turn end, after the usage check. `task.complete` carries `preparedObservation` only after the message is accepted (E4 unchanged).

## Task Breakdown

- [x] **S1 wire and cloud**
  - `TaskOfferPreparedPayloadSchema` gains `egressPolicy` (required) and `messageEgress` (optional).
  - `INPUT_PREPARATION_WIRE_VERSION` 5→6, so the capability becomes `agent-input-preparation-v6`.
  - `enqueuePreparedOffer`:
    - gates egress-policy, reliable-ack and fresh-session;
    - when `messageEgress` is present, also gates message-egress;
    - accepts `agentMessageContext`.
  - The `agent-message-offer:` receipt writer (currently at `cloud.ts:1833` and `:1920`) is extracted to one function used at all call sites.
  - Correct the N-1 comment at `messages.ts:399-401`: on long-poll, an unknown type and an unknown key both freeze the cursor, and the only guard is the enqueue capability gate.
- [x] **S2 device prepared chat lane**
  - For prepared offers, egress sanitization applies (`usesAgentEgress` becomes true when `egressPolicy` is present).
  - The prepared branch does not inject reserved helpers: no `withAgentMessageMcp`, no agent-memory helper, and no helper preflight or bin prechecks for them (`task-runner.ts:2043,2298,2425,2435`).
  - `messageRequirement` and the outbox behave as for fresh offers.
  - The body is published through the existing daemon-authored turn-end path (`task-runner.ts:3798-3852`), in this order:
    1. run-time overflow or missing usage fails early, before any body;
    2. at turn end, the usage check runs first;
    3. then the result document, then draft and publish;
    4. wait for acceptance;
    5. then `task.complete` with `preparedObservation`.
  - Verify that prepared host progress events fill `finalTextParts`. If they cannot, stop and report.
- [x] **S3 native tool policy for prepared**
  - Provide one expression meaning "auto policy, zero native tools" that is consistent across the fresh and prepared lanes. The candidate is `{mode:'auto', allowTools:[]}` mapping to Pi's no-tools, aligned with `permission-mapping.ts:99`. Document the semantics change for `auto`+`[]`.
  - Move the native-expressibility check (`adapters/pi/prepared-tools.ts:191-203`) to before pin, so a refusal never consumes a pinned record.
- [moved] **S4 移至官方迁移 WP**。原因：fork `sdk.ts:547-548` 拒绝零工具 session。2026-09-24 orchestrator 按 Owner 的 fork freeze 裁定移出 P0/v6；本次不支持空 requiredToolsets。
- [x] **S5 docs**
  - Update `docs/spec.md` for:
    - the prepared offer with egress;
    - the daemon-authored body ordering;
    - the v6 cut with its drain + paired-upgrade precondition;
    - the auto-zero-native expression;
  - Also update `docs/protocol.md`, the api-surface goldens, and the protocol golden (v6).
- [x] **S6 tests (offline, synthetic adapter; no real provider)**
  - Extend `prepared-offer-lane.test.ts`:
    - the launch config has no reserved server;
    - a daemon-authored draft exists;
    - there is no `task.complete` before acceptance;
    - `task.complete` carries `preparedObservation`;
    - missing usage produces no message.
  - Show that egress sanitization applies to prepared envelopes.
  - A cloud enqueue to a device declaring only v5 gets a typed refusal with no mailbox row.
  - `pi-prepared-launcher.test.ts`: the host registers zero native tools under auto+[].
  - A native-inexpressible policy is refused before pin, with zero pinned records.
- [x] Gatekeeper implementation/source review PASS; final packed-artifact disposition is recorded in the external SDK report after the required clean local commit.
- [x] Release 0.21.0 via the release flow. The Owner approves the publish; the release notes carry the v6 drain precondition. — published 2026-09-24/25 as 0.21.0 / keys 0.6.2 from `8b7a2121` (PR #227), tag `v0.21.0` on origin; receipt `docs/releases/v0.21.0-publication.md`

## Out of scope

- The official Pi 0.87.1 migration: next work-package; A1'/A2' are approved at that time.
- SummaryJob.
- Salesko Host changes: a separate plan in Salesko, done after this SDK candidate.
- The package trim: separate chore alongside 0.21.0.
- Native/memory tools (P0b).
- Subscription lanes (P0c).

## Evidence Contract

- State/progress path: this plan Task Breakdown and tasks/notes/20260924-1600-p0-prepared-egress.notes.md.
- Verification evidence: /private/tmp/h5-salesko-prep-20260923/p0-sdk-logs/ retains exact command output and exit status; repository notes link the subject and results.
- Evaluator rubric: S1–S3/S5/S6 behavior and frozen Amendment 2; one read-only gatekeeper review after implementation.
- Stop condition: stop immediately if a fork package change is necessary; stop after three repair rounds per issue; report unrelated failures without expansion.
- Rollback surface: local claude/p0-prepared-egress changes only; no push, provider call, package publication, or fork edits.

## Allowed Paths

- packages/protocol/
- packages/cloud/
- packages/client/
- docs/spec.md
- docs/protocol.md
- scripts/api-surface/
- api-surface/
- plans/plan-20260924-1600-p0-prepared-egress.md
- tasks/contracts/20260924-1600-p0-prepared-egress.contract.md
- tasks/reviews/20260924-1600-p0-prepared-egress.review.md
- tasks/notes/20260924-1600-p0-prepared-egress.notes.md

## Architecture and trace

P1: protocol owns the wire/capability, cloud owns admission and durable message context, client owns preparation/pin/runtime/outbox, and the frozen Pi packages own D and its native consumer. Host and fork code are outside this worktree scope.
P2: prepared enqueue freezes message context; daemon compares the same prepared record, pins then claims, consumes D without reserved helpers, maps Pi text_delta to progress/finalTextParts, checks usage, publishes a daemon-authored draft, and completes only after exact accepted disposition.
P3: frozen Amendment 2 supersedes the earlier advisory request to put message tools in D. Preserve the existing D and fourteen comparisons, reuse outbox ordering, and make the v6 cut once. At scale stale preparations and held/unknown dispositions remain explicit recovery states; no new execution fallback.

## Promotion Gate

- Merge/PR unit: one local SDK P0 commit series on claude/p0-prepared-egress; no push in this dispatch.
- Rollback surface: revert this SDK work-package without touching Host or fork repositories.
- Verification boundary: the seven named repository commands and focused synthetic regressions.
- Review/acceptance boundary: one gatekeeper review of frozen S1–S3/S5/S6; publishing remains with the orchestrator.
- High-risk surface: strict wire v6, message egress ordering, prepared admission and native tool policy.
- Why not checklist row: a coordinated public wire cut and cloud/device behavior change require one explicit rollback unit.
