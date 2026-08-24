# Plan: BYOK SDK 0.8.1 Enrollment Read Model Release

> **Status**: Archived
> **Created**: 20260824-1648
> **Slug**: release-0-8-1-enrollment-read-model
> **Artifact Level**: work-package
> **Promotion Reason**: The user approved formal publication of the credential-blind enrollment read model and downstream Salesko exact-pin acceptance; the already accepted 0.8.1 Agent-home repair train is the only unclaimed aligned release identity.
> **Verification Boundary**: Combined exact source, public client API/tests, full repository gates, frozen tarball graph, npm registry/tag/GitHub Release readback, and a separate Salesko exact-pin acceptance.
> **Rollback Surface**: Before the first registry write, discard this integration branch. After a package is published, complete and read back only the same immutable 0.8.1/0.3.2 set.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260824-1648-release-0-8-1-enrollment-read-model.contract.md`
> **Task Review**: `tasks/reviews/20260824-1648-release-0-8-1-enrollment-read-model.review.md`
> **Implementation Notes**: `tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md`

## Agentic Routing

- Selected route: strict release work-package in a new isolated worktree based on the accepted 0.8.1 repair candidate.
- P1: `DeviceStore` owns credential-bearing enrollment validation; `packages/client/src/index.ts` owns the public projection; package manifests own 0.8.1/keys 0.3.2; npm, Git tag, GitHub Release, and downstream lockfiles are distinct authorities.
- P2: device record -> `DeviceStore.load()` -> credential-blind union -> packed `@byok-sdk/client` -> npm registry readback -> Salesko exact pin -> setup/status/doctor readback.
- P3: add the already verified public union to the single unclaimed 0.8.1 train, then re-freeze the combined subject. Do not publish a second competing patch train, expose credentials, or add downstream parsing/fallbacks.

## Workflow Inventory

- Active plan: `plans/plan-20260824-1648-release-0-8-1-enrollment-read-model.md`
- Contract: `tasks/contracts/20260824-1648-release-0-8-1-enrollment-read-model.contract.md`
- Review: `tasks/reviews/20260824-1648-release-0-8-1-enrollment-read-model.review.md`
- Notes: `tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md`
- Deferred ledger: `tasks/todos.md`
- Checks: `.ai/harness/checks/latest.json`
- Runs: `.ai/harness/runs/`
- Worktree: `/Users/kito/Projects/byok-sdk-wt-release-0.8.1-enrollment-read-model`
- Scope authority: matching contract `allowed_paths`.

## Approach

1. Freeze the credential-blind client seam on top of accepted repair commit `bd24a106c462f79764a36f30080afc81dfd6c371`.
2. Verify the aligned 0.8.1 public train and independently versioned keys 0.3.2 are absent from npm and remote tag/Release authority.
3. Run focused/full gates and repository release-driver dry-run from one clean commit.
4. Materialize the user-approved acceptance receipt, publish/read back npm, push the exact source branch, tag, and GitHub Release.
5. Update Salesko only in its existing enrollment worktree, verify the fresh registry install, then merge and clean that bounded downstream branch.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Enrollment API publishes without complete record validation | Reuse `DeviceStore.load()` and focused missing/paired/re-pair/safety tests. |
| 0.8.1 silently drops the accepted replay repair | Base the release worktree exactly on `bd24a10` and rerun its focused/full gates. |
| Partial npm publication | Release driver resumes only missing artifacts at the same immutable versions and requires registry closure. |
| Registry success is mistaken for deployment | Keep deploy, production migration, and live-device rollout explicitly out of scope. |
| Downstream uses a local overlay | Require exact registry pins, frozen lockfile install, import/readback, and the Salesko contract suite. |

## Promotion Gate

- **Merge/PR unit**: accepted 0.8.1 repair candidate plus credential-blind client read model, tests, docs, and release evidence.
- **Rollback surface**: one unpublished integration branch before registry mutation; same-version completion after the first immutable write.
- **Verification boundary**: focused client/repair tests, full build/typecheck/test, package graph, tarball smoke, registry/tag/Release readback, then separate Salesko exact-pin verification.
- **Review/acceptance boundary**: the user's approval grants a waiver for this contract goal; the receipt must still bind the exact final subject and fresh verification packet.
- **High-risk surface**: public API publication and immutable registry/tag authorities.
- **Why not checklist row**: this crosses two repositories and four distinct release/consumer authorities.

## Evidence Contract

- **State/progress path**: this plan plus its contract, notes, review, checks, release manifest, registry/tag/Release readback, and the downstream Salesko contract.
- **Verification evidence**: exact source diff, focused/full gates, dry-run/execute release driver, fresh registry import, exact downstream lockfile and contract checks.
- **Evaluator rubric**: one SDK parser, zero credential projection, exact 0.8.1/0.3.2 closure, exact source/tag identity, and no local-overlay/fallback authority.
- **Stop condition**: stop before publication on dirty source, registry/tag collision, missing receipt, or failed gate; after first registry write preserve and complete only the same exact version set.
- **Rollback surface**: discard unpublished integration; published npm artifacts are immutable and require completion/readback rather than overwrite.

## Task Breakdown

- [x] Freeze authority map, combined release identity, registry vacancy, and isolation boundary.
- [x] Integrate the credential-blind enrollment read model on the accepted 0.8.1 repair candidate.
- [ ] Run focused/full verification and freeze a clean publish candidate.
- [ ] Materialize exact-subject acceptance and publish/read back npm, tag, and GitHub Release.
- [ ] Pin Salesko to the registry artifacts and close its enrollment contract.
- [ ] Merge and clean only the completed BYOK/Salesko branches; preserve unrelated WIP.
