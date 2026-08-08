# Plan: S6-b Atomic Truth Write

> **Status**: Executing
> **Created**: 20260809-0418
> **Slug**: s6b-atomic-truth
> **Artifact Level**: work-package
> **Promotion Reason**: S6-a 已冻结 proof principal；下一不可分割风险面是 receipt、truth、object reference 与 inline accounting 的原子提交。顺序拼接现有 stores 会留下 GC 删除活对象或写入未计费 bytes 的 crash window。
> **Verification Boundary**: proof-bound HTTP routes、Postgres single-transaction commit、deterministic route fake、real Postgres+MinIO、replay/CAS/terminal/object/reference/quota/adversarial tests、full workspace gates。
> **Rollback Surface**: withdraw `truth.records` capability and routes; revert S6-b application code。新增 forward-only migration 保留为 inert schema，不回滚历史 truth/object rows。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s6-proof-truth-memory-design.md`
> **Task Contract**: `tasks/contracts/20260809-0418-s6b-atomic-truth.contract.md`
> **Task Review**: `tasks/reviews/20260809-0418-s6b-atomic-truth.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0418-s6b-atomic-truth.notes.md`

## Agentic Routing

- Selected route: main-thread migration/code-change; Claude review remains paused.
- P1 map: `@byok/cloud` owns proof-bound HTTP/capability; `@byok/cloud-postgres` owns the production transaction; existing core truth/object/quota tables remain domain authorities.
- P2 trace: raw request bytes → proof verifier → typed truth commit → receipt replay check → row locks/quota admission → truth/reference/accounting/receipt commit → metadata response.
- P3 decision: one high-level `TruthCommitter` application port; no handler-side store choreography and no unsigned/bearer fallback. Inline snapshots reserve/account current physical bytes; object records require an already committed reservation-backed manifest.

## Workflow Inventory

- Active plan: `plans/plan-20260809-0418-s6b-atomic-truth.md`
- Contract: `tasks/contracts/20260809-0418-s6b-atomic-truth.contract.md`
- Review: `tasks/reviews/20260809-0418-s6b-atomic-truth.review.md`
- Notes: `tasks/notes/20260809-0418-s6b-atomic-truth.notes.md`
- Branch/worktree: `codex/s6b-atomic-truth` / `/Users/ancienttwo/Projects/byok-sdk-wt-s6b-atomic-truth`
- Base: S6-a commit `d8e7802`; stacked until PR #34 merges.

## Approach

1. Freeze cloud-owned record DTO and `TruthCommitter` result/replay contract.
2. Implement Postgres transaction: receipt lookup, deterministic locks, quota admission, terminal/snapshot CAS, reference replacement/recount, inline delta settlement, receipt write.
3. Wire proof-only GET/PUT routes behind an honest composition contract；标准 InMemory composition 不伪造跨 store atomicity，handler behavior 只用 deterministic route fake。
4. Prove exact replay/mismatch, terminal immutability, snapshot CAS, object committed-only, inline quota, tenant isolation, metadata-only manifest, and transaction rollback.

## Promotion Gate

- **Merge/PR unit**: one stacked S6-b PR targeting the S6-a branch until #34 merges, then retarget main.
- **Rollback surface**: capability no-mount + code revert; migration remains inert.
- **Verification boundary**: targeted handler/transaction suites, hard dataplane full workspace gates, strict workflow, PR CI.
- **Review/acceptance boundary**: independent Codex security/transaction review before merge; Claude remains paused.
- **High-risk surface**: cross-store atomicity, quota settlement, object GC references, replay conflict and proof-only auth.
- **Why not checklist row**: a crash-safe transaction crossing four authorities cannot be reviewed or rolled back as a checklist edit.

## Evidence Contract

- **State/progress path**: Task Breakdown + contract/notes/review + sprint D-10.
- **Verification evidence**: deterministic behavior suite shared by InMemory/Postgres where meaningful, SQL rollback probes, hard env, full gates and PR CI.
- **Evaluator rubric**: no successful response without all four durable facts; exact replay is byte-stable; mismatch conflicts; manifest list has no body; object refs prevent GC; quota cannot be bypassed.
- **Stop condition**: handler sequences raw stores, protocol drift, unsigned fallback, non-committed object reference, or partial transaction state.
- **Rollback surface**: withhold capability, revert code, retain additive schema.

## Task Breakdown

- [x] Record S6-b contract and transaction design.
- [x] Implement typed commit contract and Postgres atomic authority.
- [x] Wire proof-only manifest/get/put routes behind `truth.records` capability.
- [x] Implement reference behavior and adversarial/rollback tests.
- [x] Push stacked Draft PR #35（commit `2de841d`）；retain independent review gate（hard env/full workspace gates 已通过）。
- [x] Obtain full-stack independent Codex security/transaction acceptance at `ead8a8746188b8f480c0115ad556b766dfbd73fa`；Claude review remained paused and was not invoked。
