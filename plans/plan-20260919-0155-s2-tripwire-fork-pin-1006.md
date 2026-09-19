# Plan: S2 tripwire closeout: consume Pi fork 0.85.1006 (lazy clipboard, fail-closed helper)

> **Status**: Executing
> **Created**: 20260919-0155
> **Slug**: s2-tripwire-fork-pin-1006
> **Planning Source**: orchestrator-dispatch (S2 tripwire work-package, fork build 6 published)
> **Orchestration Kind**: host-plan
> **Source Ref**: fork `@byok-sdk/pi-coding-agent@0.85.1006` on npm (byokFork.forkBuild 6, upstreamCommit unchanged d981de12…)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260919-0155-s2-tripwire-fork-pin-1006.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260919-0155-s2-tripwire-fork-pin-1006.md`; after execution revert the fix commit on branch `claude/wp5-s2-tripwire-zero`.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260919-0155-s2-tripwire-fork-pin-1006.contract.md`
> **Task Review**: `tasks/reviews/20260919-0155-s2-tripwire-fork-pin-1006.review.md`
> **Implementation Notes**: `tasks/notes/20260919-0155-s2-tripwire-fork-pin-1006.notes.md`

## Agentic Routing
- Selected route: execution
- Routing reason: orchestrator dispatch with a proven change surface; no open design forks.
- Due diligence:
  - P1 map: pin authority is `packages/client/package.json` `byok.piRuntimePin` + its `@earendil-works/pi-coding-agent` alias (one authority, consumed by `resolve-bin.ts` `resolvePiRuntimeIdentity()`); asset pin is `packages/client/src/adapters/pi/pi-export-assets.source.json` (verified at build by `scripts/build-pi-export-assets.mjs` against the installed fork manifest incl. `byokFork` deep-equality and per-file digests); manifest assertions live in `packages/client/scripts/check-adapters-entry.mjs`.
  - P2 trace: `pi-s2-bundle-resolution.test.ts` builds a release bundle from the workspace's installed fork (`import.meta.resolve('@earendil-works/pi-coding-agent')`), spawns the sealed host; the fork 0.85.1005 vendored `dist/utils/clipboard-native.js` runs `loadClipboardNative()` at module-graph load, both createRequire roots miss inside the release, bun auto-install fires 12 registry GETs (probe evidence `tasks/runs/20260918-2359-s2-tripwire-probe-evidence.txt`), the local registry tripwire asserts `registryAttempts` deep-equal `[]` and fails.
  - P3 decision rationale: the fix ships in the fork (build 6 makes the clipboard load lazy and `__byok_sdk_helper` fail-closed); the SDK side is a pin bump plus de-hardcoding the two literals that the bump would otherwise break (check-adapters-entry alias/pi-ai equality, rpc packaging probe version). Partial-release reality (coding-agent 0.85.1006 while pi-ai/pi-agent-core stay 0.85.1005) is why the check must derive from the installed fork's own manifest instead of asserting version equality between the two pins.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260919-0155-s2-tripwire-fork-pin-1006.md`
- Sprint contract: `tasks/contracts/20260919-0155-s2-tripwire-fork-pin-1006.contract.md`
- Sprint review: `tasks/reviews/20260919-0155-s2-tripwire-fork-pin-1006.review.md`
- Implementation notes: `tasks/notes/20260919-0155-s2-tripwire-fork-pin-1006.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260919-0155-s2-tripwire-fork-pin-1006.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: work runs directly in this dedicated worktree (`claude/wp5-s2-tripwire-zero`, base main `a6c5a297`); no second contract worktree is started.

## Approach
### Strategy
Bump the single pin authority to the published fork build 6, refresh the lockfile against the real registry, keep the asset manifest digests byte-identical (only `packageVersion`/`forkBuild` move), and rework the two hardcoded-version guards to derive from the installed fork's own manifest so future fork bumps stop re-breaking them.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Pin bump only (literal-for-literal) | Smallest diff | check-adapters-entry and the probe test re-break on every partial fork release | No |
| Pin bump + derive guards from installed fork manifest | One authority, future partial releases verify themselves | Slightly more code in the check | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/package.json` | Edit | `byok.piRuntimePin` and the `@earendil-works/pi-coding-agent` alias → `0.85.1006` (pi-ai alias stays `0.85.1005`) |
| `bun.lock` | Regenerate | `bun install` against the real registry; only the coding-agent fork entry moves |
| `packages/client/src/adapters/pi/pi-export-assets.source.json` | Edit | `packageVersion` → `0.85.1006`, `byokFork.forkBuild` → 6; the 5 asset digests/bytes must stay unchanged |
| `packages/client/scripts/check-adapters-entry.mjs` | Edit | Replace the hardcoded alias literal and the pi-ai==coding-agent version equality with derivation from the installed fork's own manifest (name/version, `byokFork` presence, its declared `@earendil-works/pi-ai` edge); fail closed on absence |
| `packages/client/src/__tests__/pi-rpc-packaging-probe.test.ts` | Edit | Drop the stale `version: '0.85.1005'` literal; anchor the fork scope name literally, let the version travel from the pin authority (installed-vs-pin comparison below it is the real drift check) |
| `docs/spec.md` | Edit | The two current-state pin mentions in the core pi runtime contract → `0.85.1006` |

### Code Snippets
See contract Allowed Paths; the check rework keeps `piRuntimePin must exactly project dependency alias` (no literals) and adds:

```js
const nativeManifest = JSON.parse(readFileSync(
  path.join(packageRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
assert.equal(nativeManifest.name, '@byok-sdk/pi-coding-agent');           // fork scope anchor
assert.ok(nativeManifest.byokFork?.upstreamBase && nativeManifest.byokFork?.forkBuild); // fail closed
assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'],
  `npm:${nativeManifest.name}@${nativeManifest.version}`);
assert.equal(manifest.dependencies?.['@earendil-works/pi-ai'],
  nativeManifest.dependencies?.['@earendil-works/pi-ai']);               // fork's own declared edge
```

### Data Flow
`packages/client/package.json` (alias + `byok.piRuntimePin`) → `bun install` → installed fork manifest (0.85.1006, forkBuild 6) → `resolvePiRuntimeIdentity()` / `build-pi-export-assets.mjs` / reworked `check-adapters-entry.mjs` all read it; the S2 test's release bundle vendors the installed fork, whose lazy clipboard load keeps `registryAttempts` empty.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Export-asset digest drift in fork build 6 | Low | High (would mean content drift, not a pin bump) | `build-pi-export-assets.mjs` fails the build on any digest/byte drift; STOP and report instead of editing digests |
| Hidden extra `0.85.1005` coding-agent literals re-break tests | Medium | Medium | Grep sweep across packages/scripts/docs; classify pin vs pi-ai vs historical before editing |
| Registry flake during `bun install` | Low | Low | Retry once only with fresh evidence; report if it persists |

## Task Contracts
- Contract file: `tasks/contracts/20260919-0155-s2-tripwire-fork-pin-1006.contract.md`
- Review file: `tasks/reviews/20260919-0155-s2-tripwire-fork-pin-1006.review.md`
- Implementation notes file: `tasks/notes/20260919-0155-s2-tripwire-fork-pin-1006.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260919-0155-s2-tripwire-fork-pin-1006.contract.md --strict`
- Active plan rule: this plan is the worktree's active execution unit while its contract is Active; do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: fix commit on branch `claude/wp5-s2-tripwire-zero` preceded by this plan's artifacts commit.
- **Rollback surface**: revert the fix commit; the S2 tripwire returns RED matching `tasks/runs/20260918-2345-s2-tripwire-prefix.txt`.
- **Verification boundary**: build, typecheck, targeted vitest suites, api-surface, version-authority, check-task-workflow --strict, full `bun run test`.
- **Review/acceptance boundary**: `tasks/reviews/20260919-0155-s2-tripwire-fork-pin-1006.review.md` records the evidence disposition.
- **High-risk surface**: none beyond the digest-drift tripwire above; it fails closed.
- **Why not checklist row**: human_decision_boundary (published-registry consumption, guard rework).

## Evidence Contract

- **State/progress path**: this plan's task breakdown, `tasks/todos.md`, the contract/review/notes trio
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, `tasks/runs/` artifacts
- **Evaluator rubric**: contract Verification Plan; review file records disposition
- **Stop condition**: all checks green, `pi-s2-bundle-resolution.test.ts` green with `registryAttempts: []` on a real-registry install
- **Rollback surface**: revert the fix commit

## Task Breakdown
- [ ] Execute: bump pin to 0.85.1006 (package.json, bun.lock, source.json), rework check-adapters-entry derivation, de-hardcode probe test version, sweep stale literals, verify full check set
