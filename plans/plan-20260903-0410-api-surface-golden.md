# Plan: Integration-surface golden and version authority gate

> **Status**: Executing
> **Created**: 20260903-0410
> **Slug**: api-surface-golden
> **Artifact Level**: work-package
> **Promotion Reason**: 18 releases in 24 days each broke a downstream-facing surface (`CloudStores`, `MailboxStore`, `BlobStore`, server config) while only the wire was gated; README still advertises `byok-sdk@0.8.1` although npm and `docs/spec.md` say `0.12.0`. First slice of `docs/researches/2026-09-03_architecture-review.md` §11: make every public-surface change and every version string deliberate and CI-checked, without touching runtime code.
> **Verification Boundary**: `bun run build`, the two new root checks, their `node --test` suites, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`.
> **Rollback Surface**: Delete `scripts/api-surface/`, `api-surface/`, the three root `package.json` script entries, the three CI steps, the two Required Checks lines, and revert `README.md`. No runtime, protocol, store, or migration change exists.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_architecture-review.md` §8 row 1, §11
> **Task Contract**: `tasks/contracts/20260903-0410-api-surface-golden.contract.md`
> **Task Review**: `tasks/reviews/20260903-0410-api-surface-golden.review.md`
> **Implementation Notes**: `tasks/notes/20260903-0410-api-surface-golden.notes.md`

## Agentic Routing
- Selected route: code-change (tooling + docs), delegated to `fast-worker`, accepted by `gatekeeper`
- Routing reason: Bounded, decision-free slice approved by the owner on 2026-09-03; no runtime behaviour changes.
- Due diligence:
  - P1 map: Root `package.json` exposes `check:*` scripts (repo-harness helpers plus `node scripts/release/*.mjs`); CI job `build-test` runs `bun ci && bun run build && bun run typecheck && bun run test`. Every publishable package builds with `tsup && tsc -p tsconfig.build.json` (`tsup.config.ts` has `dts: false`), so tsc emits **per-file** `dist/**/*.d.ts` and each package's `exports[*].types` names the public entry `.d.ts` (`.` for all; plus `./adapters`, `./agent-memory` for client and `./runtime` for cloud-dataplane). The wire already has a golden gate (`packages/protocol/src/__tests__/freeze-guard.test.ts` + `golden/v1.frozen.json`) but no type surface does. Version authority is `packages/core/package.json` for the dispatch train and `packages/keys/package.json` for keys, exactly as `scripts/release/check-package-graph.mjs:104-127` already enforces across every dispatch manifest (`0.12.0` / `0.3.9`, both confirmed published by `npm view`). `docs/spec.md` states `0.12.0` / `0.3.9`; `README.md` states `0.8.1` / `0.3.2` at lines 10-11, 52, 118, 134. `scripts/release/*.test.mjs` exist but are not wired into `bun run test` (which only filters workspace packages).
  - P2 trace: `bun run build` → `packages/<pkg>/dist/**/*.d.ts` → new `scripts/api-surface/check-api-surface.mjs` reads `packages/<pkg>/package.json` `exports`, collects every `types` entry, walks relative `import`/`export ... from './x'` specifiers transitively inside `dist/` (tsc-emitted `.d.ts` only contains relative or bare specifiers), concatenates the reachable files in sorted path order under `// ==== @byok-sdk/<pkg> <relpath> ====` headers, normalises (LF, POSIX separators, strip `//# sourceMappingURL`), and compares byte-for-byte with `api-surface/<pkg>.d.ts` → non-zero exit with a unified diff on drift; `--update` rewrites the goldens. `scripts/api-surface/check-version-authority.mjs` reads the same two authorities (`packages/core/package.json`, `packages/keys/package.json`; manifest alignment stays owned by `check:release-graph`), then asserts `README.md` contains `byok-sdk@<dispatch>` and `@byok-sdk/keys@<keys>` and no other `byok-sdk@<semver>` / `@byok-sdk/keys@<semver>` string, and that `docs/spec.md` names `<dispatch>` as the current aligned dispatch release and `<keys>` as the current keys candidate → non-zero exit listing each mismatch.
  - P3 decision rationale: A golden diff (same mental model as freeze-guard) is chosen over a semver-lint because it needs no new dependency, and because the owner's pain is *undeliberate* change, not only breaking change — every public-shape change must be regenerated on purpose and show up in review. `package.json` stays the single version authority and the new check reuses the file `check:release-graph` already treats as authority; no generated manifest JSON is introduced (a second authority would violate the one-source-of-truth rule; GPT review §十三's manifest is rejected for that reason). Goldens live at the repo root (`api-surface/`) so they can never enter a package tarball. Scope is limited to type surface and version strings; the 1.0 definition of *which* surfaces are frozen is a later owner decision (review §8 rows 2-4) and this slice only makes drift visible.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260903-0410-api-surface-golden.md`
- Sprint contract: `tasks/contracts/20260903-0410-api-surface-golden.contract.md`
- Sprint review: `tasks/reviews/20260903-0410-api-surface-golden.review.md`
- Implementation notes: `tasks/notes/20260903-0410-api-surface-golden.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-0410-api-surface-golden.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-0410-api-surface-golden.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-0410-api-surface-golden.md`.

## Approach
### Strategy
Two root-level Node scripts (no new dependencies), committed goldens for the nine publishable packages, root `package.json` script entries, three CI steps in the existing `build-test` job after `bun run build`, README version strings corrected to the package.json authority, and the two checks added to the Required Checks list in root `CLAUDE.md` and `AGENTS.md` (kept aligned).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Golden diff of the reachable `.d.ts` closure (chosen) | No dependency; deterministic from `tsc` output; catches additive and breaking change; same model as freeze-guard | Reviewers must regenerate on every public change; golden files are large | Use |
| API Extractor / api-report | Industry-standard report format | New dev dependency and config per package; `dts: false` build would need reworking | Reject |
| TypeScript compiler-API export walker printing declarations | Precise symbol-level surface | ~200 lines of custom compiler-API code to maintain; declaration printing of re-exported types is fiddly | Reject |
| Generated `release-manifest.json` driving README | Matches GPT review §十三 | Second version authority beside `package.json`; violates one-source-of-truth | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `scripts/api-surface/check-api-surface.mjs` | Create | Closure walk of `exports[*].types` entries over `dist/`, normalise, compare with `api-surface/<pkg>.d.ts`; `--update` rewrites; `--package <name>` filters; prints unified diff on drift; exits 1 |
| `scripts/api-surface/check-version-authority.mjs` | Create | Dispatch/keys versions from `packages/core/package.json` and `packages/keys/package.json`; asserts README strings and spec strings; exits 1 listing mismatches |
| `scripts/api-surface/check-api-surface.test.mjs` | Create | `node --test`: fixture `dist/` tree with a two-hop `export ... from './x'` chain and an unreachable file; asserts closure content and order, drift detection exit code, `--update` idempotence, normalisation of `sourceMappingURL` and CRLF |
| `scripts/api-surface/check-version-authority.test.mjs` | Create | `node --test`: fixture repo root with README/spec/package.json variants; asserts pass, README drift, spec drift, stray second version string |
| `api-surface/<pkg>.d.ts` × 9 | Create | Goldens for client, cloud, cloud-dataplane, core, protocol, server, ui-runtime, testkit, keys generated by `--update` from a clean `bun run build` |
| `api-surface/README.md` | Create | Ten lines: what the goldens are, how to regenerate (`bun run check:api-surface -- --update`), rule that regeneration must be a deliberate, reviewed commit |
| `package.json` | Edit | Add `check:api-surface`, `check:version-authority`, `test:scripts` (`node --test scripts/api-surface/*.test.mjs`) |
| `.github/workflows/ci.yml` | Edit | In `build-test`, after `Build`: steps `Check API surface goldens`, `Check version authority`, `Test root scripts` |
| `README.md` | Edit | "Current release" section: `0.8.1`→`0.12.0`, `keys@0.3.2`→`0.3.9` in every occurrence; replace the two `0.8.1`-specific release-note paragraphs with a two-sentence pointer to `CHANGELOG.md`; keep everything else byte-identical |
| `CLAUDE.md`, `AGENTS.md` (root) | Edit | Add `bun run check:api-surface` and `bun run check:version-authority` to `## Required Checks`, identical wording in both |

### Code Snippets
Closure walk (illustrative):
```js
const SPEC = /\b(?:import|export)\b[^;'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const resolveDts = (fromFile, spec) => { /* ./x → ./x.d.ts | ./x/index.d.ts ; strip .js */ };
```
Header per file: `// ==== @byok-sdk/<pkg> <relpath> ====`. Golden text ends with a single LF.

### Data Flow
`bun run build` → `dist/**/*.d.ts` → closure text → compare `api-surface/<pkg>.d.ts` → exit code. `packages/core|keys/package.json` versions → README/spec strings → exit code.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `tsc` declaration output differs across platforms (CRLF, path separators) | Low | CI red on Windows contributors | Normalise LF and POSIX separators before compare; test covers CRLF |
| Golden churn discourages contributors | Medium | Regeneration becomes reflexive | `api-surface/README.md` states the rule; gatekeeper reviews golden diffs as public-API diffs |
| README prose still references 0.8.1-era behaviour elsewhere | Low | Doc inconsistency | Worker greps README for `0\.8\.1` and `0\.3\.2` after edit; check enforces the strings |
| `bun run test` runtime in `verify-contract` | Medium | Slow acceptance | Accept; it is a Required Check already |

## Task Contracts
- Contract file: `tasks/contracts/20260903-0410-api-surface-golden.contract.md`
- Review file: `tasks/reviews/20260903-0410-api-surface-golden.review.md`
- Implementation notes file: `tasks/notes/20260903-0410-api-surface-golden.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-0410-api-surface-golden.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one branch, one PR: tooling + goldens + CI + README + Required Checks.
- **Rollback surface**: see header; purely additive tooling and docs.
- **Verification boundary**: see header.
- **Review/acceptance boundary**: `gatekeeper` read-only review of the diff against this plan, then owner decides push/PR.
- **High-risk surface**: none (no runtime path).
- **Why not checklist row**: touches CI, root context files and nine committed goldens; needs a reviewed unit.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260903-0410-api-surface-golden.notes.md`
- **Verification evidence**: command outputs of the verification boundary recorded in the notes file; `.ai/harness/checks/latest.json`
- **Evaluator rubric**: goldens regenerate byte-identically from a clean build; deliberately editing one exported type in a scratch change turns `check:api-surface` red; changing a README version string turns `check:version-authority` red; CI steps present; README contains no `0.8.1` / `0.3.2`
- **Stop condition**: any exit-criteria command cannot run, or the closure walk needs anything beyond relative-specifier resolution
- **Rollback surface**: see header

## Annotations
- (none) — owner approved the slice verbally on 2026-09-03 after reading `docs/researches/2026-09-03_architecture-review.md` §11.

## Task Breakdown
- [x] T1 `scripts/api-surface/check-api-surface.mjs` + its `node --test` suite
- [x] T2 `scripts/api-surface/check-version-authority.mjs` + its `node --test` suite
- [x] T3 Generate nine goldens from a clean `bun run build`; `api-surface/README.md`
- [x] T4 Root `package.json` scripts; CI steps; Required Checks in `CLAUDE.md` and `AGENTS.md`
- [x] T5 README version strings and release paragraph; grep proves no `0.8.1` / `0.3.2` remain
- [x] T6 Run the verification boundary; record outputs in the notes file
