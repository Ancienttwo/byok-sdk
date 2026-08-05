# Plan: Test-Server Fixture Port Shadowing Fix

> **Status**: Executing
> **Created**: 20260805-2057
> **Slug**: port-shadowing-fixture
> **Artifact Level**: work-package
> **Promotion Reason**: Small in diff, but it carries a bugfix contract with a Root Cause Evidence gate and a pre-fix failure artifact, and it touches the shared test fixtures both `@byok/server` and `@byok/client` integration suites depend on — that needs a projectable contract, which requires work-package.
> **Verification Boundary**: `pnpm --filter @byok/server run test`, `pnpm --filter @byok/client run test`, `pnpm -r run test`, `pnpm -r run typecheck`, `repo-harness run check-task-workflow --strict`
> **Rollback Surface**: Four one-token fixture edits plus one new test file; `git revert` of the single commit restores the current tree. No product source is touched.
> **Spec**: `docs/spec.md`
> **Research**: `packages/server/_ops/guard/port-shadowing.guard.ts` (diagnosis-pass candidate guard, gitignored)
> **Task Contract**: `tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md`
> **Task Review**: `tasks/reviews/20260805-2057-port-shadowing-fixture.review.md`
> **Implementation Notes**: `tasks/notes/20260805-2057-port-shadowing-fixture.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: Root cause already proven and the fix already validated by a dedicated diagnosis pass; execution is four mechanical edits plus promoting one guard test.
- Due diligence:
  - P1 map: two test-fixture surfaces bind HTTP servers for cross-package integration tests — `packages/server/src/__tests__/test-support.ts` (`startServer`) and `packages/client/src/__tests__/fixtures/real-server.ts` (three `startRealServer*` variants). Deployment-facing `serve()` calls in `examples/` and `templates/` are explicitly out of scope: real deployments want wildcard binding.
  - P2 trace: `startServer` calls `serve({ fetch, port: 0 })` with no hostname → `@hono/node-server` hands Node a hostname-less `listen(0)` → Node binds the IPv6 wildcard `::`. Line 23 then hands every test `http://127.0.0.1:${info.port}` and line 172 hands every WS test `ws://127.0.0.1:${port}`. On macOS a foreign process already holding the *more specific* `127.0.0.1:<port>` inside the ephemeral range keeps receiving v4 loopback connections for that port while the kernel still grants the `::` wildcard bind the same port. `pairFakeDaemon` (`test-support.ts:140`) then fetches the foreign process and throws at `:150` — `pairing failed: 401 Unauthorized`.
  - P3 decision rationale: the invariant to restore is that a fixture binds the exact address its own URLs dial. Pinning the bind to `127.0.0.1` makes a colliding port fail loud with `EADDRINUSE` instead of silently routing to a stranger. Repo precedent already does this: `packages/client/src/__tests__/fixtures/test-server.ts:103` calls `httpServer.listen(0, '127.0.0.1', ...)`.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260805-2057-port-shadowing-fixture.md`
- Sprint contract: `tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md`
- Sprint review: `tasks/reviews/20260805-2057-port-shadowing-fixture.review.md`
- Implementation notes: `tasks/notes/20260805-2057-port-shadowing-fixture.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260805-2057-port-shadowing-fixture.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260805-2057-port-shadowing-fixture.md`.

## Approach
### Strategy
Add `hostname: '127.0.0.1'` to the four hostname-less `serve({ fetch, port: 0 })` calls in the two test-fixture files, so every fixture binds the address family its own `baseUrl` / `url` / WS URL dials. Promote the diagnosis pass's address-family assertion into `packages/server/src/__tests__/port-shadowing.test.ts` as a permanent guard.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Pin the fixture bind to `127.0.0.1` | Matches repo precedent (`fixtures/test-server.ts:103`); a colliding port fails loud with `EADDRINUSE`; one token per call site | Fixtures no longer reachable over IPv6 loopback | **Use** — no test dials `::1`, and fail-loud is the point |
| Dial `localhost` instead of `127.0.0.1` | Follows the OS resolver | Resolver order is machine-dependent, so the ambiguity moves rather than disappears | Rejected |
| Retry pairing on 401 | No fixture change | Compatibility fallback that hides a real address-family bug behind flakiness | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/__tests__/test-support.ts` | Edit | `startServer` (`:21`): add `hostname: '127.0.0.1'` |
| `packages/client/src/__tests__/fixtures/real-server.ts` | Edit | `startRealServer` (`:50`), `startRealServerWithoutWebSocket` (`:74`), `startRealServerWithDeferredWebSocket` (`:115`): same one-token addition |
| `packages/server/src/__tests__/port-shadowing.test.ts` | Create | Regression guard: `startServer` must bind the exact address its `baseUrl` dials |
| `examples/**`, `templates/**` | Do not touch | Deployment surfaces legitimately want wildcard binding |
| `packages/*/src/**` (non-test) | Do not touch | No product source change is needed |

### Code Snippets
The guard is promoted verbatim in intent from `packages/server/_ops/guard/port-shadowing.guard.ts` (first test): start the fixture, read `server.address()`, assert `address === '127.0.0.1'` and that `baseUrl` is built from that same address. The draft's second test (a self-contained decoy-listener mechanism witness) is deliberately not promoted — it passes both before and after the fix, so it is a mechanism demonstration rather than a gate.

### Data Flow
`serve({ port: 0, hostname: '127.0.0.1' })` → Node `listen(0, '127.0.0.1')` → `info.port` on the v4 loopback → `baseUrl`/WS URL dial the same address → `pairFakeDaemon` reaches byok, never a foreign process. A port already held by a foreign v4 loopback listener now surfaces as `EADDRINUSE` at bind time instead of a 401 mid-test.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A test dials `::1` or a non-loopback host against these fixtures | Low | Medium | Full `pnpm -r run test` is the gate; every fixture URL in both packages is already `127.0.0.1` |
| Fix mistaken for a deployment-wide binding policy change | Medium | Medium | Scope excludes `examples/` and `templates/`; only `__tests__` paths are in `allowed_paths` |
| Guard test drifts if the fixture's URL shape changes | Low | Low | The guard asserts `baseUrl` is derived from `server.address()`, not a hardcoded string |

## Task Contracts
- Contract file: `tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md`
- Review file: `tasks/reviews/20260805-2057-port-shadowing-fixture.review.md`
- Implementation notes file: `tasks/notes/20260805-2057-port-shadowing-fixture.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`
- Returns to: `plans/plan-20260805-1659-byok-keys-package.md` (K3) once this fix is committed.

## Promotion Gate

- **Merge/PR unit**: one commit, `test: bind test-server fixtures to 127.0.0.1 to prevent port shadowing`.
- **Rollback surface**: revert the single commit; no product source touched.
- **Verification boundary**: `pnpm --filter @byok/server run test`, `pnpm --filter @byok/client run test`, `pnpm -r run test`, `pnpm -r run typecheck`, `repo-harness run check-task-workflow --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260805-2057-port-shadowing-fixture.review.md`.
- **High-risk surface**: none in product code; the risk is test-suite reachability only.
- **Why not checklist row**: a bugfix contract with a Root Cause Evidence gate has to project from a work-package plan, and the fixtures it changes are shared by two packages' suites.

## Evidence Contract

- **State/progress path**: this plan's `## Task Breakdown`, `tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md`
- **Verification evidence**: `packages/server/src/__tests__/port-shadowing.test.ts` passing, `/tmp/byok-diag/pre-fix-port-shadowing.log` (`PRE_FIX_EXIT=1`), and the commands named above
- **Evaluator rubric**: the guard fails on the unfixed fixture and passes on the fixed one; both packages' suites stay green
- **Stop condition**: all Task Breakdown items complete and the verification boundary green
- **Rollback surface**: revert the single commit

## Annotations

- Root cause was proven by a dedicated diagnosis pass before this plan existed; no open annotations.

## Task Breakdown
- [x] P1 Bind the four test-fixture `serve()` calls to `127.0.0.1` (`packages/server/src/__tests__/test-support.ts:21`; `packages/client/src/__tests__/fixtures/real-server.ts:50,:74,:115`) and promote the diagnosis pass's address-family assertion into `packages/server/src/__tests__/port-shadowing.test.ts`, then run the verification boundary
