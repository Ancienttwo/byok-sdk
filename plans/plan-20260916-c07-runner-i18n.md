# Plan: C07 runner/i18n implementation entry

> **Status**: Draft
> **Task Profile**: docs-only
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
- [ ] Owner implementation activation; until then all M0–M3 product work is inactive.

## Stop / verification

Only the five contract docs are writable under this successor. Existing parent notes/plan/review updates use their existing contract. No package/lock/schema/test/source edits, install, full/pack, external action, Salesko change. `git diff --check` and `repo-harness run check-task-workflow --strict`; review verifies no accepted invariants weakened. M0 literal schemas and recursive trace are future entry evidence, not completed by this packet.
