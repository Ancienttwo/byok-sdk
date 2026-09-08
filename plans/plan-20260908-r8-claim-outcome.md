# Plan: R8 atomic claim admission

> **Status**: In Progress
> **Spec**: docs/spec.md
> **Base**: afbb02262afbcea1b933d2784be6f640c287b62a

## P1 / P2 / P3

- P1: cloud inbound owns protocol admission and envelope dedup. TaskAttemptStore
  owns immutable claim identity via CAS; in-memory mutation and Postgres guarded
  UPDATE return the winning attempt. No client, storage schema or public API change.
- P2: two handlers read an unclaimed attempt, validate inventory/sealed offer,
  then claim different harnesses. The store retains one identity but applyLifecycle
  previously discarded its return and completed both inbound envelopes.
- P3: inspect the atomic returned owner/runtime/harness before envelope completion.
  Reject absent ownership or conflicting identity, preserving same-identity
  retries and immutable capabilities. Never infer ownership from the earlier read.
  At 10x concurrency the race becomes frequent; no process-local lock can replace
  distributed store authority. No new queue or persistence authority is needed.

## Task Breakdown

- [x] Merge accepted R9 after both CI runs passed 23/23; verify identical merged tree.
- [x] Reproduce R8 with deterministic concurrent inbound claims against the real store.
- [x] Check returned claim identity before dedup; cover conflicts and same-identity replay.
- [ ] Run required checks; commit/push and record exact-head CI.

## Root Cause Evidence

- Trigger: two valid claim envelopes with different execution identities reach CAS.
- Observed: five conflicting-identity regression cases return accepted/accepted;
  expected results derived from persisted winner have one rejection.
- Cause: applyLifecycle ignored TaskAttemptStore.claim return value.
- Guard: barrier after prevalidation and before the real atomic store; assert
  admission outcome, dedup calls, immutable winner and repeated envelope behavior.

## Boundaries

Preserve root/R9 WIP. R8 only, no package publication/tag/deployment/migration.
An interruption terminal before any cloud claim cannot be followed by an accepted
claim: ownerDeviceId remains absent, even if the local daemon selected a harness.

## Local verification

Node 22.22.3 / Bun 1.4.0: full workspace test 3853 passed / 135 skipped;
build, typecheck, API surface (nine unchanged goldens), version authority,
strict workflow and diff checks pass. No full-test failures on this subject.
Postgres concurrency assertion is skipped locally by the existing substrate
contract and must run in the real-datastore CI job. Initial typecheck invoked
during build saw transient missing generated declarations; rerun after build
passes. Source now frozen; remote CI receipts belong on the PR.
