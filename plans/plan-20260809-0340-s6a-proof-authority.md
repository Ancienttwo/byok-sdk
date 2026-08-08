# Plan: S6-a Device Proof Authority

> **Status**: Executing
> **Created**: 20260809-0340
> **Slug**: s6a-proof-authority
> **Artifact Level**: work-package
> **Promotion Reason**: S6 的签名格式与 device-row authority 是后续 truth write 的安全前置；先以独立可回滚 vertical slice 冻结 verifier/I3，避免 record handler 与原子 transaction 在未验证 principal 上继续扩张。
> **Verification Boundary**: core golden、cloud verifier/I3、InMemory/Postgres device+receipt parity、0004 catalog/migration、workspace hard dataplane checks。
> **Rollback Surface**: 不声明 proof/truth capability；revert S6-a code。0004 forward-only 保留新增 nullable-free key metadata/receipt table，不修改既有 proof bytes 或 protocol。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s6-proof-truth-memory-design.md`
> **Task Contract**: `tasks/contracts/20260809-0340-s6a-proof-authority.contract.md`
> **Task Review**: `tasks/reviews/20260809-0340-s6a-proof-authority.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0340-s6a-proof-authority.notes.md`

## Agentic Routing
- Selected route: main-thread code-change；Claude review 暂停。
- Routing reason: 用户明确暂停 Claude review；实现由当前主执行线完成，最终语义验收使用独立 Codex execution context，并以 SHA-bound receipt 记录，不伪造 provider pass。
- Due diligence:
  - P1 map: core 已有 canonicalizer/envelope/golden；cloud 缺 verifier/principal；device row 缺 key id/epoch；Postgres 缺 proof receipt authority。
  - P2 trace: proof header → schema/request binding → tenant/device row → time → Ed25519 → authenticated proof principal → dedicated receipt lookup。
  - P3 decision rationale: shipped core golden 单一权威；identity key metadata 显式入 row；proof route 不提供 bearer/unsigned fallback；receipt 使用 `(tenant,device,requestId)`。

## Workflow Inventory
- Active plan: `plans/plan-20260809-0340-s6a-proof-authority.md`
- Sprint contract: `tasks/contracts/20260809-0340-s6a-proof-authority.contract.md`
- Sprint review: `tasks/reviews/20260809-0340-s6a-proof-authority.review.md`
- Implementation notes: `tasks/notes/20260809-0340-s6a-proof-authority.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`。
- Execution isolation: branch `codex/s6-device-proof-memory` in `/Users/ancienttwo/Projects/byok-sdk-wt-s6-device-proof-memory`。

## Approach

1. Add `0004` proof key metadata + dedicated receipt table, update both device adapters and shared conformance.
2. Widen WebCrypto Ed25519 input to raw bytes, add cloud verifier with strict request/time/row binding and uniform unauthorized result.
3. Freeze cross-runtime proof golden and I3 adversarial matrix; keep proof/truth capability undeclared in this slice.
4. Run Postgres+MinIO hard env, full workspace gates, independent Codex security review, receipt/PR/CI/readback.

## Risk Assessment

| Risk | Impact | Mitigation |
| --- | --- | --- |
| two accepted proof byte formats | critical | core golden only; proposal example explicitly superseded |
| claim tenant becomes authority | critical | DB row lookup and row-derived principal |
| replay key aliases across device | high | `(tenant,device,requestId)` receipt key |
| old key remains valid | high | exact row keyId/keyEpoch comparison before signature |
| verifier leaks lookup state | high | all auth/proof failures collapse to 401 |

## Promotion Gate

- **Merge/PR unit**: one S6-a PR.
- **Rollback surface**: withhold proof/truth capability and revert S6-a code; forward-only 0004 columns/table remain inert.
- **Verification boundary**: targeted core/cloud/cloud-postgres suites + required workspace gates + strict harness.
- **Review/acceptance boundary**: independent Codex security review bound to final diff SHA; Claude review remains paused.
- **High-risk surface**: canonical signing bytes, row-derived identity, epoch/revocation checks, replay scope and forward migration.
- **Why not checklist row**: the slice crosses core/cloud/Postgres contracts and freezes a production signature boundary.

## Evidence Contract

- **State/progress path**: this plan Task Breakdown, contract, notes, review and sprint D-10.
- **Verification evidence**: targeted I3/conformance, real Postgres+MinIO tests, workspace gates, strict harness and PR CI.
- **Evaluator rubric**: every protected binding mutation fails; valid Node signature verifies through Workers-safe WebCrypto; row fields and receipt semantics match in both compositions; protocol diff is zero.
- **Stop condition**: protocol golden drift, unsigned fallback, proof claims used as principal without row lookup, or proof receipt not scoped by tenant+device+request.
- **Rollback surface**: capability no-mount plus code revert; 0004 additive schema remains unused.

## Task Breakdown

- [x] Record 3P design and approve S6-a contract scope.
- [x] Add device proof key authority and dedicated receipt schema/adapters.
- [x] Add byte-exact WebCrypto verifier and request/row/time binding.
- [x] Prove core cross-runtime golden and I3 adversarial matrix.
- [x] Run hard gates, obtain full-stack independent Codex security acceptance, and deliver Draft PR #34 with 32/32 CI；merge/readback由 stacked closeout 执行。
