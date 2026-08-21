# Plan: Local Agent Release Identity Authority

> **Status**: Executing
> **Created**: 20260821-1516
> **Slug**: local-agent-release-identity
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Release-sensitive public DaemonConfig and packed CLI identity must change as one reviewed unit
> **Verification Boundary**: Release identity validation, daemon and CLI readback, zero-state version command, and packed manifest parity
> **Rollback Surface**: Revert the client release-identity API, CLI projection, and pack-smoke assertions; no wire, database, publish, or deployment mutation
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-1516-local-agent-release-identity.contract.md`
> **Task Review**: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md`
> **Implementation Notes**: `tasks/notes/20260821-1516-local-agent-release-identity.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-1516-local-agent-release-identity.md`
- Sprint contract: `tasks/contracts/20260821-1516-local-agent-release-identity.contract.md`
- Sprint review: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md`
- Implementation notes: `tasks/notes/20260821-1516-local-agent-release-identity.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-1516-local-agent-release-identity.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-1516-local-agent-release-identity.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-1516-local-agent-release-identity.md`.

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
- Contract file: `tasks/contracts/20260821-1516-local-agent-release-identity.contract.md`
- Review file: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md`
- Implementation notes file: `tasks/notes/20260821-1516-local-agent-release-identity.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-1516-local-agent-release-identity.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-1516-local-agent-release-identity.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the client release-identity API, CLI projection, and pack-smoke assertions; no wire, database, publish, or deployment mutation
- **Verification boundary**: Release identity validation, daemon and CLI readback, zero-state version command, and packed manifest parity
- **Review/acceptance boundary**: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Release-sensitive public DaemonConfig and packed CLI identity must change as one reviewed unit

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-1516-local-agent-release-identity.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-1516-local-agent-release-identity.contract.md`, `tasks/reviews/20260821-1516-local-agent-release-identity.review.md`, and `tasks/notes/20260821-1516-local-agent-release-identity.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the client release-identity API, CLI projection, and pack-smoke assertions; no wire, database, publish, or deployment mutation

## Captured Planning Output

## Goal

Implement Slice A from `docs/researches/2026-08-21_local-agent-version-tolerance-handoff.md`: establish one process-immutable Local Agent application release identity, require SDK embedders to inject it, let the official `byok-agent` build derive it from the client package manifest, and expose exact local/CLI readback without touching WS, presence, Latest lookup, or self-update.

## P1 Architecture Map

- Application release authority: new `packages/client/src/release-identity.ts` value object and validator.
- Embedder composition boundary: `DaemonConfig` and `createDaemon`/`createDaemonWithAdapters` in `packages/client/src/daemon/create-daemon.ts`.
- Official CLI distribution authority: `packages/client/package.json`, injected at build time through `packages/client/tsup.config.ts`; config JSON must not become a second version author.
- Local readbacks: `Daemon.status()`, authenticated control `status`, persisted CLI status rendering, and `byok-agent --version`.
- Release artifact proof: `scripts/release/pack-and-smoke.mjs` compares packed CLI output to the packed client manifest.
- Release candidate: npm readback proves aligned `0.5.0` is already published, so this additive public behavior advances the aligned source/package graph to unpublished `0.6.0`; no publish or tag is authorized.
- Out of scope: protocol schemas, WS hello, server `MachineInfo`, hosted presence, Latest/minimum-version policy, update download/swap/rollback, publish, and deploy.

## P2 Concrete Trace

1. SDK embedder passes `localAgentRelease` to `createDaemon`; constructor validates strict SemVer plus bounded optional build ID once, freezes the copied identity, and every daemon/status/control output reuses that value.
2. Official CLI build obtains the aligned client manifest version at build time and constructs its immutable identity constant. `loadConfig` injects this constant after parsing host config and rejects a host-authored `localAgentRelease` field so config cannot impersonate the distribution.
3. `byok-agent --version` branches before config loading, filesystem/user-state access, runtime probes, daemon construction, or network paths and prints only the official release version.
4. `byok-agent status` prints the invoking CLI release in the persisted section and the running process release from the authenticated control socket in the live section, allowing honest mismatch observation.
5. Packed-artifact smoke executes the installed `byok-agent --version` and compares stdout byte-for-byte to the installed packed `@byok-sdk/client/package.json` version.

## P3 Decision Rationale

Keep application release distinct from runtime executable versions, protocol version, and capabilities. Make the SDK field required to prevent hidden inference. Keep the official CLI's JSON config free of release authorship by injecting the manifest-derived build constant at the CLI composition boundary. Validate/freeze once at daemon construction so every output is a deterministic projection. At 10x scale this identity remains O(1); the first pressure point is later fleet presence/read-model indexing, which is explicitly Slice C rather than this local authority cut.

## File Changes

- `packages/client/src/release-identity.ts`: authoritative type, strict validation, bounded build ID, immutable copy, and official build constant declaration consumption.
- `packages/client/src/daemon/create-daemon.ts`: required config field, construction-time validation, process-immutable capture, and `Daemon.status()`/control status projection.
- `packages/client/src/daemon/control-protocol.ts`: local authenticated status result field only; no BYOK wire change.
- `packages/client/src/bin/config.ts`: CLI config input excludes/rejects host-authored release identity and injects official identity.
- `packages/client/src/bin/byok-agent.ts`: zero-state `--version` branch.
- `packages/client/src/bin/commands/status.ts` and `packages/client/src/bin/format.ts`: current CLI release and live daemon release rendering.
- `packages/client/src/index.ts`: public release identity exports.
- `packages/client/tsup.config.ts`: manifest-derived build-time replacement for the official CLI identity.
- `packages/client/src/__tests__/`: red-first validation, authority, status, CLI zero-state, and no-config override coverage; migrate in-repo client test consumers to explicit identity.
- `examples/packaging/launcher.ts`: explicit embedder identity migration.
- `scripts/release/pack-and-smoke.mjs`: installed packed CLI/manifest parity assertion.
- aligned package manifests plus `bun.lock`: advance the unpublished candidate from already-published `0.5.0` to `0.6.0`.
- `docs/spec.md`: record the application-release authority and Latest non-gate contract for Slice A only.
- Workflow artifacts and `.ai/harness/checks/latest.json`: execution evidence required by strict profile.

## Negative Matrix

- Missing SDK identity is a compile-time contract violation; malformed version/build ID rejects synchronously before daemon side effects.
- `latest`, ranges, leading `v`, whitespace, and non-canonical numeric SemVer reject; prerelease/build metadata are accepted only when valid strict SemVer.
- CLI config containing `localAgentRelease` rejects rather than being ignored or overriding the distribution identity.
- `--version` succeeds without `--config`, BYOK_CONFIG, store access, runtime probes, network access, or daemon construction.
- CLI status can show a current CLI release different from a live daemon release without blocking either process.
- No semver comparison gates start, pair, connect, dispatch, or capability decisions.

## Task Breakdown

- [x] Add red tests for strict identity validation, immutable daemon status, CLI config authority rejection, CLI/live status rendering, and zero-state `--version`.
- [x] Implement the single release identity authority and migrate all in-repo `DaemonConfig` consumers without aliases or inference.
- [x] Inject the official CLI identity from the package manifest at build time and add `--version` before all stateful paths.
- [x] Add packed CLI/manifest parity evidence and update the Slice A product contract in `docs/spec.md`.
- [ ] Run targeted client tests, `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`, and the clean-worktree pack smoke at the final candidate boundary.
- [ ] Record strict review/acceptance evidence and update the canonical BYOK SDK Obsidian decision/project note with verified Slice A state.

## Verification

- Targeted Vitest files prove all negative cases and readback projections.
- `bun run build`
- `bun run typecheck`
- `bun run test`
- `repo-harness run check-task-workflow --strict`
- `node scripts/release/pack-and-smoke.mjs --out-dir <empty-temp-dir>` after code freeze and a clean candidate commit, proving packed `byok-agent --version` equals packed client manifest version.
- Inspect bundled CLI for no runtime `package.json` read and audit `--version` execution with an empty HOME/store/config plus unreachable network environment.

## Evidence Contract

- State/progress path: this plan's `## Task Breakdown`, generated contract, notes, review, and `.ai/harness/checks/latest.json`.
- Verification evidence: targeted test output, full required checks, and a final clean-SHA pack smoke executed once after code freeze.
- Evaluator rubric: required identity has one authority; outputs are deterministic projections; official CLI config cannot author identity; no protocol/presence/updater/latest behavior enters the diff; all checks pass.
- Stop condition: all Task Breakdown items complete, strict contract verification passes, review/acceptance is recorded, and pack smoke proves installed artifact parity.
- Rollback surface: revert this work-package's client API/CLI/test/docs/release-smoke changes; there is no migration, publish, deployment, or user-data rollback.

## Promotion Gate

- Merge/PR unit: Slice A release identity authority plus tests/docs/pack proof is one coherent unit.
- Rollback surface: client API/CLI projection and pack assertion only.
- Verification boundary: local behavior plus packed artifact parity; registry/latest/live distribution remain outside proof.
- Review/acceptance boundary: strict review must verify no second identity authority or semver-based behavior gate.
- High-risk surface: public pre-1.0 `DaemonConfig` change and release artifact assertion.
- Why not checklist row: the release-sensitive public API and packaged CLI proof require an isolated contract worktree and independent review boundary.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add red tests for strict identity validation, immutable daemon status, CLI config authority rejection, CLI/live status rendering, and zero-state `--version`.
- [x] Implement the single release identity authority and migrate all in-repo `DaemonConfig` consumers without aliases or inference.
- [x] Inject the official CLI identity from the package manifest at build time and add `--version` before all stateful paths.
- [x] Add packed CLI/manifest parity evidence and update the Slice A product contract in `docs/spec.md`.
- [ ] Run targeted client tests, `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`, and the clean-worktree pack smoke at the final candidate boundary.
- [ ] Record strict review/acceptance evidence and update the canonical BYOK SDK Obsidian decision/project note with verified Slice A state.
