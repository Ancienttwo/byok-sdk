# Plan: Authenticated Enrollment Tenant Projection

> **Status**: Review
> **Created**: 20260823-2025
> **Slug**: authenticated-enrollment-tenant-projection
> **Artifact Level**: work-package
> **Promotion Reason**: Salesko Agent-first composition is blocked because the cloud already authenticates tenant ownership at pairing, but the wire/client enrollment projection drops it before daemon egress composition.
> **Verification Boundary**: Protocol schemas/types, reference and hosted pair handlers, cloud/dataplane device authority, atomic client record persistence/restart/renewal/re-pair, daemon egress composition, release graph, disposable dataplane and independent frozen-subject review.
> **Rollback Surface**: Before any downstream consumption, revert the unreleased 0.7.0/keys 0.3.0 candidate as one source unit; no dual wire shape, legacy record fallback, production migration or registry mutation is permitted.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md`
> **Task Review**: `tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md`
> **Implementation Notes**: `tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md`

## Agentic Routing
- Selected route: strict cross-package contract in an isolated repo-harness worktree, followed by an independent frozen-subject gate.
- Routing reason: the change crosses an authenticated enrollment boundary, public wire schema, durable local identity, daemon composition and release graph; a partial implementation would reintroduce an unauthenticated tenant authority.
- Due diligence:
  - P1 map: SaaS/cloud pairing-code issuance owns tenant authentication; `PairingCodeStore` carries `{tenantId, productId}`; `AuthPlane.redeemAndRegister` writes the same binding to the cloud `DeviceRecord`; `PairResponseSchema` is the missing wire projection; client `DeviceStore` is the sole durable local enrollment authority; `buildDaemonWithAdapters` must consume that record for Agent egress and hosted-journal identity. Salesko Profile/config, access tokens, deviceId and shadow stores are explicitly out of scope.
  - P2 trace: authenticated host calls `createPairingCode(tenant, product)` -> `/byok/pair` redeems once -> cloud/reference server registers a tenant-bound device -> response must return opaque non-secret `tenantId` -> `AuthManager.pair` validates and atomically saves it with credentials -> restart `loadExisting` reads the exact record -> daemon starts and binds `AgentEgressController`/content receipts/acks to that record tenant. Renewal updates only token/expiry while spreading the existing binding; re-pair atomically replaces the full record with the newly authenticated response.
  - P3 decision rationale: make tenant projection required end to end and remove host-authored `AgentEgressConfig.tenantId` and `HostedJournalConfig.tenantId`. Missing/invalid legacy records fail closed with an explicit re-pair requirement; no token/JWT parsing, Profile/config fallback, deviceId derivation, optional compatibility field or steady-state dual read. Because this is a required public protocol/client configuration break in a pre-1.0 train, prepare aligned 0.7.0 and independently versioned keys 0.3.0 (exact core 0.7.0 edge), without publishing.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md`
- Sprint contract: `tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md`
- Sprint review: `tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md`
- Implementation notes: `tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md`.

## Approach
### Strategy
Carry the already-authenticated cloud tenant binding across the one missing
projection seam, then make the locally persisted enrollment record the only
daemon tenant source. Keep renewal identity-preserving and make re-pair the only
normal authority replacement operation.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Keep tenantId in host config and compare it to enrollment | Smaller API change | Retains two authoring paths and a drift state | Reject |
| Decode tenantId from the access token | No wire change | Couples the client to token format and treats secret bytes as local authority | Reject |
| Optional PairResponse field plus legacy fallback | Rolling compatibility | Old daemon can silently run with unauthenticated tenant context | Reject |
| Required response + required atomic DeviceRecord + config removal | One authenticated authority and explicit migration boundary | Requires re-pair for old records and a minor pre-1.0 train | Adopt |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/protocol/src/http-api.ts`, protocol tests/docs | Update | Add bounded opaque required `tenantId` to PairResponse schema/type and frozen contract. |
| `packages/cloud/src/handlers/auth.ts`, cloud tests | Update | Project tenantId from the device row returned by authenticated redemption. |
| `packages/server/src/http.ts`, server tests | Update | Match the reference server pair response to the same authenticated device-row binding. |
| `packages/client/src/daemon/store.ts`, `auth-manager.ts` | Update | Require, validate and atomically persist tenantId; preserve it on renewal and replace on re-pair. |
| `packages/client/src/daemon/create-daemon.ts`, client tests | Update | Remove host-authored egress/journal tenant and bind runtime egress/content/ack/journal composition to the loaded DeviceRecord. |
| `packages/cloud-dataplane` tests/probes | Update | Prove real disposable persistence retains the exact pairing tenant and rejects cross-tenant tamper. |
| public package manifests, `bun.lock`, release tests/docs | Update | Prepare aligned 0.7.0 plus keys 0.3.0 exact graph; do not publish. |
| `README.md`, `packages/client/README.md` | Update | Remove the stale host-authored tenant example while keeping the published-current release pins at 0.6.1/keys 0.2.2 until registry publication. |
| plan/contract/review/notes/todos | Add/update | Record scope, evidence, independent review and source-vs-RC-vs-registry boundary. |

### Code Snippets
### Data Flow
`authenticated pairing code tenant -> cloud device row -> PairResponse.tenantId -> atomic device.json -> restart load -> daemon AgentEgressController/content receipts/acks`.

Renewal is `record { tenantId, ...credentials } -> new token/expiry -> atomic same-tenant record`.
Re-pair is `new authenticated PairResponse -> atomic full-record replacement`.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Old daemon or record silently loses the binding | High without a hard cut | Cross-tenant egress | Required field/schema, required record parser and explicit re-pair error. |
| Host continues to author tenant config | Medium | Duplicate authority | Remove `AgentEgressConfig.tenantId`; construct from loaded record only. |
| Renewal changes or reconstructs tenant | Medium | Identity drift | Spread exact stored record and change only token/expiry; negative no-token-parsing test. |
| Re-pair leaves mixed old/new fields | Medium | Credential/tenant mismatch | One atomic full-record save after complete response validation. |
| Wire break is under-versioned | Medium | Old peer failure | Align public train at 0.7.0 and keys exact-edge candidate at 0.3.0; capability/semver readback remains separate from publish. |
| Secret leakage in logs/profile/egress | Low | Credential exposure | Tenant is non-secret; assert tokens/private keys never enter profile, logs or egress payloads. |

## Task Contracts
- Contract file: `tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md`
- Review file: `tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md`
- Implementation notes file: `tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: protocol/cloud/server/client/dataplane/tests/docs and exact release-graph candidate as one source authority.
- **Rollback surface**: one unreleased source candidate; no data migration or downstream mutation.
- **Verification boundary**: focused schema/handler/store/restart/renewal/re-pair/daemon negatives, full repo gates, packed graph, disposable real Postgres and independent gate.
- **Review/acceptance boundary**: typed receipt for the frozen branch subject; source acceptance does not authorize merge, push or publish.
- **High-risk surface**: authentication/tenant isolation, durable credentials and content egress.
- **Why not checklist row**: the missing binding crosses five independently released packages and an authenticated persistence boundary.

## Evidence Contract

- **State/progress path**: this plan and matching contract/review/notes/checks in the isolated worktree.
- **Verification evidence**: schema snapshots, focused negative tests, build/typecheck/full test, release graph/pack smoke, disposable Postgres probe and frozen-subject gate report.
- **Evaluator rubric**: prove exact pairing-code tenant survives pair, disk, restart, renewal and daemon egress; cross-tenant tamper and legacy record fail closed; no alternate tenant source exists.
- **Stop condition**: stop on required fallback, secret/token parsing, migration ambiguity, dirty/concurrent WIP overlap, unavailable disposable dataplane or failed independent gate.
- **Rollback surface**: revert the complete unreleased 0.7.0/0.3.0 candidate; npm/remote/downstream stay untouched.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Project and activate a strict contract with exact allowed paths and tests.
- [x] Add required typed PairResponse tenant projection to hosted and reference pair handlers.
- [x] Make DeviceRecord require/validate/persist tenantId across pair, restart and renewal; re-pair atomically replaces it.
- [x] Remove host-authored egress/journal tenant authority and bind daemon composition to enrollment.
- [x] Add old-record, tamper, re-pair, restart, renewal and no-token-parsing negatives.
- [x] Prepare aligned 0.7.0 and keys 0.3.0 exact release graph without publication.
- [x] Run focused/full gates and real disposable dataplane evidence.
- [x] Freeze the source subject and obtain an independent gate/typed acceptance receipt.
- [x] Update durable BYOK memory and report source/RC/npm/registry states separately.
