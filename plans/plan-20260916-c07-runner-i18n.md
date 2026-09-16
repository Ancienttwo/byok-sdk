# Plan: C07 runner/i18n implementation entry

> **Status**: M1b accepted c8645877; M2a accepted be4a7c47; M2b-0 active, M2b blocked on custody/loader boundaries
> **Task Profile**: implementation
> **Planning Source**: Owner §96 Q1–Q3 design approval; supervisor6696c211 PASS and design-entry instruction
> **Task Contract**: `tasks/contracts/20260916-c07-runner-i18n.contract.md`
> **Task Review**: `tasks/reviews/20260916-c07-runner-i18n.review.md`
> **Implementation Notes**: `tasks/notes/20260916-c07-runner-i18n.notes.md`

## Goal

Prepare the bounded implementation contract in [docs/researches/20260916-c07-runner-i18n-implementation-entry.md](../docs/researches/20260916-c07-runner-i18n-implementation-entry.md), without product writes. Preserve async behavior/localization and strict launch authority. SDK6696c211 is accepted helper-lookup base, not complete containment.

## P1 / P2 / P3

- P1: Host owns immutable declarations; shared owns measurement; daemon owns launch policy; keys owns custody; child consumes declarations.
- P2: daemon resolves self/descendants → exact config checksum → Pi → runner → later Pi → result/cancel. Last recursive edge still needs a complete custody/env trace before product implementation.
- P3: Host finite multi-kind table projects one single-prefix SDK record per locator. Same artifact does not authorize child retargeting. Private source integration and real i18n dependency preserve capabilities; publication/feature removal remain separate.

## Task Breakdown

- [x] Read6696c211 independent gate; register compiler default discovery as future removal, preserve product freeze.
- [x] Prepare schema/version/encoding freeze sheet, P4 interfaces, locale layout and recursive custody/env matrix.
- [x] Register inactive implementation scope, native1006 checklist and Owner decision boundaries.
- [x] Run docs-only diff/path/workflow checks and record evidence.
- [x] Supervisor review of this new design-entry packet; two wording requests incorporated (not another product gate).
- [x] Owner approved M0, SDK M1–M3 and Salesko P4 separately presented scopes (reply「批准」).
- [x] Produce four-kind/five-edge draft, source inventory and independent byte vectors; freeze C composition candidate with unchanged V1 templates and distinct policy/perLaunch.
- [x] M00df88a7f accepted; custody execution obligations remain explicit M1 enablement gates.
- [x] Register exact SDK M1a declaration/dependency/compiler/test paths; P4 remains separate.
- [x] M1a implemented6eec0ab6: strict runtime wrapper/four-kind locator, immutable measured declaration, unchanged MCP, explicit compiler identity.
- [x] Freeze M1a product6eec0ab6 separately from docs; local targeted checks passed.
- [x] Supervisor unique full/pack gate PASS on M1a d9e55a4e; S2 tripwire36 remains the explicit residual.
- [x] M1b exact source/license inventory and product paths registered while M1a gate runs; no M1b product writes.
- [x] M1b implementation frozen56f1e569: private todo, both locale roots, six licensed UI sources and targeted validation.
- [x] M1b supervisor complete gate plus packaging/docs re-gate PASS c8645877; S2 tripwire24 remains.
- [x] Register M2a exact paths and M2b inactive234-source vendor inventory.
- [x] M2a shared composition/physical gate + daemon config templates implemented; dispatch remains disabled.
- [x] M2a supervisor frozen full gate PASSbe4a7c47; client2724/identity74/real pack0, S2only24.
- [x] M2b-0 wire all20 context/transition vectors, capture10RED, freeze7cabc200 with104shared tests; dispatch remains disabled.
- [ ] M2b-0 supervisor targeted gate on frozen product/docs (no full/pack).
- [ ] M2b custody execution table and loader classification accepted before vendor/runner writes.
- [ ] M2 runner: prove all custody execution calls before enabling descendant dispatch.
- [ ] M3: functional/packed recursive and locale acceptance; clipboard remains1006 blocker.

## Stop / verification

Only the five contract docs plus the two explicitly approved inert JSON vectors are writable under this successor. No production schema/parser/test source/package/lock/golden edits, install, full/pack, external action or Salesko product change. `git diff --check` and `repo-harness run check-task-workflow --strict`; review verifies no accepted invariants weakened. Four-kind/five-edge draft and source inventory are prepared; composition C and custody gate await supervisor acceptance. Hash agreement is not M0 PASS.

## Active implementation boundary
The M1a contract activation supersedes historical M0-only Stop/verification text above. Only its enumerated paths are active; no runner/print dispatch or unproved recursive budget path is enabled. Root owns all edits including manifests/lock/goldens; read-only explorer maps impact.
