# Plan: Release entrypoint: reuse CI-frozen artifacts, account gate, publish before readback before tag

> **Status**: Executing
> **Created**: 20260906-2023
> **Slug**: release-entrypoint-artifacts
> **Artifact Level**: work-package
> **Promotion Reason**: The 0.14.0 / keys 0.4.0 candidate is frozen at `aa1d347` with CI green, but the release driver cannot consume that accepted evidence: `scripts/release/publish.mjs` always rebuilds and repacks (steps 2-3), and under `--execute` it tags before publishing and reading back (`:298-336`), while `deploy/runbooks/release-responsibility.md:25` requires registry readback before tagging. CI's `npm-release-pack` job packs the tarballs but never uploads them, so there is nothing to reuse. The local dry run also cannot finish on the operator machine (pack-and-smoke killed for memory twice).
> **Verification Boundary**: `test:scripts` (new `publish.test.mjs`), `check:release-graph`, `check:release-pack` unchanged, a real dry run of `publish.mjs --artifacts <dir>` against a locally produced release-pack directory, strict workflow check, gatekeeper.
> **Rollback Surface**: `publish.mjs` (new `--artifacts` mode, account gate, reordered execute path), `publish.test.mjs`, `package.json` `test:scripts`, one `upload-artifact` step in `ci.yml`, the runbook step, CHANGELOG.
> **Spec**: `docs/spec.md`
> **Research**: `deploy/runbooks/release-responsibility.md` §Release checklist; PR #152 body (exact-source CI and consumer receipts)
> **Task Contract**: `tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md`
> **Task Review**: `tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md`
> **Implementation Notes**: `tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md`

## Agentic Routing
- Selected route: main-loop planning; `deep-worker` execution in a contract worktree; `gatekeeper` acceptance (release path is high-risk).
- Routing reason: one script plus its test, one CI step, one runbook paragraph; the ordering change must be provable by test, not prose.
- Due diligence:
  - P1 map: `scripts/release/publish.mjs` (7-step driver, `--out-dir` only relocates the repack, `--execute` gates 5-7 = tag → publish → readback; `isPublished`, `topologicalOrder`, `readPublicManifests` exported), `scripts/release/pack-and-smoke.mjs` (produces `release-manifest.json` with `releaseVersion`, `sourceGitSha`, per-package `file` + `sha256`; requires a clean worktree), `scripts/release/registry-readback.mjs --manifest`, CI job `npm-release-pack` (3 OS, `check:release-pack --out-dir .ci-artifacts/release-pack`, no upload), `pg-migrate-smoke` consumes the same directory in-job, `test:scripts` runs two api-surface tests only, `beta-release.test.mjs` imports publish helpers with `node:test`.
  - P2 trace: operator runs `publish.mjs --execute --otp X` → step 1 registry candidacy → step 2 `bun run build` → step 3 repack + smoke (minutes, memory-heavy) → step 4 plan → step 5 `git tag -a vX` → step 6 `npm publish` per tarball → step 7 readback. A readback failure leaves a tag pointing at an unpublished or partially published train; the runbook forbids exactly that order.
  - P3 decision rationale: keep one driver and one manifest format. Add an `--artifacts <dir>` mode that consumes a `release-manifest.json` produced by CI for the exact `HEAD` (re-hash every tarball, refuse on any mismatch) and skips build/pack. Reorder the execute path to account gate → publish → readback → tag, with the "tag already exists" precondition checked before the first side effect. Make the runbook's "provenance/2FA policy" item executable: `npm whoami` must succeed and `npm profile get --json` must report `tfa.mode === 'auth-and-writes'`; no override flag (the policy is the gate). Provenance attestations need OIDC, so `--provenance` is passed only when `GITHUB_ACTIONS` is set; a local publish logs that provenance is not attached. CI uploads the ubuntu leg's release-pack directory as `release-pack-<sha>` so the operator downloads exactly the accepted bytes.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260906-2023-release-entrypoint-artifacts.md`
- Sprint contract: `tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md`
- Sprint review: `tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md`
- Implementation notes: `tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260906-2023-release-entrypoint-artifacts.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260906-2023-release-entrypoint-artifacts.md`.

## Approach
### Strategy
1. `publish.mjs`: `--artifacts <dir>` (exclusive with `--out-dir`) → export `verifyFrozenArtifacts({ manifestPath, headSha, trainVersion, manifests })` that checks `sourceGitSha`, `releaseVersion`, every unpublished package has an artifact whose file exists and whose sha256 re-hash equals the manifest entry; steps 2-3 are skipped in this mode.
2. Execute path renumbered 1-8: 5 account gate (`assertRegistryAccountPolicy(profileJson)` exported and tested), tag-exists precondition, 6 publish (`--provenance` only under `GITHUB_ACTIONS`), 7 readback, 8 annotated tag carrying `sourceGitSha`. The header comment and dry-run message follow.
3. `ci.yml` `npm-release-pack`: on `ubuntu-latest` only, `actions/upload-artifact@v4` of `.ci-artifacts/release-pack` named `release-pack-${{ github.sha }}`, `if-no-files-found: error`, retention 30 days.
4. Runbook step 5 rewritten as the concrete sequence: download `release-pack-<sha>` for the exact commit → `publish.mjs --artifacts <dir>` dry run (digest verification + plan) → `--execute --otp` → publish → readback → tag → `git push origin vX`.
5. `publish.test.mjs` under `node --test`, added to `test:scripts`: argument exclusivity, `verifyFrozenArtifacts` failure modes (sha mismatch, missing file, wrong `sourceGitSha`, wrong version, missing artifact), `assertRegistryAccountPolicy` (`auth-and-writes` passes; `auth-only`, absent, malformed fail), and a structural ordering guard on the source text (readback invocation precedes `git tag -a` inside the execute block; `git tag` never precedes `npm publish`).
6. Real dry run in the worktree: `node scripts/release/pack-and-smoke.mjs --out-dir <scratch>` is too heavy for this host, so the worker fabricates a minimal manifest + tarballs for the unit path, and the gatekeeper runs `publish.mjs --artifacts` against the CI artifact once the branch's CI has produced one (or against a locally packed set if memory allows).
7. CHANGELOG bullet under 0.14.0 (release tooling), notes.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `--artifacts` mode reusing CI bytes (chosen) | Publishes exactly the accepted tarballs; no repack on the operator machine | Needs one CI upload step; operator downloads an artifact | Use |
| Keep repacking locally, only reorder | Smaller diff | Operator machine cannot finish pack-and-smoke; bytes differ from what CI accepted unless packing is proven deterministic | Reject |
| 2FA override flag | Unblocks an auth-only account | Turns the documented policy into advice | Reject; no override |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `scripts/release/publish.mjs` | Edit | `--artifacts`, `verifyFrozenArtifacts`, `assertRegistryAccountPolicy`, reordered execute path |
| `scripts/release/publish.test.mjs` | Add | unit + structural tests |
| `package.json` | Edit | `test:scripts` includes the new test |
| `.github/workflows/ci.yml` | Edit | upload step |
| `deploy/runbooks/release-responsibility.md` | Edit | step 5 sequence |
| `CHANGELOG.md` | Edit | release tooling bullet |

### Code Snippets
```
step 5/8: registry account gate (npm whoami; tfa.mode must be auth-and-writes)
step 6/8: npm publish <n> tarball(s)
step 7/8: registry readback
step 8/8: git tag -a vX.Y.Z (sourceGitSha …)
```

### Data Flow
CI `npm-release-pack` (ubuntu) → `release-pack-<sha>` artifact → operator download → `publish.mjs --artifacts` verifies sha256 + sourceGitSha → publish → readback → tag.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Operator npm account is not `auth-and-writes` | Unknown | Publish refused | Error names the setting; that is the policy |
| Artifact retention expires before publish | Low | Re-run CI on the same SHA | Documented in the runbook |
| Tarball determinism across CI legs | N/A | Only the ubuntu artifact is uploaded and consumed | Single source |

## Task Contracts
- Contract file: `tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md`
- Review file: `tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md`
- Implementation notes file: `tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one PR: driver, test, CI step, runbook, CHANGELOG.
- **Rollback surface**: revert the PR; no registry side effects (nothing is published by this change).
- **Verification boundary**: `test:scripts`, release-graph, strict workflow, gatekeeper, CI artifact present on the PR's own run.
- **Review/acceptance boundary**: owner approval covers the fail-closed 2FA gate and the publish → readback → tag order; the actual publish remains a separate operator action.
- **High-risk surface**: the release path; a mistake here publishes wrong bytes or tags an unpublished train.
- **Why not checklist row**: changes the shipping mechanism itself.

## Evidence Contract

- **State/progress path**: this plan, contract, notes, review.
- **Verification evidence**: test output; CI run showing `release-pack-<sha>` uploaded; a dry run `publish.mjs --artifacts` output listing verified digests.
- **Evaluator rubric**: no side effect before the account gate and tag-exists check; readback precedes tag by test; digest mismatch refuses; `--artifacts` never runs build or pack.
- **Stop condition**: `npm profile get --json` proves unavailable for token auth on the operator's account type, in which case the gate must fail closed with that message rather than be skipped.
- **Rollback surface**: revert the PR.

## Annotations

- [RESOLVED]: `deploy/runbooks/release-responsibility.md:25` is the human-owned release authority; the script's header comment described its own behaviour and is corrected to match the runbook.

## Task Breakdown
- [ ] `publish.mjs`: `--artifacts` mode, `verifyFrozenArtifacts`, account gate, reordered execute path.
- [ ] `publish.test.mjs` + `test:scripts`; CI upload step; runbook; CHANGELOG; notes.
- [ ] Verification, gatekeeper, PR, CI artifact readback.
