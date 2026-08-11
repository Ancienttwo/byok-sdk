# Plan: Sprint S2: @byok/core Contracts and Conformance Foundation

> **Status**: Archived
> **Created**: 20260807-1829
> **Slug**: s2-byok-core-contracts
> **Artifact Level**: work-package
> **Promotion Reason**: Third delivery sprint (S2 = P0 + T1) of the RAFT-aligned platform program: a new workspace package (`@byok/core`) holding the protocol-free, Node-free platform contracts and the conformance harness every later composition (S3 cloud, S4A Postgres+R2, self-hosted) must pass. Purely additive, but a wrong contract propagates into every subsequent sprint — needs contract-level scope authority, its own worktree, and machine-checked isolation of the existing packages.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build` (Node 20/22 via CI), `git diff --exit-code packages/protocol/src/__tests__/golden/`, `git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/ packages/client/src/` (S2.4: no existing package changes), `repo-harness run check-task-workflow --strict`, plus the S2.2 core-constraints tests and S2.4 acceptance criteria in `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`.
> **Rollback Surface**: Delete `packages/core` (the workspace glob `packages/*` picks it up automatically, so removal is file deletion plus the lockfile). No existing package may depend on core until its contract suite passes (sprint S2.5) — this slice creates zero inbound dependencies, so rollback is a pure subtraction with no residue.
> **Spec**: `docs/spec.md`
> **Research**: `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` (Sprint S2), `docs/architecture/sdk-architecture.md` §12.1-12.3 (target package graph, core responsibilities, four state models), §12.6 (identity/proof), §12.7.6-12.7.7 (entitlement/reservation shapes and stable error codes), `docs/researches/tenant-isolation-decision.md` §7 (T1)
> **Task Contract**: `tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md`
> **Task Review**: `tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md`
> **Implementation Notes**: `tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: Greenfield package with eleven stories whose value is contract precision; design decisions are pinned by the parent from the architecture doc, execution goes to a single deep-worker (self-contained package, no cross-file contention), docs/card closure to a fast-worker, acceptance to the gatekeeper.
- Due diligence:
  - P1 map: target package graph (`docs/architecture/sdk-architecture.md` §12.1): `core` is zod-only, protocol-free, Node-free; future consumers are `cloud`/`client`/`server` (S3+) and `keys → core` contracts-only (P5, deferred). Nothing imports core this slice. Workspace: `pnpm-workspace.yaml` `packages/*` already covers the new directory (verified); CI runs `pnpm -r` so Node 20/22 coverage is automatic.
  - P2 trace: the contracts this package freezes are the ones S3-S6 build on — mailbox read-without-ack → cursor-ack (§12.7.3), board claim/`expectedStatus` CAS + per-tenant `board_seq` (§12.3), truth `task.terminal` first-immutable-hash-wins + `profile/memory` `expectedRev` CAS (§12.3), quota `committed + reserved <= hardLimit` with entitlement version CAS (§12.7.6-12.7.7), device-proof canonical bytes deterministic across key insertion order (§12.6.3, JCS + domain prefix). The conformance harness parameterized by composition is the mechanism that keeps S4A's Postgres+R2 assertions byte-for-byte identical to the InMemory reference.
  - P3 decision rationale: contracts-before-implementations is the whole point of P0 — S3's stateless handlers must code against ports that already have behavioral tests, or the InMemory and SQL semantics drift (exactly what the shared suite prevents). Node-free matters because `@byok/cloud` targets Workers-compatible runtimes; protocol-free matters because `keys → core` (P5) must not create a transitive `keys → protocol` edge (§12.1 invariant, ADR-003/012). Crypto verification is an injected port, not an implementation, for the same reason. `TenantId` becomes branded here with a single mint point (I7's grep/lint test); the S1 server keeps its local alias until a later slice migrates it — S2.4 explicitly forbids touching existing packages, so the migration is S3+ work.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-1829-s2-byok-core-contracts.md`
- Sprint contract: `tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md`
- Sprint review: `tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md`
- Implementation notes: `tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan `plans/plan-20260805-1659-byok-keys-package.md` stays Executing (K4 cross-repo, waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure, exactly as S0/S1 did.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-1829-s2-byok-core-contracts.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-1829-s2-byok-core-contracts.md`.

## Approach
### Strategy
Build `packages/core` (`@byok/core`) from zero per sprint S2.3's file tree: contracts, schemas, stable errors, and one InMemory reference implementation, plus the conformance harness that all later compositions run unchanged. Zero changes to the four existing packages (machine-checked). The architecture-event hook will open a request card when `packages/core/package.json` appears — the slice closes it with a snapshot ruling per the established pattern.

Story order:

1. **C-001/C-002 — scaffold + identity**: package skeleton (zod runtime dep only; tsup/tsc/vitest dev idiom copied from `packages/keys`); branded `TenantId` with a single mint point (`tenantId()` factory in `tenant.ts`), `DevicePrincipal`/`ControlPlanePrincipal` in `principals.ts`.
2. **C-003~C-008/C-010 — ports and shapes**: `mailbox.ts` (append/read-after-cursor without ack/cursor-ack/retention hooks), `board.ts` (5-state vocabulary, legal transitions, claim/unclaim CAS, `expectedStatus` CAS, per-tenant `board_seq`, conflict returns holder/current snapshot), `truth.ts` (terminal first-immutable-hash-wins + `409`-style `terminal_conflict`, `profile`/`memory` snapshots with `expectedRev` CAS, manifest listing), `presence.ts` (5-level TTL hints + activity tail with explicit `dropped`), `blob.ts` (sha256 content address + object metadata/manifest/reference states), `quota.ts` (`TenantStorageEntitlement`/`TenantStorageUsage` per §12.7.6 verbatim incl. `bigint` fields and version CAS; reservation lifecycle reserve→finalize/abort; stable error codes table from §12.7.7), `capabilities.ts` (declaration schema per ADR-010), `errors.ts` (one taxonomy, every conflict carries the current snapshot), `stores.ts` (every port method tenant-first: first parameter `TenantId`).
3. **C-009 — attestation ports**: `attestation.ts` — `DeviceProofEnvelopeV1` schema (protected claims per §S6.2 shape, schema only), dependency-free JCS-style canonicalizer (deterministic across key insertion order), domain prefix `byok-device-proof-v1\n`, injectable signature-verify port (no crypto import — Node-free); canonical-bytes golden fixture under `packages/core/src/__tests__/golden/` (explicitly outside the protocol golden).
4. **C-011 — InMemory reference + conformance**: `in-memory/` implements every port; `src/__tests__/conformance/` is the composition-parameterized behavioral suite (factory in, assertions fixed) — the S2.2 constraint list becomes executable: tenant isolation on every port, mailbox read-does-not-ack, board/truth/quota determinism, no-overcommit, canonicalizer stability.
5. **Constraint tests + docs**: source-scan tests prove no `@byok/protocol` and no `node:` imports; I7 tenant-first method inventory + `as TenantId` mint-point grep; architecture package graph updated TARGET → partial CURRENT; hook card closed via snapshot; `machines.list()` todos row ruled (embedded operator surface is host-global by design — the embedding host owns all tenants; hosted tenant-scoped surfaces arrive with `@byok/cloud` on these tenant-first ports).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Contracts + InMemory + conformance in one package now | S3+ codes against tested behavior; suite reuse is structural | Contracts can still be wrong; later fixes are breaking | **Use** — the conformance suite is exactly the cost that makes later drift visible (sprint P0) |
| Conformance as a public subpath export | S4A imports it cleanly | Widens the public API beyond S2.2's constraint list | Rejected — sprint S2.3 tree puts it in `src/__tests__/conformance/`; S4A story O-005 owns its packaging decision |
| Hand-rolled JCS canonicalizer (dependency-free) | Node-free, Workers-safe, zero new deps | RFC 8785 edge cases (number serialization) need care | **Use** — scope it to the JSON shapes the envelope allows (strings/objects/arrays/safe ints), reject floats/exotic numbers fail-closed; golden pins the bytes |
| Crypto verify implemented in core | One less port | Breaks Node-free; Workers/Node crypto differ | Rejected — injectable port, compositions bring their own |
| Migrate server's `TenantId` alias to core now | One type earlier | Violates S2.4 "no existing package runtime behavior changes" | Rejected — S3+ migration when server first imports core |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/core/package.json` | Create | `@byok/core` 0.1.0, `dependencies: { zod }` only; scripts/build idiom copied from `packages/keys`; engines `>=20` |
| `packages/core/tsconfig.json` + `tsconfig.build.json` + `tsup.config.ts` | Create | Match sibling package idiom |
| `packages/core/src/{tenant,principals,mailbox,board,truth,presence,blob,quota,attestation,capabilities,errors,stores,index}.ts` | Create | Sprint S2.3 tree; contracts/schemas/errors only |
| `packages/core/src/in-memory/**` | Create | Reference implementation of every port |
| `packages/core/src/__tests__/**` | Create | `conformance/` (factory-parameterized), `tenant.test.ts`, `board.test.ts`, `attestation.test.ts`, constraint tests (import scan, tenant-first inventory, mint-point grep), `golden/` canonical-bytes fixture |
| `pnpm-lock.yaml` | Update | New package + zod resolution (mechanical) |
| `docs/architecture/sdk-architecture.md` | Edit | §12.1 package graph: core TARGET → CURRENT (implemented, isolated — no consumers yet); §1.2 note; ledger updates |
| `docs/architecture/requests/*` + `snapshots/` + `index.md` | Edit/Create | Close the hook-generated card for `packages/core/package.json` with a snapshot ruling; `architecture-queue reindex` |
| `tasks/todos.md` | Edit | Rule the `machines.list()` row: embedded operator surface host-global by design; hosted tenant scoping lands with `@byok/cloud` |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | S2 acceptance marks |
| `packages/protocol/**`, `packages/keys/**`, `packages/server/**`, `packages/client/**`, `examples/**` | Do not touch | S2.4: zero existing-package changes, machine-checked against main |

### Code Snippets
Branding and mint point (I7's grep target):

```ts
// tenant.ts — the ONLY place `as TenantId` may appear outside test fixtures
export type TenantId = string & { readonly __byokTenantId: unique symbol };
export function tenantId(value: string): TenantId; // validates non-empty, returns branded
```

Stable storage error codes (§12.7.7 verbatim):

```ts
type StorageErrorCode =
  | 'storage_object_too_large'      // 413
  | 'storage_quota_exceeded'        // 507
  | 'storage_reservation_expired'   // 409
  | 'storage_integrity_mismatch'    // 422
  | 'storage_write_suspended';      // 423
```

Conformance harness shape (assertions fixed, factory in):

```ts
export interface CoreCompositionFactory { mailbox(): MailboxStore; board(): BoardStore; /* … */ }
export function runCoreConformance(name: string, factory: CoreCompositionFactory): void;
```

### Data Flow
No runtime data flow this slice — the package has no consumers by design. The behavioral flows the contracts encode: mailbox append → read-after-cursor (no ack) → cursor-ack → retention-eligible; board claim CAS (one winner, losers get holder snapshot) → `expectedStatus` transitions → per-tenant `board_seq`; truth terminal first-hash-wins / snapshot `expectedRev` CAS; quota reserve (no-overcommit under the version-CAS'd entitlement) → finalize/abort; proof protected-claims → JCS canonical bytes → domain prefix → injected verify.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Wrong contract shape propagates to S3+ (R-005 class) | 中 | 高 | Shapes copied from the architecture doc's verbatim interfaces (§12.7.6-12.7.7, §12.3, §S6.2); gatekeeper diffs contracts against the doc |
| Core silently imports protocol/node (R-005) | 低 | 高 | Source-scan constraint tests + package.json dependency review in exit criteria |
| Canonicalizer bytes drift later | 中 | 极高 | Golden fixture outside protocol golden; determinism test shuffles key insertion order; float/exotic-number inputs fail closed |
| Board/wire vocabulary bleed | 中 | 高 | Constraint test: board module contains no wire state names; presence contains no board/wire names |
| Hook card left dangling blocks later slices | 中 | 中 | Card closure + snapshot + reindex is an explicit story in this slice (established S0/K4 pattern) |
| bigint/zod serialization confusion in quota shapes | 中 | 中 | Contracts keep `bigint` per the doc; serialization is composition concern, documented in the module header |

## Task Contracts
- Contract file: `tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md`
- Review file: `tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md`
- Implementation notes file: `tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR from the contract worktree; scaffold+identity / ports+shapes / attestation / in-memory+conformance / docs+card as separately reviewable commits.
- **Rollback surface**: Delete `packages/core` + lockfile regen; zero inbound dependencies by construction.
- **Verification boundary**: five standard gates + existing-packages zero-diff machine check + S2.2 constraint tests; CI Node 20/22.
- **Review/acceptance boundary**: Gatekeeper diff review against S2.4 + acceptance receipt; reviewer and implementer are different execution contexts.
- **High-risk surface**: contract precision (propagates to S3+); canonical-bytes golden (frozen once created); tenant-first inventory (I7).
- **Why not checklist row**: Program-foundational package whose contracts every later sprint builds on; needs its own scope authority, worktree, and machine-checked isolation.

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint §S2.4 boxes.
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md`.
- **Evaluator rubric**: All S2.4 boxes checkable with named test evidence; existing packages byte-identical to main; core import scan clean; InMemory passes the complete conformance suite.
- **Stop condition**: Any need to modify an existing package (`packages/{protocol,keys,server,client}` or `examples/`), any dependency beyond zod, any `node:` import in `src/` — stop, amend contract or escalate.
- **Rollback surface**: Revert the PR (pure package deletion; lockfile regenerates).

## Annotations

## Task Breakdown
- [x] C-001 Scaffold `packages/core` (zod-only deps, sibling build idiom, workspace auto-covered)
- [x] C-002 Branded `TenantId` + single mint point + `DevicePrincipal`/`ControlPlanePrincipal`
- [x] C-003 MailboxStore contract (read does not ack; cursor-ack; retention hooks)
- [x] C-004 BoardStore contract (5-state vocabulary, claim/`expectedStatus` CAS, per-tenant `board_seq`, conflict snapshots)
- [x] C-005 TruthStore contract (terminal first-hash-wins immutable; `profile`/`memory` `expectedRev` CAS; manifest)
- [x] C-006 Presence/Activity contracts (TTL hints; explicit `dropped`)
- [x] C-007 Blob/Object metadata contracts (sha256 address; manifest/reference states)
- [x] C-008 StorageEntitlement/Usage/Reservation/Retention contracts (§12.7.6-12.7.7 verbatim; stable error codes; version CAS; no-overcommit)
- [x] C-009 DeviceProof schema + JCS canonicalizer + domain prefix + injectable verify port + canonical-bytes golden (outside protocol golden)
- [x] C-010 Capability declaration schema (ADR-010)
- [x] C-011 InMemory reference + composition-parameterized conformance harness; S2.2 constraint tests (import scan, tenant-first inventory I7, mint-point grep, vocabulary isolation)
- [x] Docs: architecture package graph TARGET → partial CURRENT; hook card closed via snapshot + reindex; `machines.list()` todos row ruled
- [x] Full gates green incl. existing-packages zero-diff machine check
