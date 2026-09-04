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
- Deployment invariant: tenant is `1:N` devices and `1:N` agents; one device may host `1:N` active AgentPlacements, while each agent currently has at most one active placement. Each task/offer/approval remains bound to exact `tenantId + deviceId + AgentRef`; no tenant-wide Profile shortcut or one-device-one-Agent key is valid.
- Out of scope: protocol v2, compatibility shims, Profile/Placement decomposition, cross-device migration, Salesko `hostedJournal` composition/E2E, `ws/wss` cleanup, npm publication, production migration/deploy, tracker closure, and unrelated architecture/package-topology WIP.

## P2 Concrete Traces

1. Successful inbound handler -> cursor persistence -> next GET query cursor -> irreversible mailbox acknowledgement.
2. POST batch -> frozen-v1 accepted/rejected counts -> bounded binary isolation -> client outbox removal/quarantine/retry decision.
3. Daemon envelope -> ownership/attempt gate -> resumable lifecycle mutation -> completed dedup fact -> post-commit notification.
4. Host dispatch/approval -> stable task or decision identity -> task reservation/relay registration -> mailbox publication -> durable read-back.

## P3 Decision

- Wire acknowledgement exposes only the last successfully persisted cursor. Storage failure remains observable and cannot advance the server acknowledgement.
- Preserve the frozen-v1 count response. On a mixed rejection, recursively split the immutable batch until each rejected envelope is isolated; duplicate replay is the existing idempotency authority, not a second response shape.
- Make lifecycle retries converge under stable envelope identity: dedup becomes a completed-fact marker, terminal projections resume from the first receipt, and unknown terminals fail before side effects.
- Reserve legacy attempts and relay state before offers become observable. Use stable identities and idempotent/resumable writes rather than swapping one partial-write window for another.
- Host approval retries reuse one stable decision identity, and id-less pre-M5 recovery preserves missing protocol identity while using stored request identity/revision for idempotency.
- Stable task/decision identity must retain exact `tenantId + deviceId + AgentRef` binding under multi-device and same-device multi-Agent concurrency; it must not derive a single Profile from tenant or device identity.
- At 10x load, serialized store and client FIFO latency is the first pressure point; this slice does not add a second authority or unbounded retry loop.

## Parallel Ownership

- Client writer: `packages/client/**`, `packages/protocol/src/http-api.ts`, `packages/cloud/src/handlers/messages.ts`, and directly related tests for #135–#137.
- Inbound writer: `packages/cloud/src/inbound.ts` and directly related cloud tests for #138–#140.
- Offer/server writer: `packages/cloud/src/cloud.ts`, `packages/cloud/src/approval-control.ts`, `packages/server/**`, and directly related tests for #141–#144.
- Any newly discovered shared production file is handed back to the integration owner before editing.

## Evidence Contract

- **State/progress path**: this plan, its contract, notes, workstream, and review.
- **Verification evidence**: three pre-fix failure artifacts; focused client/cloud/server regression suites; frozen protocol guard; root build, typecheck, test, API/version checks; strict workflow; one independent gatekeeper verdict.
- **Evaluator rubric**: durable cursor before wire acknowledgement; rejected-envelope isolation under frozen v1 counts; lifecycle retry convergence; attempt/relay registration before observable offer; stable approval identity; exact `tenantId + deviceId + AgentRef` admission and same-device multi-Agent isolation.
- **Stop condition**: every Task Breakdown row is evidenced, the independent gate passes, and repo-harness permits handoff.
- **Rollback surface**: the integration commits after baseline `aa44bb9`; no external system mutation.

## Promotion Gate

- **Merge/PR unit**: one #135–#144 SDK/cloud reliability slice assembled from the three isolated lanes.
- **Rollback surface**: client long-poll, cloud inbound/store contracts, server offer/relay/approval changes, tests, and generated API declaration.
- **Verification boundary**: exact frozen diff plus focused fault regressions, frozen-v1 protocol guard, all root required checks, and independent read-only review.
- **Review/acceptance boundary**: one gatekeeper evaluates the frozen subject; no merge, push, PR, issue close, publish, deploy, or migration is authorized.
- **High-risk surface**: durable acknowledgement, cross-store recovery, task publication ordering, approval idempotency, and multi-Agent placement identity.
- **Why not checklist row**: ten cross-module failure schedules require a bugfix contract, pre-fix evidence, architecture projection, and independent semantic acceptance.
- **Evidence ceiling**: this proves SDK/cloud behavior only; Salesko journal-before-ack E2E remains outside this branch.

## Task Breakdown

- [x] T1 Implement and verify #135–#137 in the isolated client lane.
- [x] T2 Implement and verify #138–#140 in the isolated cloud inbound lane.
- [x] T3 Implement and verify #141–#144 in the isolated offer/server lane.
- [x] T4 Integrate the three frozen lane commits and resolve only proven cross-lane contract conflicts.
- [x] T5 Run focused crash/fault matrix and all repository required checks.
- [ ] T6 Record architecture/task evidence and independent acceptance verdict.
