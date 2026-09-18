# Plan: issue #196 — recurring packed smoke: real message resolution + restart read-back

> **Status**: Executing
> **Created**: 20260919-0418
> **Slug**: issue-196-recurring-smoke-roundtrip
> **Planning Source**: dispatch (orchestrator, agreed design)
> **Orchestration Kind**: host-plan
> **Source Ref**: gh issue 196 (Ancienttwo/byok-sdk)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Required checks in the dispatch (`bun run build/typecheck/check:api-surface/check:version-authority/test`, extended smoke in isolated-install mode, local durable leg where substrate available, mutation RED evidence, `repo-harness run check-task-workflow --strict`).
> **Rollback Surface**: Before execution remove the plan/contract/notes artifacts; after execution revert branch `claude/issue-196-recurring-smoke-roundtrip` or the reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260919-0418-issue-196-recurring-smoke-roundtrip.contract.md`
> **Task Review**: `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md`
> **Implementation Notes**: `tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md`

## Agentic Routing
- Selected route: execution (fast-worker dispatch)
- Routing reason: positive coverage enhancement of the existing release smoke; design already agreed in the dispatch.
- Due diligence:
  - P1 map: `scripts/release/recurring-smoke.mjs` (the smoke under test, 47 lines), wired by `scripts/release/pack-and-smoke.mjs:535-536` inside `npm-release-pack` (3 OS); durable substrate owned by `@byok-sdk/cloud-dataplane` (`createPostgresCloudStores` + `createPostgresCoreStores` + `migrate`), exercised in CI by the `dataplane` job (compose Postgres 5433 + MinIO 9100, `BYOK_REQUIRE_DATAPLANE=1` fail-closed law).
  - P2 trace: recurring submit (`cloud.submitRecurringExecution` → `enqueueFreshAgentEgressOffer` → frozen `agent-message-offer:<device>:<task>` receipt binding) → authenticated inbound `POST /byok/messages` (`cloud.fetch`, bearer token from `/byok/pair`) → `handleAgentMessagePublish` (reserve → consume → finalize) → public read-back `cloud.readTaskAgentMessage` / `cloud.readAgentMessageDisposition`.
  - P3 decision: the smoke is store-parameterized via the standard env pair; recovery scenarios are PORTED from source-truth tests (agent-message-readback.test.ts, agent-message-completion-gate.test.ts:288-340), not reimplemented. The restart leg composes `createByokCloud` + Postgres stores (the only public durable composition — `createByokServer` storage is memory/sqlite only), reopen happens in an independent process.

## Approach
### Strategy
1. Extend `scripts/release/recurring-smoke.mjs`: keep every existing assertion; add a paired-device authenticated message round-trip (accepted + held), finalize-outage recovery (at-least-once consume, one logical effect), cancel-after-accepted retention, cross-identity borrowing refusals. Durable leg: when the substrate env pair is present, compose Postgres stores from the INSTALLED `@byok-sdk/cloud-dataplane` tarball, run the same admission, then spawn an independent child process that reopens on the same database and proves public read-back with no live TaskHandle, zero consumer invocations on exact replay (no new model Execution).
2. `.github/workflows/ci.yml` dataplane job: one new step running the existing driver `bun run check:release-pack -- --out-dir .ci-artifacts/release-pack`; job-level env (POSTGRES_URL + S3 endpoint + REQUIRE) drives the durable leg inside the smoke. No pack-and-smoke change needed (env flows through `run()`).
3. Mutation check evidence: patch the installed `@byok-sdk/cloud` read-back to return undefined for non-empty messages → smoke must fail RED → capture to `tasks/runs/` → revert.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Parameterize recurring-smoke by substrate env | One smoke, both legs run against installed tarballs; no second driver | Smoke grows (~2x) | Use |
| New standalone restart driver script (pg-migrate-smoke style) | Separation | Duplicates install wiring; scenarios drift from the packed smoke | Rejected |
| Wire restart leg via createByokServer | Literal "reopen server" | `ByokServerStorage` is memory/sqlite only; Postgres would need product changes | Rejected (public durable composition is createByokCloud + Postgres stores, same as dataplane conformance) |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| scripts/release/recurring-smoke.mjs | extend | In-memory scenarios + env-gated durable restart leg (independent child process) |
| .github/workflows/ci.yml | extend | dataplane job: one step running check:release-pack (durable leg rides job env) |
| tasks/runs/*.log | add | Mutation-check RED evidence + local run outputs |

### Data Flow
submitRecurringExecution (consumer registered) → /byok/pair (entitlement → pairing code → bearer token) → capabilities → POST /byok/messages (agent.message.publish) → reserve/consume/finalize → public read-backs; durable leg: same flow over Postgres composition, child reopens with fresh pool + shared token-signer secret.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Postgres store API drift vs in-memory | Low | Durable leg red | Mirrors dataplane conformance composition exactly |
| Full check:release-pack cost in dataplane job | Medium | Slower job | Blessed by dispatch as the existing driver; ubuntu-only |
| Local Docker unavailable | Low | Durable leg CI-only | Verified locally this session (docker 29.5.2); else CI-verified-only noted |

## Task Contracts
- Contract file: `tasks/contracts/20260919-0418-issue-196-recurring-smoke-roundtrip.contract.md`
- Review file: `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md`
- Implementation notes file: `tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md`
- Verification command: `repo-harness run check-task-workflow --strict`

## Promotion Gate

- **Merge/PR unit**: this plan `plans/plan-20260919-0418-issue-196-recurring-smoke-roundtrip.md` is the mergeable execution unit (branch `claude/issue-196-recurring-smoke-roundtrip` → PR → issue #196).
- **Rollback surface**: before execution remove the plan/contract/notes artifacts; after execution revert the branch commits.
- **Verification boundary**: the contract Verification Plan checks (build, typecheck, api-surface, version-authority, isolated-install smoke both legs, mutation RED, full-test baseline-with-delta, ci.yml YAML validity, `repo-harness run check-task-workflow --strict`).
- **Review/acceptance boundary**: `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md` records the disposition per issue checkbox; gate review is a separate dispatch by the orchestrator.
- **High-risk surface**: none (coverage-only; no product source).
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: this plan, `tasks/contracts/20260919-0418-issue-196-recurring-smoke-roundtrip.contract.md`, `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md`, `tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md`
- **Verification evidence**: `tasks/runs/20260919-0418-issue-196-*` (smoke green logs, mutation RED, fail-closed env check, release manifest, full-test log), `.ai/harness/checks/latest.json`, `.ai/harness/runs/`
- **Evaluator rubric**: `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md` records pass against the issue #196 checkboxes
- **Stop condition**: all contract exit criteria verified, workflow gate passes, review recommends pass
- **Rollback surface**: before execution remove the plan/contract/notes artifacts; after execution revert the branch commits.

## Handoff
- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`
