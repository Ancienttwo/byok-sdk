# Doctor repair planning evidence

Initial planning was attempted in a Claude Code read-only plan session on 2026-09-08, scoped to client diagnostics/store/auth code, with Read/Grep/Glob only. The session reached the 330-second deadline with no stdout plan and no stderr diagnostic. No successful Claude plan or review is claimed; no repeated paid consult was launched.

Main-agent source trace: AuthManager.loadRecord reads the OS enrollment and deterministically repairs missing/valid-stale non-secret DeviceStore metadata; loadExisting additionally schedules proactive renewal. The explicit repair must therefore share the reconciliation primitive, not invoke loadExisting. DeviceStore already performs bounded pathname-bound reads and atomic metadata publication. Existing doctor --fix only quarantines corrupt operational health, under the daemon store lease.

Decision: add a named, confirmed, exact tenant/device metadata repair and public read-only diagnostics. The action restores a projection from existing authority, not credentials or business state. Preserve current fail-closed behavior for invalid/legacy metadata and absent authority. No generic repair engine or automatic task rerun. Plan and contract: `plans/plan-20260908-doctor-repair.md`, `tasks/contracts/20260908-doctor-repair.contract.md`.
