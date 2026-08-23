# Plan: Task-free Agent-home projection

> **Status**: Completed
> **Created**: 20260824-0239
> **Slug**: agent-home-profile-projection
> **Planning Source**: user-approved-consumer-contract
> **Orchestration Kind**: host-plan
> **Source Ref**: Salesko `41d908fd53822212c4c5d69e2334fe23dac041d8`
> **Artifact Level**: work-package
> **Promotion Reason**: A frozen downstream consumer proves that Profile creation cannot project into an offline exact device until BYOK owns a durable task-free control.
> **Verification Boundary**: Frozen SDK source, protocol/client/cloud/server/dataplane tests, full checks, packed tarball RC, and exact Salesko consumer acceptance; no merge, push, npm publish, deploy, production migration, or secrets.
> **Rollback Surface**: Delete or revert only branch `codex/agent-home-profile-projection`; no external state is created.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260824-0239-agent-home-profile-projection.contract.md`
> **Task Review**: `tasks/reviews/20260824-0239-agent-home-profile-projection.review.md`
> **Implementation Notes**: `tasks/notes/20260824-0239-agent-home-profile-projection.notes.md`

## Goal

Add one generic, capability-gated, task-free exact-device control that durably
projects a bounded opaque value into the SDK-owned canonical Agent home and
records an exact durable completion outcome bound to tenant, device, AgentRef,
profile revision, projection hash, and request identity.

## Frozen Downstream Authority

- Commit: `41d908fd53822212c4c5d69e2334fe23dac041d8`.
- Composite semantic manifest: `sha256:6da37b5181495afa8faedf52335a9348bffd129fa66730a8328c8646859446c3`.
- Ordered subjects: contract test `a5d9308f79c02117fb0713736109daff0d3dc6c3a155321b1a6d671004f35c6c`, falsifier `40a5b9cb5bc403dd85c76d267a534229b3de36d794a3e9f3132654f38672fb7e`, contracts index `5768b043c6c84203579b77a44128a69ea36f195d46d25008fb876118030a920f`, architecture `ad24c246729fbdc4bc5862c188325f9ee605dc870fccb0d2518a73947c8683c8`.
- Semantics are frozen. Public naming may change once against packed RC and must then be re-frozen downstream.

## P1: Architecture Map

- `packages/protocol`: additive capability, task-free server-to-daemon message,
  exact completion receipt, bounded opaque JSON and hash/request schemas.
- `packages/cloud`: authenticated tenant/exact-device capability admission,
  durable desired-state/status API and mailbox enqueue/readback.
- `packages/cloud-dataplane`: restart/isolation conformance over the existing
  durable `RequestReceiptStore`; no second table or migration authority.
- `packages/server`: embedded reference-host parity for enqueue, durable status,
  and exact receipt ingestion.
- `packages/client`: daemon handler, canonical Agent-home lifecycle, single
  writer, ordering state, hook invocation, fsync, exact receipt post, and
  cursor-preserving failure behavior.
- Downstream/host chooses `hostStorageRoot`, owns opaque Profile schema and the
  hook that writes `profile.json`; it never composes `agents/<agentId>`.
- Out of scope: provider slug/endpoint, standing instructions, Salesko fields,
  credentials, `.salesko`, product delete/UI semantics, local Agent-home
  deletion, task/session/runtime creation, publication or rollout.

## P2: Concrete Trace

1. Authenticated host calls `enqueueAgentHomeProjection` with tenant authority,
   exact device, exact AgentRef, request id, projection hash and bounded opaque
   projection.
2. Cloud verifies the durable device capability before allocating durable
   desired state/mailbox sequence; it never reroutes an offline device.
3. Daemon receives the task-free envelope outside `TaskRunner`. The SDK resolves
   `<hostStorageRoot>/agents/<agentId>`, validates realpath/existing ancestors,
   acquires the Agent single-writer lease, initializes/preserves `MEMORY.md` and
   `notes/`, and checks durable local revision/hash state.
4. Lower revisions reject stale; equal revision/equal hash is idempotent; equal
   revision/different hash conflicts; higher revision invokes the host hook with
   the SDK-supplied canonical cwd and opaque value.
5. SDK atomically fsyncs local projection state, PUTs an exact completion to a
   dedicated authenticated endpoint, and returns only after durable exact
   readback. Only then may the
   connection cursor advance and mailbox delivery retire.
6. Busy/path/hook/fsync/receipt failures throw, do not advance cursor or ack, and
   redeliver after reconnect/restart. No task, journal, runtime session, terminal
   event, or runtime process is created.

## P3: Design Decision

- Use a distinct message/capability rather than a fake task or `workspaceHint`.
- Persist projection desired state/status separately from mailbox cursor because
  enqueue is not local sync and consumers require exact request/result readback.
- Keep `AgentRef.profileRevision` globally opaque; the projection contract uses
  a canonical comparable decimal revision and requires exact equality with the
  AgentRef value. No heuristic parser or fallback authority is introduced.
- Use one SDK-owned internal local ordering record under `.byok`; downstream
  files remain opaque. Local deletion is not part of this slice.
- At 10x scale, the first pressure point is per-device mailbox/backlog and
  same-Agent contention. Reuse the existing durable mailbox and Agent lease;
  do not create a second task scheduler.

## Task Breakdown

- [x] Freeze protocol/public API/storage documentation and negative matrix.
- [x] Implement protocol capability, message, receipt and frozen codec/goldens.
- [x] Implement cloud/server/dataplane durable enqueue, status and exact receipt.
- [x] Implement client canonical-home projection, ordering, lease/fsync and retry.
- [x] Prove capability omission, malformed/oversize payload, absence of any
  credential-specific protocol field,
  traversal/symlink/cross-Agent, stale/conflict/idempotency, busy overlap,
  offline/restart redelivery, exact receipt, and zero task/runtime side effects.
- [x] Run build/typecheck/full tests, strict workflow and independent frozen gate.
- [x] Pack an aligned unpublished RC with manifest/hash/declaration readback.
- [x] Run Salesko falsifier and consumer acceptance against the exact RC bytes;
  freeze any one-time naming adjustment and report registry as unpublished.

## Stop Conditions

- Stop if implementation must interpret Salesko Profile fields, accept credential
  bytes, compose `.salesko`, add provider/endpoint/instructions behavior, delete
  local Agent files, or weaken exact-device/capability/path/lease/receipt checks.
- Stop before merge, push, npm publish, deploy, production migration, secret
  mutation, or downstream production wiring.
- Any semantic change to the frozen downstream manifest requires a new Salesko
  composite hash before BYOK continues that change.

## Promotion Gate

- Merge/PR unit: this complete task-free projection work-package on the isolated
  branch; partial protocol-only or client-only diffs are not promotable.
- Rollback surface: revert/delete the isolated branch and packed RC directory.
- Verification boundary: the commands and cross-repo exact-RC acceptance below.
- Review/acceptance boundary: one frozen source subject, a prepared Change Assessment,
  typed AcceptanceReceipt, and independent gatekeeper PASS.
- High-risk surface: durable protocol/storage authority, canonical path and
  cursor retirement; all require deterministic plus restart readback oracles.
- Why not checklist row: this crosses five public packages and creates a durable
  authority/receipt contract that must be released and consumed atomically.

## Evidence Contract

- State/progress path: this plan, matching contract, notes, review, and
  `.ai/harness/checks/latest.json`.
- Verification evidence: focused contract tests, full repository checks,
  Postgres/restart readback, packed RC manifest/declarations, and exact Salesko
  consume commands.
- Evaluator rubric: exact identity binding, fail-closed redelivery, zero task or
  runtime side effects, and unchanged frozen downstream semantics.
- Stop condition: all checklist items complete and independent review passes;
  registry publication remains explicitly outside the terminal state.
- Rollback surface: isolated source branch and disposable RC/consumer installs.

## Verification

- Focused protocol/client/cloud/server/dataplane contract tests and exact public
  declaration readback.
- `bun run build`, `bun run typecheck`, `bun run test`,
  `bun run check:release-graph`, `bun run check:release-pack`,
  `repo-harness run check-task-workflow --strict`, and `git diff --check`.
- `repo-harness run verify-contract --contract tasks/contracts/20260824-0239-agent-home-profile-projection.contract.md --strict` plus independent gatekeeper review of one frozen source subject.
- Pack-and-smoke in a disposable output directory, then exact-tarball Salesko
  falsifier/consumer tests without changing formal downstream pins.
