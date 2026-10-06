# Host reconnect: next implementation boundary

Status: read-only recommendation. No Host repository has been selected and
no Salesko or AiphaBee code changes are part of this SDK slice.

## Existing ownership

`@byok-sdk/ui-runtime` is a React-free, deterministic projection package. Its
README explicitly excludes network, authentication, persistence, redaction,
and presentation ownership. It already provides:

- Activity replay and incremental projection through `replayTimeline`,
  `foldTimelineEvent`, and `projectTimeline`.
- Activity gap information, store-owned dropped counts, expiry, and cursor
  metadata.
- Approval observation/tail projection through `foldApprovalObservation`,
  `foldApprovalTail`, and `projectApprovalTimeline`.
- Approval tail validation: ordered revisions, cursor matching the last
  retained revision, stale-tail rejection, and identity/revision collision
  checks.

These projections cannot make separately fetched server state and cursors
atomic. They do not schedule reconnects or authorize replay of mutations.
The approval timeline is an observation read model, not proof that a native
runtime still has an answerable pending request.

`@byok-sdk/server` owns the self-hosted façade over the cloud domain kernel.
Per the architecture contract, `tasks.get()` and `tasks.list()` are durable
task readbacks. Its `events.subscribe()` is an in-process, post-commit live
stream, explicitly not durable replay or cross-process audit history. Device
mailbox long-poll and its daemon acknowledgment rules are a different flow;
they must not be repurposed as a browser/mobile recovery protocol.

## Recommended Host-owned slice

Choose the target Host repository first. Keep browser/mobile lifecycle,
transport subscriptions, reconnect scheduling, persistence transactions, and
rendering there. Use the existing SDK read models rather than adding an SDK
WebSocket client or a second task state machine.

1. Define one recovery snapshot with an explicit scope (user/tenant, task and
   view), source revision/cursor, schema version, and complete projected view
   state. The authoritative API must return a consistent snapshot and its
   continuation position together. Do not manufacture that guarantee by
   combining separate responses. If the current Host API lacks it, implement
   it in that Host's read-model transaction boundary first.
2. Commit snapshot plus cursor atomically in one Host storage transaction.
   Never persist a cursor before its corresponding state. Restore them as one
   unit after page reload, mobile suspension, or process death.
3. Give every recovery attempt a new local epoch. Cancel or ignore callbacks
   from the old subscription, including a delayed response that arrives after
   the replacement snapshot. Buffer only bounded, ordered post-snapshot
   events, then apply them against the matching epoch and scope.
4. On a gap, stale/unknown cursor, expired retention, changed scope, or
   incompatible snapshot schema, discard the incremental attempt and fetch
   canonical readbacks. Replace the projection and cursor together. A lossy
   in-process stream must trigger reconciliation; it cannot promise replay.
5. Treat mobile foreground/online transitions as a need to reconcile, not
   evidence that the prior connection remained valid. Read current task and
   pending-interaction state before re-enabling controls. Connection and
   presence hints are not task or approval authority.
6. Do not automatically resend dispatches, approvals, question answers,
   steering, cancellation, or other mutations on reconnect. If a response was
   lost, read the authoritative result/pending request and surface an explicit
   unresolved state. Keep an old submitted approval form disabled until that
   ambiguity is resolved; never turn UI restoration into a repeated action.

## Acceptance scenarios for that Host change

- Crash between snapshot acquisition and persistence; no advanced cursor
  survives without its view state.
- Snapshot fetch races an event and an old connection callback; neither
  skips nor duplicates a retained event in the replacement epoch.
- Duplicate, out-of-order, gapped, and stale events produce either an
  identical projection or explicit canonical-read fallback.
- Mobile sleeps beyond retention, wakes offline, then reconnects; controls
  stay unavailable until authoritative reconciliation finishes.
- Account/task switch rejects old-scope callbacks and cached state.
- Approval is resolved elsewhere during sleep; the restored prompt cannot
  submit against the old native request or a replacement session generation.
- A mutation succeeds but its response is lost; reconnect performs readback
  without automatically repeating the mutation.

This is the next Host task's proposed acceptance contract, not a claim that
the SDK currently implements these Host guarantees.

## Checked source boundaries

- `packages/ui-runtime/README.md`
- `packages/ui-runtime/src/index.ts`
- `packages/ui-runtime/src/timeline.ts`
- `packages/ui-runtime/src/approval-timeline.ts`
- `packages/ui-runtime/src/types.ts` and `approval-types.ts`
- `docs/architecture/sdk-architecture.md`, section 3.3 (current server
  boundaries) and adapter capability sections

Baseline: BYOK main `329780b6562706f1ae57d1970cc1d77bf35738b5`.
