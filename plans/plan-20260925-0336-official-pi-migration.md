# Plan: Official Pi migration and zero-tool prepared execution

> **Status**: Executing
> **Created**: 20260925-0336
> **Slug**: official-pi-migration
> **Artifact Level**: work-package
> **Promotion Reason**: runtime_authority_cutover
> **Verification Boundary**: exact official 0.87.1 artifacts, offline request capture/consume, tool isolation, SDK required checks and packed installation. No provider/production activation.
> **Rollback Surface**: revert the migration before release; no dual runtime or old artifact reader.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260925-0336-official-pi-migration.contract.md`
> **Task Review**: `tasks/reviews/20260925-0336-official-pi-migration.review.md`
> **Implementation Notes**: `tasks/notes/20260925-0336-official-pi-migration.notes.md`

## Authorization
Owner explicitly approved proceeding with the official Pi migration while keeping production disabled. No publication, tag, merge or deployment authorization. Baseline `3dd7ba6f`; independent branch `codex/pi-official-migration`. The preceding P0's fork-freeze remains honored: migrate to official artifacts, do not edit/publish the old fork.

## Scope
Resume feasibility against official 0.87.1 and SDK 0.21.0; retain every current prepared/history invariant. The 2026-09-19 migration artifacts in PRs #210–#213 are prior evidence, not current acceptance. Their owner pause is superseded by the explicit 2026-09-25 resume authorization; it does not authorize weaker product semantics.

## Agentic Routing
Parent maps SDK integration and makes the architecture decision. Delegated read-only research inspects exact official 0.87.1 package/public APIs. No implementation dispatch before P3 is resolved from actual API evidence.

## P1 Architecture Map
Protocol owns the wire and capability cut. Client input-preparation service owns durable artifact/reserve/pin; the Pi adapter currently delegates compilation and prepared execution to fork-only exports. Runtime host, RPC framing, implementation identity, vendored assets and release-pack gates also bind that fork. SDK cloud owns authenticated offers and retained terminals. Host owns budgets/quality/CAS.

## P2 Concrete Trace
Host source -> preparation wire -> device tool observation -> native compiler D/projection -> durable artifact -> prepared offer -> authority/identity comparisons -> pin/claim -> native prepared RPC -> usage validation -> internal result-document or daemon-authored message. Empty toolsets fail at the protocol schema, and the frozen native session independently refuses zero tools. Official serialization/execution must remain semantic authority.

## P3 Decision Boundary
Verify exact public APIs before selecting the migration. No copied fork compiler, shadow parser, semantic repair, dual runtime or unprepared fallback. Need a proven official-owned freeze/consume boundary and zero-tool session; if upstream cannot provide the invariant, record the exact gap and resolve the contract explicitly before changing product semantics. At 10x input size artifact bytes, subprocess preparation and bounded storage are the first pressure points.

## Task Breakdown
- [x] M1: exact official artifacts and unchanged public-import P08 tested; capability partial (five required public exports absent). This falsifies the existing migration admission precondition; no prepared behavior PASS.
- [ ] M2: freeze coherent runtime/wire/storage cut, file-level changes and accepted authority boundaries.
- [ ] M3: implement one official runtime path, remove fork-only dependencies/assumptions, and support zero-tool preparation/result-document.
- [ ] M4: validate drift refusals, exact first request, no tool/message leakage, usage, recovery, package closure and full required checks.
- [ ] M5: commit/push implementation PR after M2–M4; meanwhile submit this prerequisite evidence as a draft without claiming migration complete.

## Verification Plan
Start with exact official artifact probes without credentials/provider traffic. After code freeze run build, typecheck, tests, API surface, version authority, strict workflow and exact clean-commit release-pack. Synthetic requests and counts never establish a production budget ruling.

## Promotion Gate
- **Merge/PR unit**: independent runtime migration.
- **Rollback surface**: branch revert before release; published runtime cut requires paired upgrade/drain.
- **Verification boundary**: installed exact artifacts and offline captured transport; no native provider quality claim.
- **Review/acceptance boundary**: final diff review and observed gates, no merge.
- **High-risk surface**: runtime compiler authority, strict wire, artifact identity, credential/tool isolation.
- **Why not checklist row**: runtime authority cut spans protocol, client and package distribution.

## Evidence Contract
- **State/progress path**: this plan and matching notes/review.
- **Verification evidence**: exact source/package hashes and command logs recorded in notes.
- **Evaluator rubric**: before-transport refusals, byte equality and semantic authority, zero tools when explicitly selected.
- **Stop condition**: implemented/verified submitted PR, or exact unresolvable upstream contract gap recorded without fallback.
- **Rollback surface**: revert branch commits, keep production closed.

## Current blocker

Fresh P08 on official 0.87.1 imports records 5/10 exports available; Host assistant declarations still require provider provenance. M2–M4 cannot proceed without resolving these authority gaps. Prior #213 findings were recovered and corrected for current version; no copied compiler, fake usage, private import or capability deletion was introduced. The owner was asked whether to prepare and submit minimal changes to the external `earendil-works/pi` repository. Production remains disabled.
