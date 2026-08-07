# Architecture Snapshot: root card ruling

> **Date**: 2026-08-07
> **Functional Block**: `root`
> **Capability ID**: `root`
> **Type**: ruling (adjudication record, not a boundary description)
> **Request Card**: `docs/architecture/requests/root.md`

## Event

The root architecture-queue card carried two drift events, both from commit `a3ab9a9` (2026-08-05, K0):

- `packages/keys/package.json`
- `packages/keys/tsconfig.json`

They are a real boundary change: K0 introduced `@byok/keys` as a provider credential plane.

## Ruling

Closed as `Resolved` by adjudication. The boundary was already recorded before the card was reviewed, so no new architecture documentation is owed.

Canonical record: `docs/architecture/sdk-architecture.md` §7 — `@byok/keys` as an independent provider credential plane, with file:line evidence. Re-verified by the 2026-08-07 v1 and v2 architecture slices. This snapshot deliberately does not restate §7; §7 remains the single source of truth for the boundary.

## Slice

- Plan: `plans/plan-20260807-1144-architecture-root-card-closeout.md`
- Contract: `tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md`
- Notes: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`
