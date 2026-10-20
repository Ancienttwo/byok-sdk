# B4: external-Bot beta routine tools

Issue: [#586](https://github.com/Ancienttwo/byok-sdk/issues/586). Source: [beta plan §3.2/§5/§8](2026-10-19-byok-mcp-server-external-bot-beta.md).
Base: `abdc1720`. K4 (#532) and B3 (#589, [plan](2026-10-20-byok-mcp-beta-b3.md)) are on `main`.
This slice changes the private copy-and-own example. It does not change SDK APIs.

## P1: map

- Ownership and quota: `examples/byok-mcp-server/src/ledger.ts` (B2). `reserveRoutine`
  saves `(keyId, localId)` ownership, an argument hash and one routine slot.
  `releaseRoutineSlot` is reserved for trusted Host/K4 completion. Routine scopes
  need an AgentRef.
- K4 routine ledger: `examples/host-execution-core/src/{core,routines,schedule}.ts`.
  `HostExecutionCore.addRoutine` commits an immutable `RoutineDefinition`
  `{ id, version, timeZone, rule, execution, waitMs, lateAfterMs }`, then flushes one
  SDK wake `<id>:<version>:<t>`. The wake hook (`consume`) commits the occurrence, its
  intent and the next slot together. Each occurrence runs as an Agent execution
  (`executions.submit`, offer type `task.offer_for_agent_with_egress_fresh`).
  `lifecycle(id, 'completed')` cancels the next wake and keeps started work.
- Calendar: K4 takes an injected `NextOccurrence` and defines no cron dialect. The
  SDK calendar is `checkRoutineSchedule`/`nextRoutineOccurrence` (`packages/core/src/routine-schedule.ts`):
  `{ minute, hour, daysOfWeek? | dayOfMonth? (month?), tz }`, 368-day horizon. K8a
  (`examples/bot-collaboration/src/routines.ts`) uses the same functions.
- The fresh Agent offer carries `requiredToolsets` and `terminalProjection`
  (`none` or `result-document` with a schema). So routine tasks can honor
  `toolsets` and `resultSchema`. B3's plain `dispatch` cannot.

## P2: one real path

1. A standard MCP client calls `byok_routine_create` over Streamable HTTP with a key.
2. The handler validates `localId`, the schedule (`checkRoutineSchedule`) and the
   task. It calls `lookupRoutine`. With no saved reservation, it checks the runtime
   grant, selects a granted device (B3's ranking) and calls `reserveRoutine`.
3. With no K4 routine for that ID, it calls `core.addRoutine` with
   `id = routineId`, `version = 1`, `rule = schedule`, `timeZone = schedule.tz` and an
   execution template built from the key's AgentRef and the Host's egress policy.
   K4 computes the first slot with `routineScheduleCalendar` and schedules the wake.
4. At the due time the SDK delivers the wake to `core.consume`. K4 records the
   occurrence and submits the frozen Agent execution. The daemon runs the stub
   runtime; `submit_result` returns the document; K4 settles `succeeded`.
5. `byok_routine_list` reads K4's snapshot: lifecycle, status, next slot and the
   newest occurrence with its task ID, conclusion and terminal document.
6. `byok_routine_cancel` sets K4 lifecycle `completed`, then releases the slot.

## P3: decisions and invariants

- K4 is the only routine scheduler. The beta ledger keeps ownership and the slot.
  The tools store no definition, occurrence or outcome. List reads K4.
- The schedule input is the SDK `RoutineSchedule`, not a cron string. The beta plan
  text says `{ cron, tz }`, but no cron dialect exists in the repository; K4 and
  K8a both use `RoutineSchedule`. This avoids a second calendar.
- The Host injects `routineScheduleCalendar` as K4's `nextOccurrence`. A Host with
  other K4 calendars composes its own dispatcher. The tools do not check the
  core's calendar; a wrong calendar makes `addRoutine` fail and the create returns
  `unavailable`.
- Definitions are immutable (K4). The same `localId` with other arguments is
  `idempotency_conflict`. To change a routine, cancel it and use a new `localId`.
- A released reservation only reads back. A create retry never schedules it again.
  The final release check and K4's commit run in one synchronous step.
- A failure before K4 commits keeps the reservation (`reserved`) and its slot. A
  retry of the same create schedules it, or cancel retires it. A failed wake flush
  after the commit is success; K4's durable outbox retries it.
- K4 `completed` is the only release authority. Cancel releases after the K4
  commit. List releases any completed routine whose release was lost.
- Revocation stops future occurrences. B2 says revocation applies to the next call
  and does not kill a running task. A routine occurrence is a new call, so the
  revocation listener completes the key's routines on K4; a started occurrence
  finishes. `retireRevokedRoutines` at Host startup finishes an interrupted retirement.
- Routine occurrences are not `byok_task_*` tasks. They have no beta task row, so
  `byok_task_status` answers `not_found` for them. Their outcome is in the list.
- Out of scope: `byok_memory_*` (B5), pause/resume, same-ID versions (K8a
  `update_routine`), and a webhook push of occurrence results.

## Verification

Use K4's test Host (`@byok-sdk/example-host-execution-core/test-support`): the
embedded server, the real device daemon with Agent homes and egress, and the stub
Pi runtime that calls the real `submit_result` helper. Mount the beta MCP endpoint
on a loopback origin and use the standard MCP HTTP client. Mock only `Date`, as
K4's routine tests do. Keep the repository's default test time limits. Change no
existing assertion. Run all five required root checks on the final source.

## Task Breakdown

- [x] Map K4's routine ledger, the SDK calendar and the B2 routine contract. Record P1/P2/P3.
- [x] Implement the three routine tools, the calendar, revocation retirement and three ledger reads.
- [x] Prove create, occurrence, outcome, cancel, retry, revocation, quota and ownership over MCP with the real daemon.
- [x] Run the five root checks and record results in the example README.
