# Implementation Notes: quiescent-runtime-disposal

> **Status**: Active
> **Plan**: plans/plan-20260814-0947-quiescent-runtime-disposal.md
> **Contract**: tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md
> **Review**: tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md
> **Last Updated**: 2026-08-14 10:20
> **Lifecycle**: notes

## Design Decisions

- `Session.close()` is the sole disposal receipt; `interrupt()` remains a soft/request path.
- POSIX roots use `detached:true` and negative-PID group signaling; Windows uses `taskkill /T /F`.
- TaskRunner reserves one semantic terminal synchronously, retains active/Git ownership through close, and retries typed disposal failure without a second terminal.
- macOS may transiently answer `EPERM` while an already-terminating orphan group is being reaped. `EPERM` is never treated as success: signaling becomes a no-op and the bounded group-absence poll must still prove quiescence.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Direct-child signals | Rejected | Cannot own tool descendants. |
| Release ownership in `finally` | Rejected | Allows overlapping workspace writers when quiescence is unproven. |
| Typed local disposal failure | Selected | Preserves semantic terminal authority while keeping cleanup failure observable and retryable. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix falsifier: `tasks/notes/20260814-0947-quiescent-runtime-disposal.pre-fix.md`
- Verification evidence: workspace build, typecheck, and test passed after the required build-first order; the client suite passed 1204 tests.
- Built evidence: adapter smoke passed all three normal paths, the missing-Pi-launcher pre-claim path, and all three root+descendant cancellation paths.
- The first bounded smoke gate exposed fixture-only process-tree activation during Claude/Codex detection probes: the task paths passed, but probe descendants kept the verifier process group non-quiescent. The lifecycle fixtures now activate only for real `-p` / `exec` runs. The bounded verifier then exited in 2.8s with no matching fixture process left behind; targeted process-tree/Claude/Codex tests passed 64/64.
- Exact-SHA Claude advisory attempt for the first frozen checkpoint returned only `Execution error` and therefore supplied no semantic verdict. Per the bounded `claude-review` contract it was not retried or recorded as a pass.
- The first strict contract projection also exposed verifier-shape drift: `tests_pass` runs with Bun, while the new process-tree test used Vitest-only `vi.waitFor`, one listed TaskRunner file did not exist, and the pre-existing Codex suite has Bun-incompatible async matcher syntax. The receipt poll is now runner-neutral; TaskRunner/Codex coverage is an explicit Vitest command. Bun process-tree passed 4/4 and targeted Vitest passed 49/49.
- Final host review found two receipt races that suite-level handles could mask: unref'ed disposal timers could let a standalone owner exit before descendant quiescence, and Codex `close()` could snapshot runners before an in-flight `followUp()` exposed its new child. Disposal timers now keep the owner alive; Codex registers each follow-up runner at spawn time and close joins the in-flight attempt. The new close/follow-up race regression plus process-tree suite passed 35/35 with client typecheck.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
