# Plan: K4 publish prep for @byok/keys

> **Status**: Executing
> **Created**: 20260807-1331
> **Slug**: k4-publish-prep
> **Artifact Level**: work-package
> **Promotion Reason**: The six items span four `package.json` files, two new `LICENSE` files, a README section rewrite driven by a programmatic module count, and a source-comment correction that redefines a K4 compatibility claim — correlated state across three artifact classes with a real code gate (`typecheck` / `test` / `build` / `npm pack`) behind it, not a single checklist row.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm --filter @byok/keys run test`, `pnpm -r run build`, `npm pack --dry-run` in `packages/keys`, and `repo-harness run check-task-workflow --strict`. No publish, no network write, no `npm login`.
> **Rollback Surface**: The slice touches `LICENSE`, `packages/keys/{package.json,LICENSE,README.md,src/errors.ts}`, and the `package.json` of `protocol` / `server` / `client`. Reverting those files to their state at `83a0731` restores the pre-slice snapshot; nothing in `dist/` is tracked and no published artifact exists to unpublish.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/k4-aip-swap-dryrun.md`
> **Task Contract**: `tasks/contracts/20260807-1331-k4-publish-prep.contract.md`
> **Task Review**: `tasks/reviews/20260807-1331-k4-publish-prep.review.md`
> **Implementation Notes**: `tasks/notes/20260807-1331-k4-publish-prep.notes.md`

## Agentic Routing
- Selected route: single execution worker under parent-agent orchestration, no delegation fan-out
- Routing reason: every item is fully specified by `docs/researches/k4-aip-swap-dryrun.md` §5.2 and §7.2 step 1 — the dry-run already enumerated what is missing, why, and with what value. No design judgment remains; the only non-mechanical piece is the README module table, and its row count is settled by a programmatic `ls` rather than by opinion.
- Due diligence:
  - P1 map: `packages/keys` is the only package this slice publishes, and it is the K4 dependency for `aip-main-open`. Its manifest (`packages/keys/package.json`) is the publish authority: `files: ["dist"]` plus npm's implicit README/LICENSE/package.json inclusion define the tarball. `packages/{protocol,server,client}/package.json` share the same manifest shape and get the same metadata for consistency, but stay at `0.0.1` and are not published (dry-run §7.3). `packages/keys/README.md` becomes the npm landing page. `packages/keys/src/errors.ts` carries the doc comment that declares which error-code strings are a K4 compatibility surface. Out of scope: `aip-main-open` entirely, the actual `npm publish`, `npm login`, `@byok` scope acquisition, and dry-run §5.2 item 8 (the tsup `node:` prefix strip, a repo-level concern that does not affect K4 under Node).
  - P2 trace: `npm publish` reads `packages/keys/package.json` → `publishConfig.access` decides whether a first-time scoped publish is `restricted` (fails on a free account) or `public`; `scripts.prepublishOnly` decides whether `dist/` — gitignored at `.gitignore:2` — is rebuilt before packing; `files: ["dist"]` plus npm's built-in rules decide the tarball manifest. `npm pack --dry-run` executes that same manifest resolution without a network call, so it is the exact local observation point for items 1, 3, 4. Today's baseline from the dry-run is 22 entries with no LICENSE; adding `packages/keys/LICENSE` is what moves it, because npm only picks up a LICENSE inside the package directory — a root `LICENSE` never enters the `@byok/keys` tarball.
  - P3 decision rationale: the `0.0.1` on all four packages is a monorepo placeholder that was never published, so nothing depends on it; moving only `keys` to `0.1.0` creates a real caret fence (`^0.1.0` = `>=0.1.0 <0.2.0`) for aip's pin while leaving the other three untouched, because publishing them would pull them into the M5 audit's public-commitment scope and that is a separate decision (dry-run §7.3). The duplicated LICENSE is not redundancy to be factored out — it is npm's packaging rule, and a symlink or a `files` entry pointing outside the package directory does not survive packing. The `errors.ts` comment fix is comment-only on purpose: the two sides have no branch consumer for `SECRET_NAMESPACE_INVALID`, so behaviour must not move; only the false provenance claim does.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-1331-k4-publish-prep.md`
- Sprint contract: `tasks/contracts/20260807-1331-k4-publish-prep.contract.md`
- Sprint review: `tasks/reviews/20260807-1331-k4-publish-prep.review.md`
- Implementation notes: `tasks/notes/20260807-1331-k4-publish-prep.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-1331-k4-publish-prep.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: code-change profile; primary worktree; K line stays sealed.

## Approach
### Strategy
Land dry-run §7.2 step 1 exactly as scoped and stop before step 2. Every edit is metadata, licensing text, documentation, or a comment — no runtime source changes, so `pnpm --filter @byok/keys run test` must stay at its recorded 328 passing tests with zero test-file edits. The README module table is regenerated from a programmatic `ls packages/keys/src/*.ts | grep -v '\.test\.ts$'` (18 files) rather than transcribed by hand, and the section heading drops its `K0` qualifier so the table is no longer scoped to a milestone that would make it drift again. `npm pack --dry-run` is the acceptance observation for the packaging half: LICENSE, README.md, and `dist/` present, roughly 24 entries against the dry-run's recorded 22-entry baseline.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. Do all six items, publish nothing | Leaves the repo publish-ready and independently verifiable with `npm pack --dry-run`; separates the reversible local change from the irreversible registry write | Publish readiness is asserted, not proven end to end | **Use** — matches the task's explicit no-publish boundary |
| B. Also run `npm login` and `npm publish @byok/keys@0.1.0` | Would prove the whole path | Irreversible (npm unpublish is time-limited and scope-polluting); requires credentials this slice does not hold; the `@byok` scope's availability is still unverified (dry-run §5.2 items 1-2) | Rejected |
| C. Bump all four packages to `0.1.0` | Uniform version line across the monorepo | Three of them are not being published and would enter the M5 audit's public-commitment scope on a decision nobody made (dry-run §7.3) | Rejected |
| D. Root `LICENSE` only, no per-package copy | One copy, no duplication | npm never packs a file outside the package directory, so `@byok/keys` would ship MIT-declared with no licence text — exactly the gap dry-run §5.2 item 4 names | Rejected |
| E. Keep the README section titled `## What is in K0`, just add the missing 11 rows | Smallest diff | The heading would then contradict its own table; K0 is a milestone, the table is an inventory, and leaving the qualifier guarantees the same drift returns | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `LICENSE` | Create | MIT licence text, `Copyright (c) 2026 ancienttwo`, matching the `"license": "MIT"` all four manifests already declare |
| `packages/keys/LICENSE` | Create | Byte-identical copy of the root LICENSE so `npm pack` includes it in the `@byok/keys` tarball |
| `packages/keys/package.json` | Edit | `version` `0.0.1` → `0.1.0`; add `publishConfig.access: "public"`, `repository` (`directory: "packages/keys"`), `bugs`, `homepage`; add `scripts.prepublishOnly: "pnpm run build"` |
| `packages/protocol/package.json` | Edit | Add `publishConfig`, `repository` (`directory: "packages/protocol"`), `bugs`, `homepage`. Version stays `0.0.1` |
| `packages/server/package.json` | Edit | Add `publishConfig`, `repository` (`directory: "packages/server"`), `bugs`, `homepage`. Version stays `0.0.1` |
| `packages/client/package.json` | Edit | Add `publishConfig`, `repository` (`directory: "packages/client"`), `bugs`, `homepage`. Version stays `0.0.1` |
| `packages/keys/README.md` | Edit | Replace `## What is in K0` (7 rows) with `## Module inventory` (18 rows, one line of responsibility each), matching the programmatic count of non-test modules in `packages/keys/src/` |
| `packages/keys/src/errors.ts` | Edit | Comment-only: rewrite the `SECRET_NAMESPACE_INVALID` provenance claim at `:30-37`. No code change |
| `packages/{keys,protocol,server,client}/src/**` | Do not touch | This slice changes no runtime behaviour; 328 tests must pass unchanged |
| `plans/plan-20260805-1659-byok-keys-package.md`, `tasks/contracts/20260805-1659-*` | Do not touch | The K line is sealed |
| `docs/researches/k4-aip-swap-dryrun.md` | Do not touch | User WIP already present in the worktree; listed in `allowed_paths` only so the acceptance gate's untracked-file scan does not deadlock |

### Code Snippets

Metadata block added to all four manifests (`<name>` per package):

```json
"publishConfig": { "access": "public" },
"repository": {
  "type": "git",
  "url": "git+https://github.com/Ancienttwo/byok-sdk.git",
  "directory": "packages/<name>"
},
"bugs": { "url": "https://github.com/Ancienttwo/byok-sdk/issues" },
"homepage": "https://github.com/Ancienttwo/byok-sdk#readme"
```

`packages/keys/src/errors.ts` — the claim being corrected (current text):

> `SECRET_NAMESPACE_INVALID` … Only the check is ported — no source code string is
> recorded for its rejection path — so treat the code itself as this package's, not
> as a compatibility surface K4 must match.

This is false: `aip-main-open@c6a5385` `apps/local-agent/src/index.ts:752` throws the
verbatim string `"SECRET_NAMESPACE_INVALID"` (dry-run §4). The replacement keeps the
same conclusion — not a K4 compatibility constraint — but on the correct ground:
the string matches, and neither side has a branch consumer.

### Data Flow
`packages/keys/package.json` (`files`, `version`, `publishConfig`, `prepublishOnly`)
→ `npm pack --dry-run` manifest resolution
→ tarball entry list (`dist/**`, `README.md`, `LICENSE`, `package.json`)
→ the artifact `aip-main-open` would later pin as `"@byok/keys": "^0.1.0"`.
`npm pack --dry-run` executes this whole chain locally with no registry call, which
is why it is this slice's packaging acceptance point rather than a publish.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| README module table drifts from the real module count again | Medium | The npm landing page misleads readers on first public release; this repo has already hit count drift four times | Derive the table from `ls packages/keys/src/*.ts \| grep -v '\.test\.ts$'` (18), drop the `K0` qualifier from the heading, and grep the README for count/milestone strings after writing |
| `packages/keys/LICENSE` omitted, only the root one added | Medium | Package ships MIT-declared with no licence text — the exact gap §5.2 item 4 names | `npm pack --dry-run` output must list `LICENSE`; it is an explicit exit criterion |
| `prepublishOnly` shells out to `pnpm` in an environment without it | Low | A publish attempt fails at pack time | The repo is already pnpm-only (`pnpm -r` is the required-checks contract in `CLAUDE.md`); no new dependency is introduced |
| A `package.json` edit breaks JSON or the workspace graph | Low | Red `typecheck` / `build` across all packages | `pnpm -r run typecheck` and `pnpm -r run build` are exit criteria and would fail loudly on a malformed manifest |
| The `errors.ts` edit accidentally changes code, not just the comment | Low | Silent behaviour change on the K4 compatibility surface | The 328-test suite runs unchanged; the diff for `errors.ts` must be comment lines only |
| Strict check trips on the user's untracked `docs/researches/k4-aip-swap-dryrun.md` | Medium | Acceptance gate deadlocks against a file this slice does not own | The path is declared in `allowed_paths` with a comment marking it as pre-existing user WIP, the same relief already applied in `3b01d0e` |
| Version bump to `0.1.0` read as authorization to publish | Low | Irreversible registry write outside this slice's mandate | Publish, `npm login`, and scope acquisition are explicit non-goals; the stop condition names them |

## Task Contracts
- Contract file: `tasks/contracts/20260807-1331-k4-publish-prep.contract.md`
- Review file: `tasks/reviews/20260807-1331-k4-publish-prep.review.md`
- Implementation notes file: `tasks/notes/20260807-1331-k4-publish-prep.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1331-k4-publish-prep.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR: the four manifest metadata blocks, the `@byok/keys` version bump and `prepublishOnly`, both LICENSE files, the README module inventory, the `errors.ts` comment correction, and this slice's workflow artifacts.
- **Rollback surface**: Revert the eight edited/created files to their `83a0731` state. No registry artifact is produced, so rollback is purely local.
- **Verification boundary**: `pnpm -r run typecheck`, `pnpm --filter @byok/keys run test`, `pnpm -r run build`, `npm pack --dry-run` in `packages/keys`, `repo-harness run check-task-workflow --strict`.
- **Review/acceptance boundary**: `docs/researches/k4-aip-swap-dryrun.md` §5.2 items 3-7 and §7.2 step 1 are the acceptance rubric — every listed gap closed, nothing beyond it attempted.
- **High-risk surface**: `packages/keys/package.json` is the publish authority for the first artifact an external repo will pin; `packages/keys/README.md` becomes the public npm landing page.
- **Why not checklist row**: Eight files across four artifact classes (manifests, licence text, public documentation, a source comment defining a compatibility surface), gated by five real commands including a packaging check with a file-list assertion.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260807-1331-k4-publish-prep.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json` from `repo-harness run check-task-workflow --strict`, plus the captured tail output of the four code/packaging commands recorded in the notes file.
- **Evaluator rubric**: `docs/researches/k4-aip-swap-dryrun.md` §5.2 items 3-7 and §7.2 step 1, item by item; plus two hard assertions — `npm pack --dry-run` lists `LICENSE`, `README.md`, and `dist/`, and the README module table row count equals `ls packages/keys/src/*.ts | grep -v '\.test\.ts$' | wc -l`.
- **Stop condition**: Stop and report BLOCKED if any verification command stays red after a bounded fix attempt, if an edit would fall outside this contract's `allowed_paths`, or if closing an item would require `npm login`, an actual `npm publish`, `@byok` scope acquisition, or any change under `aip-main-open` — all four are out of scope for this slice.
- **Rollback surface**: See Promotion Gate.

## Annotations

## Task Breakdown
- [ ] P1 Manifest metadata: add `publishConfig.access: "public"`, `repository` (with the per-package `directory`), `bugs`, and `homepage` to `packages/{keys,protocol,server,client}/package.json`; bump `packages/keys` `version` to `0.1.0` and add `"prepublishOnly": "pnpm run build"` to its scripts, leaving the other three at `0.0.1`.
- [ ] P2 Licence, README, and comment: create the MIT `LICENSE` at the repo root (`Copyright (c) 2026 ancienttwo`) and copy it to `packages/keys/LICENSE`; replace `packages/keys/README.md` `## What is in K0` with an 18-row `## Module inventory` table matching the programmatic module count; rewrite the `SECRET_NAMESPACE_INVALID` provenance comment in `packages/keys/src/errors.ts` (comment only, no code change).
- [ ] P3 Verification: run `pnpm -r run typecheck`, `pnpm --filter @byok/keys run test` (328 tests), `pnpm -r run build`, `npm pack --dry-run` in `packages/keys` (confirm `LICENSE` / `README.md` / `dist/` present, ~24 entries), and `repo-harness run check-task-workflow --strict`; grep the README to confirm no count or milestone string contradicts the real module count; record the output tails in the slice notes file.
