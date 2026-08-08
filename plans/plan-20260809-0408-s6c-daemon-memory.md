# Plan: S6-c Daemon Proof and Memory Path

> **Status**: Executing
> **Created**: 20260809-0408
> **Slug**: s6c-daemon-memory
> **Artifact Level**: work-package
> **Promotion Reason**: S6-a/S6-b 已冻结 proof verifier 与 atomic truth authority；最后一个未闭环面是 daemon 如何产生同一 canonical proof，并在本地完成 manifest selection、selected fetch、rehash 与 filter，且让未验证 bytes 永远不进入 runtime context。
> **Verification Boundary**: client proof signer、truth HTTP client、selector/filter seam、inline/object integrity、manifest race、large-snapshot metric、真实 cloud handler E2E、full workspace gates。
> **Rollback Surface**: revert client/core dependency、proof signer/truth client 与 S6-c docs；不改 protocol、schema、migration 或既有 daemon task loop。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s6-proof-truth-memory-design.md`
> **Task Contract**: `tasks/contracts/20260809-0408-s6c-daemon-memory.contract.md`
> **Task Review**: `tasks/reviews/20260809-0408-s6c-daemon-memory.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0408-s6c-daemon-memory.notes.md`

## Agentic Routing

- Selected route: main-thread code-change；Claude review remains paused。
- P1 map: `@byok/core` owns canonical proof bytes and truth selectors；`@byok/client` owns the private key, HTTP fetch and local semantic boundary；`@byok/cloud` remains the proof verifier/metadata authority and is not a client dependency。
- P2 trace: explicit tenant/product/key identity + paired local key → request-bound proof → metadata-only manifest → local selector → proof-bound record GET → optional object download → byte size/hash verification → local filter → runtime-owned context。
- P3 decision: add one client-side signer port and one `TruthMemoryClient`; do not inject memory into the existing task loop because runtime context shape and host policy are not defined by S6. The returned value is filter output only; verified raw bodies stay inside the local seam。

## Workflow Inventory

- Active plan: `plans/plan-20260809-0408-s6c-daemon-memory.md`
- Contract: `tasks/contracts/20260809-0408-s6c-daemon-memory.contract.md`
- Review: `tasks/reviews/20260809-0408-s6c-daemon-memory.review.md`
- Notes: `tasks/notes/20260809-0408-s6c-daemon-memory.notes.md`
- Branch/worktree: `codex/s6c-daemon-memory` / `/Users/ancienttwo/Projects/byok-sdk-wt-s6c-daemon-memory`
- Base: S6-b commit `7f26b5c`; stacked until PR #35 merges。

## Approach

1. Add `@byok/core` as the client runtime dependency for the already-frozen proof canonicalizer and truth selector types；do not copy canonicalization logic。
2. Implement a stored-device proof signer requiring explicit tenant/product/key id/epoch and loading the paired private key for every signature so unpair revokes local signing immediately。
3. Implement proof-only record list/read/write client. Writes compute inline hashes locally and require caller-owned request ids；object writes only accept canonical hash/size for an already finalized object。
4. Implement `MemorySelector` and generic local filter seams. Reject unknown/duplicate selections, metadata changes between list/get, malformed responses, byte-size drift and hash drift before calling the filter。
5. Emit the 1 MiB snapshot metric without rejecting the record or inventing delta mode；prove inline and object E2E against the real cloud handler surface。

## Promotion Gate

- **Merge/PR unit**: one stacked S6-c PR targeting `codex/s6b-atomic-truth` until #35 merges。
- **Rollback surface**: client-only API/dependency + docs revert；no migration rollback。
- **Verification boundary**: signer golden parity, selector/fetch/filter tests, real handler E2E, hard-env full workspace gates and PR CI。
- **Review/acceptance boundary**: independent Codex security review on the stacked head before S6 capability default-on；Claude remains paused。
- **High-risk surface**: private-key use, tenant/product binding, untrusted remote metadata, object integrity and semantic-boundary leakage。
- **Why not checklist row**: this is the final cross-package security path of S6 with its own rollback and falsifiers。

## Evidence Contract

- **State/progress path**: Task Breakdown + contract/notes/review + sprint D-10/S6.5。
- **Verification evidence**: production signer checked against core signing bytes；deterministic selector/fetch/filter suite；real cloud route E2E；full repo gates；protocol/schema/migration zero diff。
- **Evaluator rubric**: no implicit tenant；no copied canonicalizer；proof binds exact path/query/body；only selected records fetched；filter never sees unverified/mismatched bytes；large metric is observability only。
- **Stop condition**: any bearer fallback, cloud semantic selection, unchecked body reaching filter, protocol drift, or daemon task-loop semantic guess。
- **Rollback surface**: revert S6-c and leave S6-a/S6-b capability gated。

## Task Breakdown

- [x] Freeze S6-c contract and client boundary。
- [x] Implement stored-device proof signer and explicit identity config。
- [x] Implement truth read/write client plus selector/filter/integrity path。
- [x] Add signer, adversarial and real-cloud E2E tests。
- [x] Run hard-env/full workspace gates and protocol/schema/migration zero-diff checks。
- [ ] Push stacked Draft PR and retain independent security acceptance gate。
