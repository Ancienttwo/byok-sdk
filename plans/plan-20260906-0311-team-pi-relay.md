# Plan: Pi interaction authority and Codex↔Pi notification

> **Status**: Approved
> **Created**: 20260906-0311
> **Slug**: team-pi-relay
> **Artifact Level**: work-package
> **Promotion Reason**: User approved Pi interaction rules and minimal Codex↔Pi integration.
> **Verification Boundary**: Exact chosen Pi UI/host boundary, confirmation hold and peer round trip; not three-harness or release.
> **Rollback Surface**: Independent worktree; existing TeamWorkspace and Codex behavior retained.
> **Spec**: docs/spec.md
> **Research**: docs/researches/2026-09-06_pi-interaction-authority.md

## Goal

Connect one Pi member to the existing local Codex relay without starting automatic
work through unresolved operator confirmation. Preserve explicit session/grant,
message/receipt ownership, finite attempts, pause/stop, and unknown-delivery halt.

## P1: Architecture map

See research: durable TeamWorkspace → authenticated snapshot; native Codex queue;
Pi 0.85.1 provides public coalesced UI lifecycle events; the selected RPC host
uses a first-loaded native guard and exact-ID GUI responses. The prior 0.84.2
isIdle counterexample is historical, not the current admission contract. Main has concurrent event-spill WIP.

## P2: Concrete trace

Recorded Pi TUI counterexample proves isIdle cannot gate dialogs. Candidate path
is Codex post → snapshot → authoritative Pi notification admission → Pi MCP
read/reply/ack → existing Codex queue. The missing pressure point is admission
ownership, not message transport. No duplicate model probe needed for the known
counterexample.

## P3: Approved RPC and GUI boundary

The user explicitly clarified that agents are not opened as local TUIs; human
interaction, when present, is through a GUI. Proceed with an owned Pi RPC member
and a structured host-facing interaction interface. Do not build a replacement
terminal UI. The user explicitly pins the package-local Pi upgrade to 0.85.1.
Dependency authority remains packages/client/package.json and bun.lock; global
Pi installs and historical 0.84.2 probe evidence are not rewritten.

P1 upgrade: client manifest/lock → resolvePiBin package entry → native Pi RPC.
P2 upgrade: fresh-session get_state/sessionId, prompt acceptance, extension UI
request/response and agent_settled are the contracts to revalidate on 0.85.1.
P3 upgrade: exact requested patch, no runtime fallback to 0.84.2 or another model.

Implementation contract is tasks/contracts/20260906-0311-team-pi-relay.contract.md.
Review and notes use the same task ID. Existing Claude reviews the updated
boundary and final implementation; no main-worktree or event-spill edits.

## Promotion Gate

- **Merge/PR unit**: chosen boundary only; no merge/push authorized for this slice.
- **Rollback surface**: independent source/doc changes; no existing session adoption.
- **Verification boundary**: deterministic gating tests, bounded exact-native smoke, required repository checks.
- **Review/acceptance boundary**: existing Claude reviews the concrete selected plan and final source.
- **High-risk surface**: admission during operator confirmation; reject unknown ownership.
- **Why not checklist row**: the public native UI boundary is missing; a host changes user-facing interaction.

## Evidence Contract

- **State/progress path**: this plan and research until the chosen implementation contract is concrete.
- **Verification evidence**: current package-local API declarations and prior exact TUI counterexample; fresh evidence only for new behavior.
- **Evaluator rubric**: no notify admission while an owned confirmation is unresolved; no invented global UI state; actual Codex↔Pi read/post/ack.
- **Stop condition**: unresolved UI choice, unsupported native contract, unknown admission or three unsuccessful fix rounds.
- **Rollback surface**: codex/team-pi-relay worktree; preserve main event-spill WIP.

## Task Breakdown

- [x] Isolate at 5af5c5c and map current native/public API boundaries.
- [x] Consult existing tmux Claude and record independent findings.
- [x] Resolve native TUI versus owned RPC host product boundary.
- [x] Write the exact approved implementation contract and selected plan.
- [ ] Implement and verify confirmation admission and Codex↔Pi round trip.
- [ ] Run required checks and independent acceptance; record remaining scope.

Selected native guard/GUI design and tested transport details: see the research.
