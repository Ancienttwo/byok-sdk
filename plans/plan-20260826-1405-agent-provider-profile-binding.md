# Plan: Agent-scoped provider profile binding

> **Status**: Completed
> **Created**: 20260826-1405
> **Slug**: agent-provider-profile-binding
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Current Salesko Profile accepts provider ids that the BYOK keys launcher rejects, and custom provider capabilities are not sealed into runtime admission.
> **Verification Boundary**: Protocol and keys unit tests, client runtime admission tests, packed tarball smoke, and frozen Salesko consumer falsifier.
> **Rollback Surface**: The additive provider-profile binding capability, status projection, dispatch selection fields, keys registry schema, Pi launcher projection, and associated docs/tests.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md`
> **Task Review**: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md`
> **Implementation Notes**: `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`

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

- Active plan: `plans/plan-20260826-1405-agent-provider-profile-binding.md`
- Sprint contract: `tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md`
- Sprint review: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md`
- Implementation notes: `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260826-1405-agent-provider-profile-binding.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260826-1405-agent-provider-profile-binding.md`.

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
- Contract file: `tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md`
- Review file: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md`
- Implementation notes file: `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260826-1405-agent-provider-profile-binding.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: The additive provider-profile binding capability, status projection, dispatch selection fields, keys registry schema, Pi launcher projection, and associated docs/tests.
- **Verification boundary**: Protocol and keys unit tests, client runtime admission tests, packed tarball smoke, and frozen Salesko consumer falsifier.
- **Review/acceptance boundary**: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Current Salesko Profile accepts provider ids that the BYOK keys launcher rejects, and custom provider capabilities are not sealed into runtime admission.

## Evidence Contract

- **State/progress path**: `plans/plan-20260826-1405-agent-provider-profile-binding.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md`, `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md`, and `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: The additive provider-profile binding capability, status projection, dispatch selection fields, keys registry schema, Pi launcher projection, and associated docs/tests.

## Captured Planning Output

## Why

Salesko currently accepts any bounded Pi provider id and projects it into a BYOK dispatch selection. The BYOK credential-custody launcher only resolves `openai`, `deepseek`, `anthropic`, or one global `custom` profile, so a saved Agent Profile such as `openrouter` reaches runtime and fails after admission. The current provider projection also cannot express image-input capability. The product requires an exact Agent-scoped reference to a locally configured provider profile without moving credential bytes into cloud Profile state.

## Falsifier

A frozen Salesko consumer must demonstrate that released BYOK accepts `openrouter` in the offer but the local launcher rejects it; it must also fail to represent two independent custom profiles and image-input capability. Post-fix, the same consumer must select a non-secret exact-device provider profile reference and observe pre-claim refusal for missing, stale, model-mismatched, or capability-mismatched local state.

## P1 Architecture Map

- `packages/protocol`: wire-safe provider profile reference/revision and capability negotiation; it must not carry Base URL or credentials in task offers.
- `packages/keys`: device-local provider profile authority, normalized endpoint/auth/model/capability metadata, OS credential custody, and Pi projection.
- `packages/client`: exact local provider resolver, pre-claim admission, immutable operation manifest, Pi launcher binding, and non-secret device status projection.
- `packages/cloud` / `packages/server`: authenticated exact-device non-secret provider status/readback only where required by the consumer; never credential transport.
- Salesko: product Profile/description/research semantics, selected-device UX, and direct local configuration composition.
- Out of scope: Salesko Profile schema implementation, cloud secret storage, provider-specific product labels, merge, push, npm publication, deployment, or production migration.

## P2 Concrete Trace

Trace `PrivateAgentPanel` provider selection through Salesko execution snapshot into `DispatchSelection`, BYOK Agent offer decode, TaskRunner pre-claim preparation, Pi adapter, keys launcher profile lookup, sealed manifest, and final Pi `models.json`. Pin the current `openrouter` late rejection as pre-fix evidence, then make the exact local provider profile identity and capabilities the single admission authority.

## P3 Design Decision

Keep secrets and endpoint details device-local. Replace the fixed provider-id-as-instance assumption with a validated opaque provider profile reference whose local record owns provider kind, adapter, Base URL, auth mode, model, and bounded capabilities. Task transport carries only the reference plus exact non-secret revision/hash and requested model/capabilities. Admission resolves and validates it before claim; the manifest seals the exact identity; the launcher rechecks it. Unknown capability or stale/mismatched profile fails closed. No dual-read or fallback to the old fixed-id authority in steady state.

## Task Breakdown

- [x] Freeze a BYOK pre-fix regression test and Salesko packed-consumer falsifier for arbitrary provider ids, multiple custom profiles, image capability, and missing local configuration.
- [x] Add typed opaque provider profile identity/revision/capability declarations and additive capability negotiation to protocol/public exports.
- [x] Refactor `@byok-sdk/keys` local profile authority to support multiple safe custom profile refs while preserving provider kind separately, exact model binding, credential custody, and atomic persistence.
- [x] Add non-secret exact-device provider status/readback and pre-claim resolver/admission surfaces required by the consumer.
- [x] Seal provider profile identity/revision/hash and requested capabilities into the runtime operation manifest; revalidate in the Pi launcher and project model capabilities into Pi configuration.
- [x] Add negative tests for unknown/malformed/oversize refs, missing profile, stale revision/hash, model mismatch, unsupported capability, cross-device/Agent confusion, secret exclusion, restart readback, and no-claim/no-runtime side effects.
- [x] Update protocol/client/keys architecture and downstream integration documentation, explicitly keeping Salesko description/Profile semantics and credential UI out of SDK schema.
- [x] Run focused tests, build, typecheck, full tests, strict workflow, packed tarball smoke, and frozen Salesko consumer acceptance. Produce an unpublished RC manifest only.

## Evidence Contract

- State/progress: this plan, its generated task contract and notes, plus `.ai/harness/checks/latest.json`.
- Verification evidence: executable focused/full tests, strict workflow result, package declarations, tarball SHA-256/integrity manifest, and exact frozen Salesko consumer command/result.
- Evaluator rubric: exact profile binding is pre-claim and fail-closed; multiple custom profiles work; image capability reaches Pi projection; credentials never enter protocol/Profile/logs; old unmatched state does not fall back.
- Stop condition: source and packed RC accepted by the frozen consumer, with registry explicitly unpublished.
- Rollback: revert the additive protocol capability and provider-profile binding changes as one work-package before downstream pinning.

## Promotion Gate

- Merge/PR unit: one provider-profile binding work-package.
- Rollback surface: protocol, keys, client admission/manifest/Pi launcher, non-secret status projection, tests, and docs.
- Independent verification: frozen Salesko consumer installed from exact packed tarballs plus repository full checks.
- Review/acceptance: independent gate over the final diff and consumer bytes.
- High-risk surface: provider credential custody and runtime launch authority.
- This cannot remain a checklist row because it changes a shared protocol, persistent local provider identity, and credential-bound runtime admission across independently published packages.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze a BYOK pre-fix regression test and Salesko packed-consumer falsifier for arbitrary provider ids, multiple custom profiles, image capability, and missing local configuration.
- [x] Add typed opaque provider profile identity/revision/capability declarations and additive capability negotiation to protocol/public exports.
- [x] Refactor `@byok-sdk/keys` local profile authority to support multiple safe custom profile refs while preserving provider kind separately, exact model binding, credential custody, and atomic persistence.
- [x] Add non-secret exact-device provider status/readback and pre-claim resolver/admission surfaces required by the consumer.
- [x] Seal provider profile identity/revision/hash and requested capabilities into the runtime operation manifest; revalidate in the Pi launcher and project model capabilities into Pi configuration.
- [x] Add negative tests for unknown/malformed/oversize refs, missing profile, stale revision/hash, model mismatch, unsupported capability, cross-device/Agent confusion, secret exclusion, restart readback, and no-claim/no-runtime side effects.
- [x] Update protocol/client/keys architecture and downstream integration documentation, explicitly keeping Salesko description/Profile semantics and credential UI out of SDK schema.
- [x] Run focused tests, build, typecheck, full tests, strict workflow, packed tarball smoke, and frozen Salesko consumer acceptance. Produce an unpublished RC manifest only.
