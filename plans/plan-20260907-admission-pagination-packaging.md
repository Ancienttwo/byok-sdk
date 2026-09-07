# Plan: Unified R1–R6 acceptance, CLI helpers and bounded admission/read progress

> **Status**: In Progress
> **Spec**: docs/spec.md
> **Baseline**: e134055856066b32fb9d6286d4cf1e69124b5fc9 (Draft PR #169)

## Authority

User extended acceptance with R4–R6 and requested combined repair and acceptance.
Keep PR #169 draft and preserve R1–R3. No release, deployment or production
migration. Probe attachments are unavailable in this workspace; reproduce from
the user-provided concrete traces, without claiming to have run those attachments.

## P1 / P2 / P3

- P1: packaged CLI and SDK entries share helper resolution; TaskRunner owns
  per-home admission and execution receipts; transport read position must not
  author reliable acknowledgement. Cloud and embedded endpoints own pagination.
- P2: CLI start → bundled daemon → reserved helper; offer → home reservation →
  detect → pure prepare → local admission/claim → owned runtime. Durable cursor
  stalled on page one currently rereads a nonempty page and hides later controls.
- P3: derive helper locations for every shipped entry; cancellable pure adapter
  admission can discard late results without inventing a disposal receipt. Once
  resources are owned, keep real cleanup authority. Separate bounded volatile
  reading from durable ACK, preserving replay and control order. Detailed read
  protocol decision follows the endpoint/retirement trace before implementation.

## Task Breakdown

- [x] R4: reproduce packed CLI start + actual MCP request, fix helper resolution.
- [x] R5: prove detect/prepare never-return and late-return failures; bound their
  task lifecycle, prevent late claim/start, verify same-home reuse and shutdown.
- [x] R6: real pageLimit=2 reproduction with delayed offer, completed tail, and
  later cancel/approve; repair read/ACK separation and replay/capacity behavior.
- [ ] Run combined R1–R6 regression, required checks after source freeze, push
  updated PR and verify its own CI. Preserve old-SHA evidence as historical.

## Verification

- Build, typecheck, API-surface (9 goldens), version-authority and strict
  task-workflow passed with Node 22.22.3 / isolated Bun 1.4.0.
- Workspace tests: 3835 passed / 135 skipped. Client 1798 passed / 11 skipped;
  after correcting the cloud capability inventory expectation, remaining
  workspaces passed 2037 / 124 skipped. The unchanged client suite was not rerun.
- Real pageLimit=2 reaches approve/cancel with ACK still zero; combined
  never-returning prepare is cancelled and its home reused. Original failed
  SQLite decline settles its receipt even after cancellation filters the offer.
- R4 baseline installed tarballs: root/adapters actual MCP pass, official CLI
  fails MODULE_NOT_FOUND at dist/bin/bin/byok-mcp-env.js. Fixed clean-subject
  tarball smoke and new-SHA CI remain to be observed.
- Tracking: #160 (R5/R6), #163, #167 and #170 (R4) remain open; PR #169 draft.
