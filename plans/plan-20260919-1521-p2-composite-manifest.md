# Plan: P2 composite acceptance manifest — freeze the SDK composition at 28f29e0d

> **Status**: Executing
> **Created**: 20260919-1521
> **Slug**: p2-composite-manifest
> **Planning Source**: orchestrator-dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: origin/main @ 28f29e0d100bdb810725d0c6e0e9566a6bba4404 (PR #208 merge); P2 composite review requirement (per-consumer resolved pi edges, not a version-set equality)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: two pristine-tree runs of `bun run check:release-pack -- --out-dir <tmp>` at a detached worktree of 28f29e0d with identical sha256 per tarball; composite JSON parses under `JSON.parse`; at least 3 `sha512Integrity` strings base64-decode to the sha512 of their tarballs; piForkConsumption edges derived from `bun.lock` at 28f29e0d; `gh run list` binding recorded as found (the #208 merge run may still be in progress — no waiting); `repo-harness run check-task-workflow --strict`.
> **Rollback Surface**: revert branch `claude/p2-composite-manifest` (single commit); remove this plan file and `tasks/runs/20260919-p2-composite-manifest.json`.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`

## Why

The P2 acceptance review requires one authoritative artifact that binds the SDK composition — tarball set, pi fork consumption graph, and CI evidence — to an exact source SHA. The repo already has the tarball/hash authority (`scripts/release/pack-and-smoke.mjs`, the flow behind `tasks/runs/20260919-0418-issue-196-release-manifest.json`), but that flow emits only the release manifest (schemaVersion 2) and refuses a dirty worktree, so the composite manifest is assembled from a pristine-tree pack of 28f29e0d plus evidence this flow cannot emit (gitSubject, generatedAt, toolchain, lockfile consumption edges, CI rows, not-covered rows). No production code changes; the pack flow is reused as-is, not duplicated.

## Task Breakdown

- [x] Write this plan note (repo-convention shape from `plans/plan-20260919-1345-win-ci-cleanup-boundary.md`).
- [x] Pack twice in a pristine detached worktree at 28f29e0d (`bun ci` then `bun run check:release-pack -- --out-dir /private/tmp/p2-pack-run{1,2}`); confirm both runs' sha256 agree for every tarball and record the agreement here.
- [x] Produce `tasks/runs/20260919-p2-composite-manifest.json`: sourceGitSha (full 28f29e0d), gitSubject, generatedAt (absolute UTC), node/bun/npm versions, platform/arch, packages (precedent key shape from the pack manifest), piForkConsumption (per-consumer resolved version + integrity from `bun.lock` at 28f29e0d, including the known coding-agent@0.85.1006 vs pi-ai/agent-core@0.85.1005 split), ciEvidence (main-branch run bound to headSha 28f29e0d recorded as found, plus final green runs of the #201/#205/#208 PR head branches with head SHAs), explicit notCovered rows.
- [x] Verify: JSON parses; every sha512Integrity decodes to the tarball's sha512 (spot-check at least 3, both pack runs); run `repo-harness run check-task-workflow --strict`.
- [x] Commit on `claude/p2-composite-manifest` as `chore(release): ...` with zero AI-attribution tokens; do NOT push.

## Evidence Contract

- Pack authority: `scripts/release/pack-and-smoke.mjs` output manifests from both pristine runs (tarball list, sha256, sha512Integrity). The composite manifest's `packages` rows are copied verbatim from run 1's release-manifest.json; run 2 exists only to prove determinism.
- piForkConsumption: derived from `bun.lock` at 28f29e0d (workspace consumers + registry-package edges referencing `@byok-sdk/pi-*`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`), each edge resolved to name@version + lockfile integrity.
- CI: `gh run list --repo Ancienttwo/byok-sdk --branch main --limit 8 --json databaseId,headSha,status,conclusion` (binding row = headSha 28f29e0d) and per-branch `gh run list` for the three PR head branches; statuses recorded as found at capture time.
- Integrity decode check: base64-decode the `sha512Integrity` string, hex-encode, compare against `shasum -a 512` of the corresponding tarball.

## Promotion Gate

- Merge unit: single commit on `claude/p2-composite-manifest` containing this plan and the composite manifest JSON.
- Out of scope: any production code, `scripts/release/` changes (the existing flow emits everything the composite needs; no helper script required), publishing, registry mutation, pushing.

## Annotations

- Packing happens in a throwaway detached worktree at 28f29e0d because `pack-and-smoke.mjs` refuses a dirty worktree and records HEAD verbatim; this branch's plan/manifest files must not leak into the packed source.
- Each pack run executes build + 11 packs + isolated npm install + smokes (minutes); the dispatch explicitly requires the pack and one re-run, so the wall clock is task-mandated.
- (results appended below after the runs)

## Results

- Pack runs: two full `bun run check:release-pack -- --out-dir ...` runs in the pristine detached worktree `/private/tmp/byok-p2-pack-wt` at 28f29e0d (`bun ci`, node v24.18.0, bun 1.4.2, npm 11.16.0, darwin/arm64). Both emitted schemaVersion-2 release manifests with `sourceGitSha` = 28f29e0d100bdb810725d0c6e0e9566a6bba4404 and 11 packages; both completed the full isolated-install smoke (single `@byok-sdk/pi-coding-agent@0.85.1006` runtime, prepared-session-input present, `byokFork.upstreamCommit=d981de1229ef899957bbe968bc8dcda02a21f477`).
- Hash agreement between the two runs: 11/11 tarballs byte-identical by sha256 (independent `shasum -a 256` comparison plus the fail-closed assembler assertion over sha256 and sha512Integrity). Manifest-vs-disk sha256 also 11/11.
- Integrity decode: all 11 `sha512Integrity` strings base64-decode to the hex sha512 of the tarball in BOTH runs (`shasum -a 512`), exceeding the required 3 spot-checks.
- piForkConsumption: 6 consumers bound with per-edge resolved package/version/integrity — `@byok-sdk/client` (workspace), `@byok-sdk/pi-coding-agent@0.85.1006` and `@byok-sdk/pi-agent-core@0.85.1005` (registry), peer-edge consumers `@juicesharp/rpiv-i18n@2.8.0`, `pi-subagents@0.60.0`, `pi-web-access@0.24.1`. The coding-agent@0.85.1006 vs pi-ai/agent-core@0.85.1005 split is recorded as the known intentional split.
- ciEvidence (captured 2026-09-19T07:24:07Z): main binding run 35428773673 at headSha 28f29e0d100bdb810725d0c6e0e9566a6bba4404 already `completed`/`success` at capture time (recorded as found, not waited on). Supporting PR-branch final green runs: #201 → 35427686899 @ f70a8390cd4b92c7c8f4231b1e52906ba32e620e; #205 → 35427659219 @ 563f8b503da26e67ddeea8898294d0b20bbe9555; #208 → 35428299569 @ 42dd5f822bcca3d4b4348616c82eac3099547701. Merge-commit main runs: 26945c8a → 35428223645 success; 9c425619 → 35428183973 cancelled; 28f29e0d → 35428773673 success.
- Composite manifest: `tasks/runs/20260919-p2-composite-manifest.json` (generatedAt 2026-09-19T07:25:50Z), JSON.parse-clean, 11 packages, 5 notCovered UNVERIFIED rows.
- repo-harness strict: `repo-harness run check-task-workflow --strict` → `[workflow] OK` (run in the delivery worktree with plan + manifest present).
