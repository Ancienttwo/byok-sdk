# Implementation Notes: agent-home-profile-projection

> **Status**: Complete
> **Plan**: plans/plan-20260824-0239-agent-home-profile-projection.md
> **Contract**: tasks/contracts/20260824-0239-agent-home-profile-projection.contract.md
> **Review**: tasks/reviews/20260824-0239-agent-home-profile-projection.review.md
> **Last Updated**: 2026-08-24 04:36
> **Lifecycle**: notes

## Frozen Consumer Evidence

- Salesko commit `41d908fd53822212c4c5d69e2334fe23dac041d8` exists locally.
- Git-object SHA256 readback exactly matches all four ordered subjects supplied
  by the downstream handoff.
- Composite semantic manifest is
  `sha256:6da37b5181495afa8faedf52335a9348bffd129fa66730a8328c8646859446c3`.
- Pre-fix falsifier command is
  `bun test ./apps/byok-control/src/private-agent-profile-projection.falsifier.ts`;
  captured downstream evidence has real `PRE_FIX_EXIT=1` because
  `createInMemoryByokCloud().cloud.enqueueAgentHomeProjection` is undefined.
- Public naming may change once during packed-RC integration; semantics may not.

## P1 / P2 / P3

- P1: protocol owns wire/capability; cloud/dataplane own durable desired/status;
  client owns canonical home/lease/order/fsync; server mirrors reference hosting;
  downstream owns only opaque content and the canonical-cwd writer hook.
- P2: authenticated exact-device enqueue -> durable mailbox -> daemon task-free
  handler -> canonical home/lease/order/hook/fsync -> dedicated authenticated
  completion PUT and exact durable readback ->
  cursor advance. Any failure before exact receipt keeps delivery pending.
- P3: distinct control plus dedicated desired/status record. Mailbox cursor alone
  cannot truthfully expose local sync or same-revision hash conflicts.

## Design Decisions

- Provider slug/endpoint and standing instructions were removed because no
  independent downstream falsifier exists for them.
- Enqueue and completion are separate immutable `RequestReceiptStore` facts.
  Batch message counters are not completion evidence; only the exact completion
  endpoint readback can retire the control.
- No new table/migration is needed: the existing Postgres receipt authority
  already provides restart persistence and first-write immutability.
- SDK-internal local ordering evidence is under its reserved `.byok` namespace;
  Salesko files and artifact contents remain opaque.
- No fake task, task journal, runtime session, terminal event, or runtime launch.

## Deviations From Plan Or Spec

- The original scaffold mixed provider routing with projection. The authorized
  consumer contract narrowed this work-package to projection only.

## Open Questions

- Final public method/type names remain provisional until exact packed-RC
  Salesko acceptance. This is the only permitted downstream adjustment.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Downstream worktree:
  `/Users/kito/Projects/salesko-new-wt-private-agent-provider-home-projection`

## Source Freeze Verification

- Protocol 334/334, cloud 209/209, server 261/261, and client 1390/1390 tests
  pass with their package typechecks.
- Root build, sequential typecheck and full test pass. Full test includes
  client 1390, cloud 209, conformance 142, core 251, keys 373, protocol 334,
  server 261 and the remaining package/example suites; environment-dependent
  dataplane tests remain explicitly skipped in the generic run.
- Real disposable Postgres projection receipt restart/tenant/device isolation
  probe passed before the disposable substrate was removed.
- Release graph is aligned at dispatch `0.8.0` and keys `0.3.1`.
- Release pack correctly refused the dirty tree. The next evidence step is a
  local frozen source commit, followed by pack against that exact SHA; this is
  not a product or code failure.
- The daemon-level reference-server probe proves a failed completion persists
  cursor `0`, restart redelivers exact seq `2`, returns `idempotent`, invokes
  the product hook only once, and creates no task or runtime session.

## Promotion Filter

Promote only durable, verified architecture or reusable failure evidence; do
not promote transient command logs or provisional RC names.

## Final Acceptance

- Frozen implementation source: `1cc029a57c086a2473bb639fa58b26a93400aa02`.
- Unpublished RC manifest:
  `/Users/kito/Projects/byok-sdk-rc/20260824-agent-home-projection-1cc029a/release-manifest.json`,
  SHA-256 `c2b54fa8927e226b4ba020da39ddb1737e40afb29cf4f84e5dbd7f24f7061f6e`.
- Public train is `0.8.0`; independently versioned keys is `0.3.1`.
- Exact-tarball Salesko acceptance passed: falsifier 1/1, frozen contract 3/3,
  and byok-control 99/99 plus TypeScript.
- Independent exact-SHA gate returned PASS and the typed AcceptanceReceipt is
  `external_pass` with no findings.
- Registry publication, merge, push, deploy, production migration, secrets,
  and formal downstream pin remain outside this work-package.
