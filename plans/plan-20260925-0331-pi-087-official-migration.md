# Plan: Official Pi 0.87.1 migration: retire the @byok-sdk/pi-* fork from the active dependency graph

> **Status**: Executing
> **Created**: 20260925-0331
> **Slug**: pi-087-official-migration
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: origin/main @ 3dd7ba6f; OP0 three-track verdicts 2026-09-24 (/private/tmp/h5-salesko-prep-20260923/op0-recommendation-{opus,codex,fable}.md); Owner approved A1'/A2' narrowed 2026-09-25
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: bun run build; typecheck; test; check:api-surface; check:version-authority; check:release-pack; repo-harness run check-task-workflow --strict; conformance suite; gatekeeper per WP + composite
> **Rollback Surface**: revert branch claude/pi-087-migration; fork packages remain published
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260925-0331-pi-087-official-migration.contract.md`
> **Task Review**: `tasks/reviews/20260925-0331-pi-087-official-migration.review.md`
> **Implementation Notes**: `tasks/notes/20260925-0331-pi-087-official-migration.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: origin/main @ 3dd7ba6f; OP0 three-track verdicts 2026-09-24 (/private/tmp/h5-salesko-prep-20260923/op0-recommendation-{opus,codex,fable}.md); Owner approved A1'/A2' narrowed 2026-09-25
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260925-0331-pi-087-official-migration.md`
- Sprint contract: `tasks/contracts/20260925-0331-pi-087-official-migration.contract.md`
- Sprint review: `tasks/reviews/20260925-0331-pi-087-official-migration.review.md`
- Implementation notes: `tasks/notes/20260925-0331-pi-087-official-migration.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260925-0331-pi-087-official-migration.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260925-0331-pi-087-official-migration.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260925-0331-pi-087-official-migration.md`.

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
- Contract file: `tasks/contracts/20260925-0331-pi-087-official-migration.contract.md`
- Review file: `tasks/reviews/20260925-0331-pi-087-official-migration.review.md`
- Implementation notes file: `tasks/notes/20260925-0331-pi-087-official-migration.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260925-0331-pi-087-official-migration.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260925-0331-pi-087-official-migration.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert branch claude/pi-087-migration; fork packages remain published
- **Verification boundary**: bun run build; typecheck; test; check:api-surface; check:version-authority; check:release-pack; repo-harness run check-task-workflow --strict; conformance suite; gatekeeper per WP + composite
- **Review/acceptance boundary**: `tasks/reviews/20260925-0331-pi-087-official-migration.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260925-0331-pi-087-official-migration.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260925-0331-pi-087-official-migration.contract.md`, `tasks/reviews/20260925-0331-pi-087-official-migration.review.md`, and `tasks/notes/20260925-0331-pi-087-official-migration.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260925-0331-pi-087-official-migration.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert branch claude/pi-087-migration; fork packages remain published

## Captured Planning Output

## Why

The SDK's prepared lane rides on a self-maintained Pi fork (`@byok-sdk/pi-*` 0.86.1001, frozen since the 2026-09-24 Owner ruling). Every fork change costs a full three-package republish with interactive EOTP, upstream 0.87 removed the fork's injection point (`agent.state.messages` assignment no longer feeds requests), and 0.21.0 already deferred one capability (empty `requiredToolsets`) to this migration. OP0 (three independent tracks, 2026-09-24) established that official `@earendil-works/pi-coding-agent@0.87.1` exposes, through public APIs only, everything the prepared lane needs except a pure request compiler and a provenance-free assistant type; the Owner approved on 2026-09-25 the two narrowed workarounds A1' and A2' below. This package retires the fork from the active dependency graph.

Owner order (2026-09-24): P0 (shipped 0.21.0) → this migration → SummaryJob.

## Invariants

- **A1' (approved 2026-09-25)**: D is compiled by calling the official `streamSimple` public entry of `@earendil-works/pi-ai/api/openai-completions` with a model whose `baseUrl` is a non-routable sink, an injected `fetch` that captures the final serialized body string and always throws, and `maxRetries: 0`. No session, no network, no credential. A1' is transitional: upstream PR U1 (export `buildRequestPayload`, from fork commit `4748f2018`) is prepared in this package and replaces A1' when it lands in an official release. No dual compiler.
- **A2' (approved 2026-09-25)**: Host-owned assistant history enters the request as `AssistantMessage` objects carrying sentinel `api/provider/model`, zero `usage`, `stopReason: "stop"`. The sentinel exists only in the compile input and in the `context_with_system` handler return value; it is never persisted, never written to a receipt, log or RPC readback, and only `text` blocks are admitted (Host assistant history with thinking or toolCall blocks is refused at admission, because `transform-messages.ts` `isSameModel` changes their handling). A conformance test proves sentinel and same-model provenance yield identical bytes.
- No U2: the Host owns the whole system message; the adapter never calls Pi's prompt builder.
- Final byte gate is the only enforcement point: `ModelRuntime.registerProvider({ streamSimple })` wrapping the official `streamSimple` with a scoped `fetch` that compares the exact body string to frozen D and refuses otherwise. `context_with_system` handler errors are fail-open upstream (`extensions/runner.ts` emitContext catches), so injection is projection, not enforcement.
- Prepared sessions disable both retry layers (`settings.retry.enabled=false`, provider `maxRetries=0`); a refusal writes its typed reason to run-scoped state before throwing, because the refusal surfaces upstream as "Connection error." which matches the retryable pattern in `pi-ai utils/retry.ts`.
- No private deep import, no patch-package, no copied serializer, no global fetch monkey-patch, no relaxed budget or S2 gate. Official packages pinned to exact versions with integrity for all sibling packages.
- No product-semantics fallback: capability that cannot be expressed on 0.87.1 is refused with a typed reason, not emulated.
- Zero changes to the frozen fork line; fork packages stay published for history.
- Every wire/version change is one cut: no dual token, no dual read.

## Task Breakdown

- [x] WP0 — Dependency switch and breakage map (deep-worker, with WP1). Replace the `npm:@byok-sdk/pi-*@0.86.1001` aliases in `packages/client/package.json` with exact `@earendil-works/pi-coding-agent@0.87.1` / `pi-ai@0.87.1` / `pi-agent-core@0.87.1`, `bun install`, and record: every fork-only import that now fails (`prepared-session-input`, `input-preparation`, `rpc-types`, anything else), every typecheck error grouped by file, the installed sibling-package set with versions and integrity, and which of the five sibling packages lack shrinkwrap integrity. Report-only for source files beyond `package.json`/lockfile; do not "fix" imports in WP0.
- [x] WP1 — Conformance suite on official 0.87.1 (deep-worker, same dispatch as WP0). New test file(s) under `packages/client/src/adapters/pi/__tests__/official-pi-conformance*.test.ts`, synthetic SSE only, no network (assert zero real sends): (a) same Host transcript → A1' sink-compile D equals the live gate body byte-for-byte, first request and tool-result second request; (b) sentinel vs same-model provenance → identical bytes; Host assistant with a thinking block → refused; (c) D drift → injected fetch called exactly once, `prompt()` resolves, run-scoped typed reason present; both retry layers proven off; (d) upstream ignoring injected fetch (simulate by not passing `fetch`) → connection refused to the sink, zero sends, compile reports failure; (e) `PI_CACHE_RETENTION` and `sessionId` fixed so D is deterministic across two compiles; (f) usage-absent SSE → adapter maps to `usage_unavailable`, not zero success. Tests must import only public entrypoints of the official packages.
- [ ] WP2 — Adapter rewrite (deep-worker, after WP1 green). `packages/client/src/adapters/pi/input-preparation.ts` and `input-preparation-runtime.ts`, `bin/pi-prepared-host.ts`, `bin/byok-pi-prepared.ts`: compile via A1', inject via `context_with_system`, gate via `registerProvider` + scoped `fetch`; `prompt_prepared` response at the byte-gate verdict; admission refuses `cacheWarmer`, non-text Host assistant blocks, `promptCache` models, `strict: "require"`; remove the `byokFork` requirement from `input-preparation.ts` admission (identity moves to WP4). Delete every import of fork-only subpaths. Preserve the 14-point admission semantics; D changes are declared (no `strict` on tools for unknown OpenAI-compatible endpoints; Host-authored system message).
- [ ] WP3 — Fork mechanical items (fast-worker, parallel with WP2, disjoint files). `RPC_MAX_FRAME_BYTES` consumer in `packages/client/src/daemon/input-preparation-service.ts:44`: own the constant and the bounded JSONL frame reader on the SDK side (new small util under `packages/client/src/util/`) or prove the SDK never reads peer-controlled frames; confirm `@modelcontextprotocol/sdk` is not imported by official pi-ai 0.87.1 (no action if so). Report which fork commits (`62cbbd87c`, `511995810`, `e05af044f`, `365711677`) are covered, replaced, or moot.
- [ ] WP4 — Identity gate and install closure (fast-worker, after WP2). `scripts/release/pi-runtime-identity.mjs` and the adapter identity check: replace the `byokFork.upstreamCommit` requirement with official exact `name@version` + integrity + provenance for all three packages plus the five siblings; pin sibling ranges (`^0.87.1`) to exact versions in the lockfile; `check:release-pack`, S2 sealed-host tripwire and `pi-s2-bundle-resolution.test.ts` on darwin with display.
- [ ] WP5 — Wire and Host contract (fast-worker, after WP2/WP4). Input-preparation wire version +1 (one cut), compiler/projection/record version axes, protocol snapshot fields as needed, CHANGELOG BREAKING entry, `docs/protocol.md`, contract document amendment note, and a written handoff for Salesko: new D shape (no `strict`, Host system message), ruling C must be re-derived, facts changes. Host changes themselves are out of scope (Salesko plan).
- [x] WP6 — U1 upstream candidate (fast-worker, parallel from day one, different repo). In `/Users/kito/Projects/pi-wt-087-u1` (branch `claude/u1-export-build-request-payload` from `v0.87.1`), cherry-pick fork `4748f2018`, resolve conflicts against 0.87.1's `stream()` shape, run `packages/ai` tests, keep the change generic (no BYOK vocabulary). Local branch only; opening the upstream PR is an Owner action.
- [ ] WP7 — Composite acceptance and switch (orchestrator + gatekeeper). Seven root checks, focused regressions, one gatekeeper review per WP and one composite; drain-then-switch per the 2026-09-19 draft §15.1; fork retirement record; release version decided by Owner.

## Out of scope

- SummaryJob (next in Owner order). Salesko Host changes (own plan). P0b/P0c. Desktop frontend.
- Product semantics of empty `requiredToolsets`: this package only makes it technically expressible on 0.87.1.
- Any edit to the frozen fork line or to published fork packages.
- Opening the U1 upstream PR (Owner action).

## Evidence Contract

- State/progress path: this plan's Task Breakdown and `tasks/notes/<stem>.notes.md`.
- Verification evidence: per-WP command output retained under `/private/tmp/h5-salesko-prep-20260923/pi087-logs/`; notes link subject SHA and results.
- Evaluator rubric: OP0 required-verification list (six items) all green; no fork-only symbol imported; A1'/A2' boundaries as stated; both retry layers off in prepared sessions; wire cut is single.
- Stop condition: stop if any capability needs a private import, patch, copied serializer or fork change; stop after three repair rounds per issue; unrelated failures are report-only.
- Rollback surface: branch `claude/pi-087-migration`; the wire cut is one-shot.

## Allowed Paths

- packages/client/
- packages/protocol/
- packages/cloud/
- packages/keys/
- scripts/release/
- scripts/api-surface/
- api-surface/
- docs/protocol.md
- docs/spec.md
- docs/researches/
- CHANGELOG.md
- package.json
- bun.lock
- plans/plan-<stem>.md
- tasks/contracts/<stem>.contract.md
- tasks/reviews/<stem>.review.md
- tasks/notes/<stem>.notes.md

## Architecture and trace

P1: protocol owns wire/capability; cloud owns admission and durable message context; client owns preparation, pin, runtime host, outbox and the Pi adapter; official Pi packages own D serialization, the model loop and session management. Host and fork repositories are outside this worktree.
P2: Host transcript → A1' sink compile (official serializer, no session) → frozen D + `requestBytes` on the receipt → Host ruling → prepared offer → daemon pins record → `createAgentSession` with `context_with_system` extension replacing the whole context with the Host transcript (A2' sentinels on assistant entries) → `registerProvider` `streamSimple` wrapper → scoped `fetch` compares body string to D → send or typed refusal → `message_end` usage → egress. Second request after a tool result goes through the same wrapper with its own sequence number.
P3: the fork existed only because upstream lacked a prepared seam; 0.87 supplies injection and a public final-send boundary, leaving a compiler gap that A1' bridges transitionally and U1 closes. Preserve the frozen-input invariant (INV-05) and the byte gate; accept that D's shape changes once and declare it; at 10x the conformance golden per official version is the maintenance cost, which is why A1' must not become permanent.

## Promotion Gate

- Merge/PR unit: one branch `claude/pi-087-migration`, PR on Owner approval; U1 branch separate in the Pi repo.
- Rollback surface: revert branch; fork packages remain published.
- Verification boundary: root required checks plus `check:release-pack`, conformance suite, S2 tripwire on darwin.
- Review/acceptance boundary: gatekeeper per WP and one composite; merge-gate before ship.
- High-risk surface: public wire cut, byte gate correctness, identity gate rewrite, install closure.
- Why not checklist row: coordinated dependency, wire and identity change with one rollback unit.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] WP0 — Dependency switch and breakage map (deep-worker, with WP1). Replace the `npm:@byok-sdk/pi-*@0.86.1001` aliases in `packages/client/package.json` with exact `@earendil-works/pi-coding-agent@0.87.1` / `pi-ai@0.87.1` / `pi-agent-core@0.87.1`, `bun install`, and record: every fork-only import that now fails (`prepared-session-input`, `input-preparation`, `rpc-types`, anything else), every typecheck error grouped by file, the installed sibling-package set with versions and integrity, and which of the five sibling packages lack shrinkwrap integrity. Report-only for source files beyond `package.json`/lockfile; do not "fix" imports in WP0.
- [x] WP1 — Conformance suite on official 0.87.1 (deep-worker, same dispatch as WP0). New test file(s) under `packages/client/src/adapters/pi/__tests__/official-pi-conformance*.test.ts`, synthetic SSE only, no network (assert zero real sends): (a) same Host transcript → A1' sink-compile D equals the live gate body byte-for-byte, first request and tool-result second request; (b) sentinel vs same-model provenance → identical bytes; Host assistant with a thinking block → refused; (c) D drift → injected fetch called exactly once, `prompt()` resolves, run-scoped typed reason present; both retry layers proven off; (d) upstream ignoring injected fetch (simulate by not passing `fetch`) → connection refused to the sink, zero sends, compile reports failure; (e) `PI_CACHE_RETENTION` and `sessionId` fixed so D is deterministic across two compiles; (f) usage-absent SSE → adapter maps to `usage_unavailable`, not zero success. Tests must import only public entrypoints of the official packages.
- [ ] WP2 — Adapter rewrite (deep-worker, after WP1 green). `packages/client/src/adapters/pi/input-preparation.ts` and `input-preparation-runtime.ts`, `bin/pi-prepared-host.ts`, `bin/byok-pi-prepared.ts`: compile via A1', inject via `context_with_system`, gate via `registerProvider` + scoped `fetch`; `prompt_prepared` response at the byte-gate verdict; admission refuses `cacheWarmer`, non-text Host assistant blocks, `promptCache` models, `strict: "require"`; remove the `byokFork` requirement from `input-preparation.ts` admission (identity moves to WP4). Delete every import of fork-only subpaths. Preserve the 14-point admission semantics; D changes are declared (no `strict` on tools for unknown OpenAI-compatible endpoints; Host-authored system message).
- [ ] WP3 — Fork mechanical items (fast-worker, parallel with WP2, disjoint files). `RPC_MAX_FRAME_BYTES` consumer in `packages/client/src/daemon/input-preparation-service.ts:44`: own the constant and the bounded JSONL frame reader on the SDK side (new small util under `packages/client/src/util/`) or prove the SDK never reads peer-controlled frames; confirm `@modelcontextprotocol/sdk` is not imported by official pi-ai 0.87.1 (no action if so). Report which fork commits (`62cbbd87c`, `511995810`, `e05af044f`, `365711677`) are covered, replaced, or moot.
- [ ] WP4 — Identity gate and install closure (fast-worker, after WP2). `scripts/release/pi-runtime-identity.mjs` and the adapter identity check: replace the `byokFork.upstreamCommit` requirement with official exact `name@version` + integrity + provenance for all three packages plus the five siblings; pin sibling ranges (`^0.87.1`) to exact versions in the lockfile; `check:release-pack`, S2 sealed-host tripwire and `pi-s2-bundle-resolution.test.ts` on darwin with display.
- [ ] WP5 — Wire and Host contract (fast-worker, after WP2/WP4). Input-preparation wire version +1 (one cut), compiler/projection/record version axes, protocol snapshot fields as needed, CHANGELOG BREAKING entry, `docs/protocol.md`, contract document amendment note, and a written handoff for Salesko: new D shape (no `strict`, Host system message), ruling C must be re-derived, facts changes. Host changes themselves are out of scope (Salesko plan).
- [x] WP6 — U1 upstream candidate (fast-worker, parallel from day one, different repo). In `/Users/kito/Projects/pi-wt-087-u1` (branch `claude/u1-export-build-request-payload` from `v0.87.1`), cherry-pick fork `4748f2018`, resolve conflicts against 0.87.1's `stream()` shape, run `packages/ai` tests, keep the change generic (no BYOK vocabulary). Local branch only; opening the upstream PR is an Owner action.
- [ ] WP7 — Composite acceptance and switch (orchestrator + gatekeeper). Seven root checks, focused regressions, one gatekeeper review per WP and one composite; drain-then-switch per the 2026-09-19 draft §15.1; fork retirement record; release version decided by Owner.
