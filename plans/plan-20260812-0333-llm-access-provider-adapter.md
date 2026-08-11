# Plan: LLM access provider adapter

> **Status**: Executing
> **Created**: 20260812-0333
> **Slug**: llm-access-provider-adapter
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: plans/prds/20260812-0258-llm-access-provider-adapter.prd.md
> **Artifact Level**: work-package
> **Promotion Reason**: shared_protocol_and_credential_custody_boundary
> **Verification Boundary**: Protocol, server, client, keys package tests; pinned Pi runtime probe; full recursive typecheck/test/build; strict workflow gate.
> **Rollback Surface**: Revert the single provider-adapter PR; no persisted wire or database migration is introduced.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md`
> **Task Review**: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md`

## Agentic Routing
- Selected route: parent-agent:geju
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: plans/prds/20260812-0258-llm-access-provider-adapter.prd.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260812-0333-llm-access-provider-adapter.md`
- Sprint contract: `tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md`
- Sprint review: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md`
- Implementation notes: `tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260812-0333-llm-access-provider-adapter.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260812-0333-llm-access-provider-adapter.md`.

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
- Contract file: `tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md`
- Review file: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md`
- Implementation notes file: `tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260812-0333-llm-access-provider-adapter.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the single provider-adapter PR; no persisted wire or database migration is introduced.
- **Verification boundary**: Protocol, server, client, keys package tests; pinned Pi runtime probe; full recursive typecheck/test/build; strict workflow gate.
- **Review/acceptance boundary**: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: shared_protocol_and_credential_custody_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260812-0333-llm-access-provider-adapter.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md`, `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md`, and `tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the single provider-adapter PR; no persisted wire or database migration is introduced.

## Captured Planning Output

## Thesis

agent dispatch 的唯一 provider/model/transport authority 必须是用户本机已有 runtime。BYOK SDK 只携带不可歧义的 (lane, runtime, provider, model) 选择，并把 BYOK secret custody 隔离到一个无 listener 的 launcher 进程；Hermes、新增的第二套 HTTP transport、dispatch 进程读 key 都不应存在。`@byok-sdk/keys` 既有的显式 direct-client API 属于另一产品面，本 work package 不删除它，也不让 dispatch graph 可达它。

## Geju framing

- Frame-opening move: zero-legacy + 10x concurrency。
- Kill list: Hermes integration、SDK-owned provider catalog、共享可变 models.json、缺字段默认回落、dispatch 对 @byok-sdk/keys 的 import edge。
- Cheapest proof point: pinned Pi 0.84.1 在 headless RPC 下从独立 PI_CODING_AGENT_DIR/models.json 命中指定 base URL/model，并在未知 provider 时零网络 fail closed。
- Falsifier: Pi 忽略投影、无法锁定 provider/model/base URL，或 session/concurrency 无法用进程级投影保持一致。探针已确认 falsifier 未触发。

## P1 — Architecture map

- docs/spec.md 是产品术语与 security boundary 的权威。
- @byok-sdk/protocol 承载唯一 dispatch selection wire contract。
- @byok-sdk/server 只验证/转发选择，不持有 provider credential。
- @byok-sdk/client 的 TaskRunner 选择 adapter；Claude/Codex 透传 model；Pi 只启动 credential launcher，不读取 key。
- @byok-sdk/keys 独立 launcher 是 BYOK credential custody owner：读取 profile/keychain、生成进程级 Pi projection、注入 Pi child env、继承 RPC stdio、退出清理。
- Pi 0.84.1 是 provider config interpretation、transport 与 agent loop 的唯一权威。
- Out of scope: hosted web UI、vendor-internal OAuth、Hermes、model capability producer（另一个隔离 worktree 正在处理）、web-to-device secret provisioning protocol。

## P2 — Concrete trace

1. Hosted caller dispatches a strict dispatchSelection.
2. Server requires the daemon's `dispatch-selection` capability, rejects legacy runtime disagreement, persists the derived runtime, and sends the exact selection in task.offer.
3. TaskRunner rejects disagreement again at the device boundary and selects the named adapter.
4. Subscription lane appends --model to Claude/Codex and never reads provider keys.
5. BYOK lane invokes the configured launcher with only non-secret provider/model and file paths.
6. Launcher opens the local profile store read-only and the OS keychain only when required, verifies exact provider/model, writes a private process-scoped models.json whose apiKey is an env reference, reconstructs a closed Pi child environment, then spawns pinned Pi with exact --provider/--model.
7. Pi resolves the projected provider and performs the actual request. Missing selection, profile, model, keychain, projection, or launcher fails before provider network activity.

## P3 — Design decision

Use a separate launcher instead of importing @byok-sdk/keys into client or inventing a credential broker service. It preserves the existing zero dependency edge, opens no attackable listener, prevents shared projection races, and keeps one semantic authority. The cost is one local process hop and explicit launcher configuration. At 10x concurrency the first dangerous failure is cross-task projection mutation, so every dispatch owns a private projection directory and stable session directory.

[ASSUMED] P0 provisioning means the selected provider profile/key already exists in the host's @byok-sdk/keys store. The current pair protocol does not transmit provider secrets; web-first encrypted secret provisioning stays outside this PR and must not be claimed as complete.

## Scope

- Add strict dual-lane dispatch selection to protocol and carry it server → client.
- Pass subscription model to Claude/Codex CLI with persistent-session consistency checks.
- Add Pi credential-launcher configuration and fail-closed selection handling.
- Add @byok-sdk/keys Pi projection builder and launcher binary.
- Sanitize ambient provider credentials on the BYOK launcher path.
- Update canonical spec/security/architecture and correct PRD assumptions with probe results.
- Add protocol, server, adapter, keys/projection, and negative-path tests.

## Acceptance

- Exact selection reaches the selected runtime; mismatch is rejected.
- Claude/Codex argv contains exact selected model and receives no provider credential injection from this feature.
- Pi launcher argv contains no secret; launcher child env contains only the exact key from OS custody; projection contains an env reference, not key bytes.
- Missing/mismatched provider/model/key/launcher fails closed without fallback.
- Pinned Pi probe remains the runtime evidence.
- pnpm -r run typecheck, pnpm -r run test, pnpm -r run build, and repo-harness run check-task-workflow --strict pass.
- Pre-merge review finds no new provider registry/transport/OAuth authority and no dispatch dependency edge to the pre-existing keys direct-client surface.

## Workflow decision

The current /private/tmp/byok-sdk-pi-provider-baseurl-probe worktree owns this plan and branch. No second contract worktree is created because implementation and probe already live here; the plan is the single merge/PR unit.

- [x] Finish the P0 dispatch and credential-custody implementation.
- [x] Add negative-path and secret-boundary tests.
- [x] Reconcile spec, security, architecture, PRD, and probe evidence.
- [ ] Run targeted and full verification, then review the frozen diff.
- [ ] Commit, push, open PR, merge to main, and verify the merged revision.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Finish the P0 dispatch and credential-custody implementation.
- [x] Add negative-path and secret-boundary tests.
- [x] Reconcile spec, security, architecture, PRD, and probe evidence.
- [ ] Run targeted and full verification, then review the frozen diff.
- [ ] Commit, push, open PR, merge to main, and verify the merged revision.
