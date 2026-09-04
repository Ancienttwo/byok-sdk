# Plan: Issues #135–#144 reliability closure

> **Status**: Executing
> **Created**: 20260905-0124
> **Slug**: issues-135-144-reliability
> **Artifact Level**: work-package
> **Promotion Reason**: Ten audited defects cross durable acknowledgement, inbound lifecycle, offer publication, relay liveness, and approval delivery boundaries.
> **Verification Boundary**: focused fault-injection tests per lane, root required checks, API/version gates, strict workflow, and an independent final gate.
> **Rollback Surface**: one integration branch assembled from three isolated lane commits; no push, issue close, publish, deploy, or migration is authorized.

## P1 Architecture Map

- Client lane: `ConnectionManager`, `LongPollClient`, the cursor store, and the `/byok/messages` response contract own durable inbound acknowledgement and outbound batch outcomes.
- Cloud inbound lane: `handleInboundEnvelope` and its tenant-bound task, receipt, board, activity, approval, egress, and dedup stores own retry convergence for daemon lifecycle facts.
- Offer/server lane: `ByokCloud` task publication, `TaskEventRelay`, `TaskHandle`, and approval timeline/control own pre-publication registration and idempotent host decisions.
- Deployment invariant: one tenant may own many devices, and each task/offer/approval remains bound to its exact `deviceId` plus optional exact `AgentRef`; no tenant-wide Profile shortcut is valid.
- Out of scope: protocol v2, compatibility shims, Profile/Placement decomposition, cross-device migration, Salesko `hostedJournal` composition/E2E, `ws/wss` cleanup, npm publication, production migration/deploy, tracker closure, and unrelated architecture/package-topology WIP.

## P2 Concrete Traces

1. Successful inbound handler -> cursor persistence -> next GET query cursor -> irreversible mailbox acknowledgement.
2. POST batch -> per-envelope cloud outcome -> typed response -> client outbox removal/quarantine/retry decision.
3. Daemon envelope -> ownership/attempt gate -> resumable lifecycle mutation -> completed dedup fact -> post-commit notification.
4. Host dispatch/approval -> stable task or decision identity -> task reservation/relay registration -> mailbox publication -> durable read-back.

## P3 Decision

- Wire acknowledgement exposes only the last successfully persisted cursor. Storage failure remains observable and cannot advance the server acknowledgement.
- Replace count-only POST outcomes with exact per-envelope outcomes so accepted entries and rejected entries have deterministic, non-blocking handling.
- Make lifecycle retries converge under stable envelope identity: dedup becomes a completed-fact marker, terminal projections resume from the first receipt, and unknown terminals fail before side effects.
- Reserve legacy attempts and relay state before offers become observable. Use stable identities and idempotent/resumable writes rather than swapping one partial-write window for another.
- Host approval retries reuse one stable decision identity, and id-less pre-M5 recovery preserves missing protocol identity while using stored request identity/revision for idempotency.
- Stable task/decision identity must retain exact device and AgentRef binding under tenant multi-device concurrency; it must not derive a single Profile from tenant identity.
- At 10x load, serialized store and client FIFO latency is the first pressure point; this slice does not add a second authority or unbounded retry loop.

## Parallel Ownership

- Client writer: `packages/client/**`, `packages/protocol/src/http-api.ts`, `packages/cloud/src/handlers/messages.ts`, and directly related tests for #135–#137.
- Inbound writer: `packages/cloud/src/inbound.ts` and directly related cloud tests for #138–#140.
- Offer/server writer: `packages/cloud/src/cloud.ts`, `packages/cloud/src/approval-control.ts`, `packages/server/**`, and directly related tests for #141–#144.
- Any newly discovered shared production file is handed back to the integration owner before editing.

## Task Breakdown

- [ ] T1 Implement and verify #135–#137 in the isolated client lane.
- [ ] T2 Implement and verify #138–#140 in the isolated cloud inbound lane.
- [ ] T3 Implement and verify #141–#144 in the isolated offer/server lane.
- [ ] T4 Integrate the three frozen lane commits and resolve only proven cross-lane contract conflicts.
- [ ] T5 Run focused crash/fault matrix and all repository required checks.
- [ ] T6 Record architecture/task evidence and independent acceptance verdict.
