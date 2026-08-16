# Plan: P5 Keys Provider Profiles on TruthStore

> **Status**: Executing
> **Created**: 20260817-0026
> **Slug**: p5-keys-truth-store
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: P5 is triggered and changes a public persistence plus security/dependency boundary
> **Verification Boundary**: shared three-adapter contract suite, TruthStore CAS/integrity negatives, package graph, full workspace gates, independent semantic acceptance
> **Rollback Surface**: revert the coordinated PR before any separate publication; no data migration or deploy in scope
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md`
> **Task Review**: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md`
> **Implementation Notes**: `tasks/notes/20260817-0026-p5-keys-truth-store.notes.md`

## Agentic Routing
- Selected route: parent-agent:geju
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260817-0026-p5-keys-truth-store.md`
- Sprint contract: `tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md`
- Sprint review: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md`
- Implementation notes: `tasks/notes/20260817-0026-p5-keys-truth-store.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260817-0026-p5-keys-truth-store.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260817-0026-p5-keys-truth-store.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md`
- Review file: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md`
- Implementation notes file: `tasks/notes/20260817-0026-p5-keys-truth-store.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260817-0026-p5-keys-truth-store.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert the coordinated PR before any separate publication; no data migration or deploy in scope
- **Verification boundary**: shared three-adapter contract suite, TruthStore CAS/integrity negatives, package graph, full workspace gates, independent semantic acceptance
- **Review/acceptance boundary**: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: P5 is triggered and changes a public persistence plus security/dependency boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260817-0026-p5-keys-truth-store.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md`, `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md`, and `tasks/notes/20260817-0026-p5-keys-truth-store.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert the coordinated PR before any separate publication; no data migration or deploy in scope

## Captured Planning Output

# P5 Keys Provider Profiles on TruthStore

## Thesis

Make `TruthStore` the optional injected persistence authority for a tenant's complete model-provider registry, not a mirror beside SQLite. The public `ProviderProfileStore` contract becomes async once; a new TruthStore-backed adapter stores one deterministic, versioned, secret-free registry snapshot under CAS. InMemory and SQLite remain independently selected local adapters, never fallbacks or dual-write replicas.

## Confidence

- **Confidence**: high. Repo authority explicitly allows `keys -> core`, host-injected `TruthStore`, cloud profile metadata/hash/revision, local conflict resolution, and forbids `keys -> protocol`, secrets in truth, cloud client construction, and dispatch access to keys.
- **[UNKNOWN]** No in-repo host currently composes the new adapter. This does not block the SDK contract; conformance uses `InMemoryTruthStore` and a tenant-bound host composition fixture.
- **[ASSUMED]** The registry is one TruthStore snapshot, not one record per provider, because delete and “at most one enabled” must commit atomically and TruthStore has no multi-key transaction/delete port.

## Geju Frame

- **Inherited constraint**: the existing synchronous SQLite-shaped port.
- **Decision**: it is implementation history, not a contract worth preserving. P5 was already reserved as a dependency/security-boundary change, and prior architecture research intended async persistence.
- **Kill list**: synchronous `ProviderProfileStore`; any local+truth dual write; any secret-bearing truth body; any automatic conflict merge; any `@byok-sdk/protocol` edge.
- **First proof point**: the shared profile-store contract suite passes against InMemory, SQLite, and TruthStore, while a stale CAS writer fails closed and captured TruthStore bodies contain no configured secret.
- **Falsifier**: if one registry snapshot cannot preserve public profile behavior, bounded size, deterministic bytes, or CAS conflict observability without a second authority, stop before shipping and redesign the core contract rather than add a compatibility path.

## P1 — Architecture Map

- Product authority: `docs/spec.md`, `docs/security.md`, `docs/architecture/sdk-architecture.md`, P5 in `ARCHITECTURE-PROPOSAL-byok-platform.md`.
- Existing profile domain: `packages/keys/src/provider-profile.ts`.
- Existing persistence port/adapters: `packages/keys/src/profile-store.ts`, `packages/keys/src/sqlite-profile-store.ts`.
- Registry owner joining profile metadata and OS secrets: `packages/keys/src/registry.ts`.
- Truth contract: `packages/core/src/truth.ts`; reference implementation: `packages/core/src/in-memory/truth.ts`.
- Package boundary: `packages/keys/package.json`, `bun.lock`, `scripts/release/check-package-graph.mjs`.
- Pi custody launcher remains SQLite-selected and read-only; this slice does not make the daemon or cloud depend on keys and does not provision secrets remotely.
- Out of scope: protocol/wire changes, cloud routes, secret transport, automatic remote-to-SQLite replication, Pi launcher redesign, production deployment, npm publish.

## P2 — Concrete Trace

1. A host binds an authenticated `TenantId`, a `TruthStore`, and a local `SecretStore` into `ProviderRegistry`.
2. `configure()` validates the non-secret profile and writes/validates the OS secret first, preserving the existing “no authenticating profile without a secret” invariant.
3. The TruthStore adapter reads the fixed `profile` record, parses its strict versioned body, validates every profile, and retains its revision.
4. The adapter applies the registry mutation in memory, preserves `created_at`, enforces at most one enabled provider, sorts by provider ID, serializes deterministic UTF-8 JSON, computes SHA-256, and calls `writeSnapshot(expectedRev)`.
5. A revision miss surfaces a stable typed keys error carrying no body or secret; the adapter does not retry, merge, or overwrite.
6. Reads parse and hash-check the authoritative inline body before returning profiles. Object bodies, malformed schema, hash/size mismatch, or duplicate providers fail closed.
7. `ProviderRegistry` reports `secret_configured` only by consulting the local secret store. Truth receives profile metadata only.
8. InMemory and SQLite adapters implement the same async port directly. The standalone Pi launcher explicitly awaits its selected SQLite adapter and retains its existing credential-custody boundary.

Error paths: invalid tenant/profile/body/hash/size/revision and TruthStore conflict are explicit failures; no absence-to-empty fallback after a malformed record; no compatibility shim for synchronous consumers.

## P3 — Design Decision

- Store the entire bounded provider registry as one `profile` snapshot with a fixed namespaced record key and schema version. Four closed provider IDs bound the body and make one CAS the correct atomicity unit.
- Make `ProviderProfileStore` async across the package. This is the smallest coherent cut because `TruthStore` is async and sync wrappers would invent blocking or stale cache authority.
- Use deterministic explicit JSON projection and SHA-256; validate schema, byte length, content hash, provider uniqueness/order, and profile invariants on every read.
- Keep conflicts host-resolved. The adapter exposes the conflict as typed authority failure and never auto-reloads/replays a mutation.
- Add `@byok-sdk/core` as the sole permitted BYOK dependency of keys; keep protocol forbidden and reverse dispatch-to-keys edges forbidden.
- Align the keys Node floor and package/release graph with the core dependency. This is a prepared breaking package change; do not publish without a separate release authorization.
- At 10x, contention on one tenant registry snapshot fails first. The domain is bounded to four provider IDs, so this is acceptable; if the domain becomes open-ended, revisit the aggregate boundary rather than shard prematurely.

## Scope

### In scope

- Async `ProviderProfileStore` and all keys callers/tests.
- `TruthProviderProfileStore` (name may vary only for established repo naming consistency), strict codec, CAS and integrity errors.
- Shared behavioral tests across all three adapters plus truth-specific negative tests.
- Public exports and package README/security/spec/architecture documentation.
- Keys → core dependency, lockfile, package-graph invariant updates, honest version/engine metadata required by the dependency.
- Consume the P5 deferred ledger row at closeout.

### Out of scope

- Any `@byok-sdk/protocol` dependency or wire change.
- Changes under `packages/client`, `packages/server`, `packages/cloud`, or `packages/cloud-dataplane` except tests/docs proving they remain dependency-isolated.
- Secret upload, cloud-side provider client construction, or server-side secret status inference.
- Dual-write/migration from an existing SQLite database. A future operator migration, if demanded, must be explicit, one-shot, and separately approved.
- npm publication or deployment.

## Task Breakdown

- [ ] T1 Freeze the async profile-store contract and update InMemory/SQLite implementations, registry, launcher, and shared tests in one coordinated cut.
- [ ] T2 Implement the tenant-bound TruthStore adapter with strict versioned aggregate codec, deterministic hashing, CAS, integrity validation, typed failures, and zero secret fields.
- [ ] T3 Add conformance and negative tests: empty registry, configure/update/delete/default selection, created-at preservation, one-enabled invariant, deterministic bytes/hash/size, stale writer conflict, malformed/object/hash/size/duplicate/secret-shaped body rejection, tenant isolation.
- [ ] T4 Update public exports, keys/core dependency graph, Node/version metadata, lockfile and release graph rules; prove keys reaches core but never protocol and dispatch packages never reach keys.
- [ ] T5 Update spec/security/architecture/README to record the authority, conflict, migration, launcher, and non-secret boundaries; remove the completed P5 Todo row at workflow closeout.
- [ ] T6 Run targeted keys/core/package-graph tests, then full build/typecheck/test and strict workflow verification; freeze review subject and complete independent semantic acceptance.

## Stop Conditions

Stop without adding a fallback if:

- TruthStore cannot express the aggregate atomically with one snapshot CAS.
- Existing public behavior requires secret material in the truth body.
- The package graph would create `keys -> protocol` or any `client/server/cloud -> keys` edge.
- The Pi custody launcher would need remote credentials, a network listener, or daemon access to the secret.
- A migration would require steady-state dual reads/writes.
- The shared behavioral suite cannot make local and truth adapters agree without weakening fail-closed semantics.

## Workflow Inventory

- Active plan: this captured `plans/plan-*.md`.
- Contract/review/notes: generated under `tasks/contracts/`, `tasks/reviews/`, and `tasks/notes/` using the same plan stem.
- Deferred ledger: `tasks/todos.md` (P5 row consumed only after verified completion).
- Evidence: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and contract-bound acceptance receipt.
- Allowed-path owner: one implementation worktree owns `packages/keys/**`, `packages/keys/package.json`, `bun.lock`, `scripts/release/check-package-graph.mjs`, the named product/security/architecture docs, and generated workflow artifacts.
- Isolation: execute only in the linked `codex/p5-keys-truth-store` contract worktree; merge target is `main`.

## Promotion Gate

- **Merge/PR unit**: one coordinated breaking keys persistence PR; no partial async port or codec-only merge.
- **Rollback surface**: revert the PR before publication. No production data migration or external write is authorized.
- **Independent verification boundary**: contract-bound semantic acceptance reviews the frozen diff, CAS/integrity/security negatives, dependency graph, and package artifacts.
- **High-risk surface**: credential-adjacent package, tenant-scoped persistence, public async API, package dependency/engine change.
- **Why not a checklist row**: this changes a public persistence contract and security/dependency authority across package, docs, tests and release graph.

## Evidence Contract

- **State/progress path**: active plan Task Breakdown, contract status, implementation notes, and checks receipt.
- **Targeted evidence**: keys unit/contract tests; core TruthStore reference tests used by the adapter; release package-graph check; clean pack/install/import smoke if required by the contract.
- **Full evidence**: `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`.
- **Evaluator rubric**: one async profile authority per selected adapter; deterministic secret-free truth body; CAS conflicts and malformed authority fail closed; no forbidden package edge; existing registry golden behavior preserved.
- **Stop condition**: any Stop Condition above, or three failed fix/reverify rounds for the same issue.
- **Rollback**: tree revert only; no data rollback because migration and deployment are out of scope.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] T1 Freeze the async profile-store contract and update InMemory/SQLite implementations, registry, launcher, and shared tests in one coordinated cut.
- [ ] T2 Implement the tenant-bound TruthStore adapter with strict versioned aggregate codec, deterministic hashing, CAS, integrity validation, typed failures, and zero secret fields.
- [ ] T3 Add conformance and negative tests: empty registry, configure/update/delete/default selection, created-at preservation, one-enabled invariant, deterministic bytes/hash/size, stale writer conflict, malformed/object/hash/size/duplicate/secret-shaped body rejection, tenant isolation.
- [ ] T4 Update public exports, keys/core dependency graph, Node/version metadata, lockfile and release graph rules; prove keys reaches core but never protocol and dispatch packages never reach keys.
- [ ] T5 Update spec/security/architecture/README to record the authority, conflict, migration, launcher, and non-secret boundaries; remove the completed P5 Todo row at workflow closeout.
- [ ] T6 Run targeted keys/core/package-graph tests, then full build/typecheck/test and strict workflow verification; freeze review subject and complete independent semantic acceptance.
