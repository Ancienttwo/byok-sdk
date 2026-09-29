# Plan: Tool-less prepared lane (requiredToolsets [] + agentMemory none)

> **Status**: Approved
> **Created**: 20260929-1735
> **Slug**: toolless-prepared-lane
> **Artifact Level**: work-package
> **Promotion Reason**: Owner-approved option A. A future SummaryJob (strict fresh, `terminalProjection 'result-document'`, no `messageEgress`) must run on the prepared lane with zero tools; the protocol already accepts the record, but the device refuses it at six independent sites, and one of them (G6) also breaks memory-only and named-toolset records whenever an unrelated toolset is configured.
> **Verification Boundary**: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface` (empty `api-surface/` diff), `bun run check:version-authority`, `bun run test:scripts`, `node scripts/release/check-package-graph.mjs`, `repo-harness run check-task-workflow --strict`, plus the real-host Pi 0.87.1 launcher test.
> **Rollback Surface**: one code commit (client daemon/pi adapter/tests) and one spec-first docs commit; `git revert` of the code commit restores the refusals. No wire, record, digest, capability or version change, so no data migration.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md`
> **Task Review**: `tasks/reviews/20260929-1735-toolless-prepared-lane.review.md`
> **Implementation Notes**: `tasks/notes/20260929-1735-toolless-prepared-lane.notes.md`

## Agentic Routing
- Selected route: code-change with a regression-first step (G6), spec-first docs commit, then code commit.
- Routing reason: cross-module change across the daemon admission path and the Pi prepared adapter; it must land in one pass with the digests unchanged.
- Due diligence:
  - P1 map: prepared lane = `task-runner.ts` (offer handling, admission call site, pin, claim) -> `prepared-offer-admission.ts` (item-by-item comparison) -> `adapters/pi/prepared-tools.ts` and `prepared-session.ts` (launch side) -> `bin/pi-prepared-host.ts`. Producers of the record: `daemon/prepared-tool-surface.ts` via `input-preparation-service.ts`. Digest formulas live once in `input-preparation.ts`. Out of scope: protocol schemas, wire, record version, the ordinary lane's `resolveMcpServers`.
  - P2 trace: a tool-less offer (`requiredToolsets` omitted) reaches `handleOffer`, `mcpLaunch` is never resolved (G2), admission declines `preparation_launch_attestation_mismatch`; past that, G4 declines the empty server list, G1 refuses at preparation, G5 refuses at launch; and G6 fills the digest input from every configured toolset rather than the record's. Pre-fix output is captured in the notes.
  - P3 decision rationale: the launch attestation stays bound (a tool-less session still needs a provably non-writable launch directory, and claude/codex stay refused by G3). Refusals are removed only where the empty surface is now a valid counted manifest; the by-name tool-set comparison, both digest recomputations, the mode check and the native policy stay. G6 is fixed at the call site so admission reads the same revisions the producer recorded. `RequiredToolsetsSchema` stays `.min(1)`; the offer omits the field. At 10x scale the first thing to fail is nothing new: the change removes work (one fewer refusal), it does not add a per-task cost.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260929-1735-toolless-prepared-lane.md`
- Sprint contract: `tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md`
- Sprint review: `tasks/reviews/20260929-1735-toolless-prepared-lane.review.md`
- Implementation notes: `tasks/notes/20260929-1735-toolless-prepared-lane.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260929-1735-toolless-prepared-lane.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260929-1735-toolless-prepared-lane.md`.

## Approach
### Strategy
Make the prepared lane support a record that counts zero tools and no memory. Remove the three refusals that treat that empty surface as an error (G1 preparation, G4 admission disjunct, G5 Pi launch), resolve the trusted launch directory for every prepared offer (G2) because the digests always bind a launch attestation, and stop admission from binding revisions of toolsets the record does not name (G6). Harden the Pi prepared session so a registry that differs from the manifest fails `prepared_registry_drift` instead of silently launching with extra or default tools.
### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. Tool-less record on the prepared lane (chosen) | No wire/record/digest change; reuses the sealed-surface machinery | Six sites plus a hardening | Adopt |
| B. Drop the launch attestation for tool-less records | Fewer gates | Changes digest inputs; loses the non-writable launch proof | Rejected |
| C. Relax `RequiredToolsetsSchema` to allow `[]` on offers | Symmetric with preparation | Wire change | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/prepared-tool-surface.ts` | Edit | G1: delete `required_toolsets_resolved_to_no_servers`; keep the launch-boundary refusal and `nativeTools: []` |
| `packages/client/src/daemon/task-runner.ts` | Edit | G2 resolve trusted launch for every prepared offer; G4 call-site defaults; G6 revisions from the record's toolsets |
| `packages/client/src/daemon/prepared-offer-admission.ts` | Edit | G4: drop the empty-servers disjunct; G3 unchanged |
| `packages/client/src/adapters/pi/prepared-tools.ts` | Edit | G5: drop the empty-projection refusal |
| `packages/client/src/adapters/pi/prepared-session.ts` | Edit | Registry-drift hardening after `createAgentSession` |
| `packages/client/src/__tests__/*.test.ts` | Edit | P1-P8, N1-N11 |
| `packages/protocol/src/__tests__/input-preparation.test.ts` | Edit | pre-existing title fix (kept) |
| `docs/spec.md`, `docs/protocol.md`, `CHANGELOG.md`, `docs/releases/*`, research note | Edit | spec-first; erratum only for published text |

### Code Snippets
See the contract for the exact sites; the offer omits `requiredToolsets` and never relaxes the schema.

### Data Flow
offer (no `requiredToolsets`) -> `resolveTrustedLaunchCwd(deps.mcpLaunchCwd)` -> admission recomputes both digests over `{launch, revisions of named toolsets = {}, servers = []}` -> pin -> claim -> `startPreparedPiOperation` -> host recomputes both digests -> `createPreparedPiSession` with zero tools.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Official Pi treats `tools: []` as "default built-ins" | Medium | Uncounted native tools in D | Real-host test P6 plus registry-drift hardening |
| `getAllTools()` includes non-active built-ins, so a set check false-positives | Medium | Tool-bearing path breaks | Print both values first; adapt the check to the observed shape |
| G6 change hides a real digest mismatch | Low | Wrong admission | N7 and P3 keep the mismatch cases; digests are unchanged |
| A tool-less offer runs on a launcher-wrapped runtime | Low | Missing launch proof | G3 unchanged; N6 |

## Task Contracts
- Contract file: `tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md`
- Review file: `tasks/reviews/20260929-1735-toolless-prepared-lane.review.md`
- Implementation notes file: `tasks/notes/20260929-1735-toolless-prepared-lane.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one branch, two local commits (spec-first docs, then code plus tests); the orchestrator owns push and PR.
- **Rollback surface**: revert the code commit; the docs commit is text only.
- **Verification boundary**: the repository required checks listed above.
- **Review/acceptance boundary**: gatekeeper review of the diff against this plan and the contract.
- **High-risk surface**: prepared admission (auth-adjacent: trusted launch boundary, digests). No wire, record, digest, capability or version change.
- **Why not checklist row**: the change crosses the daemon admission path, the Pi adapter and the docs, and includes a regression-first bug (G6).

## Evidence Contract

- **State/progress path**: `tasks/notes/20260929-1735-toolless-prepared-lane.notes.md`
- **Verification evidence**: command outputs recorded in the notes and the final report.
- **Evaluator rubric**: P1-P8 pass, N1-N11 pass, all required checks green, `api-surface/` diff empty.
- **Stop condition**: stop after 3 fix cycles, or if G6 turns out intentional or already passing, or if a gate beyond the six needs an architectural call.
- **Rollback surface**: see above.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Regression test first (G6) and record the pre-fix failure
- [ ] Spec-first docs and the plan/contract/review/notes trio (commit 1)
- [ ] G1, G2, G4 (+call site), G5, G6, prepared-session hardening
- [ ] P1-P8, N1-N11
- [ ] Verification suite and final report (commit 2)
