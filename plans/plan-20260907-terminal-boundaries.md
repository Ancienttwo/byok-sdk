# Plan: Pending terminal and interrupted harness boundaries

> **Status**: Complete
> **Spec**: docs/spec.md
> **Baseline**: 0c70396dbec8cc70a354ac7d7222b25cc92b9469

## Authority

Repair acceptance findings R1–R3 for reopened #163/#167, verify, commit and push.
Release and deployment remain blocked. Preserve unrelated worktrees.

## P1 / P2 / P3

- P1: TaskRunner selects execution; SQLite owns admission and terminal bytes;
  TerminalCommitQueue owns selected but uncommitted decisions; cloud owns claim.
- P2: offer append → admission → local beforeClaim commit → cloud claim → runtime
  → terminal journal → cloud receipt. A rollback can leave `received` despite a
  selected decline. A crash can leave local admission without a cloud claim.
  Oversize terminal replacement currently drops the admitted custom identity.
- P3: fence replay before admission, project terminal identity from execution
  facts, and bind interruption reports to immutable offers. Unclaimed recovery
  is an observation, never a fabricated claim. Claimed terminal matching stays
  strict. At 10x, failed pending commits consume bounded journal/outbox capacity;
  the fix does not treat volatile state as crash durability.

## Task Breakdown

- [x] Reproduce R1 with SQLite rollback and changing admission availability.
- [x] Reproduce R2 explicit/auto custom recovery before/after cloud claim.
- [x] Reproduce R3 explicit/auto oversized terminal through real cloud HTTP.
- [x] Repair pending-decision fence and shared terminal identity projection.
- [x] Define and test offer-bound interruption recovery, including rejection cases.
- [x] Run required checks on frozen source, update evidence, commit and push.

## Verification and disposition

- Pre-fix: 5 failed / 2 passed in the real-journal/cloud boundary matrix.
- Post-fix: 7/7 matrix; cloud contract 7/7; full root 3825 passed / 135 skipped.
- Build, typecheck, API surface, version authority, strict workflow passed.
- Deliver the repair branch for acceptance; #163/#167 remain Open. No merge,
  release, production migration or deployment is included in this slice.
- Evidence: docs/researches/2026-09-07-execution-receipts-and-harness-identity.md.
