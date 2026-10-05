# Goal / btw for a continuously conversational Bot

Status: Host reference implemented; independent Claude review and final root checks in progress. Base `ede2db31`.

## Product correction

Both goal and btw are useful interaction patterns for a Bot. The earlier research's rejection concerns default installation of the native TUI packages into a sealed SDK execution, not rejection of persistent goals or questions asked while work is running.

- Goal: preserve an explicit objective across executions; stop on completion, blockage, explicit pause/cancel, wait or a bounded budget.
- Btw: answer a separate question while main work continues. It does not implicitly rewrite the main transcript or change its task instruction.
- Steering: change the running task's instruction through the existing runtime capability gate.
- Follow-up: queue dependent work; it must not silently dispatch under an ended Attempt.

## Verified source trace

`ByokCloud.submitRecurringExecution` / embedded `recurring.submit` accept a Host-persisted, exact fresh execution shape. The strict recurring schema requires runtime, message egress, terminal selection, exact device and AgentRef, and server-held destination/freshness. Cloud/server expose immutable offers, attempt/cancellation truth and canonical device terminals. There is no SDK Conversation store.

The device counts active attempts and synchronous reservations by canonical Agent home before adapter preparation/claim. The default bound is one mutable session. Home identity follows agentId, not profileRevision; a changed revision is not a separate home. Physical close failure holds the home busy, and the existing tests prove this.

Prepared Pi uses a sealed transcript/tool manifest and no ambient extensions, skills or context files. Ordinary Pi RPC explicitly includes the owned web/subagents factories. Native Pi calls `agent_settled` only after its current queues/retry/compaction settle; a detached future goal timer is not automatically part of the SDK Attempt. `Session.followUp` has no production TaskRunner caller. The `steer` chain already exists.

## Options being discussed

| Option | Benefit | Boundary to prove |
| --- | --- | --- |
| Native pi-goal/pi-btw extensions | Reuses the original Pi UX and runtime behavior | TUI/RPC limitations, wait lifecycle, additional provider requests, custody and prepared byte identity; Pi-only |
| Host-owned orchestration using existing SDK executions | Works across Pi/Claude/Codex and both Host continuity modes | Host persistence/CAS/outbox, selected context and explicit side target, no hidden second scheduler |
| New local SDK scheduler | Hides orchestration inside daemon | Conflicts with Host Conversation authority; do not introduce without a concrete invariant requiring it |

## Cheapest proof points

1. Existing single-writer/fresh-session tests: main continues, same-home additional offer is refused, different Agent home can run concurrently.
2. Goal lifecycle: a bounded reserved execution survives Host restart; late/duplicate completion cannot advance the objective twice; wait does not busy-loop; pause/cancel cannot mint a new execution.
3. Btw: exact independent task, Agent target and destination; readonly execution; no main cancellation/steering/transcript write; side cancellation targets only the side task.
4. Recovery must use exact offer/attempt readback, not a process-owned TaskHandle or inferred delivery from a terminal-free snapshot.

## Advisory boundaries

Avoid a generalized GoalStore/controller until the concrete first implementation needs it. The selected slice is private copy-and-own code in examples/basic with its own SQLite namespace/CAS/outbox, public-client stub and real embedded coordinator tests. No public GoalStore/controller or SDK Conversation store is added. Tool visibility is not invocation authorization. A model reporting goal completion remains a claim until the Host accepts the result. Device terminal is not physical home release. There is no positive release receipt; a next step goes through ordinary admission, and a busy decline blocks without implicit retry. There is no per-step time limit: a stuck step is bounded only by the goal deadline and the Host calling tickGoal; Fresh dispatch does not expose/forward limits.

## Prerequisite receipts

The isolated worktree's frozen dependency install, baseline build/typecheck, and 15 existing home/fresh-session tests passed. No third-party plugin was installed and no live provider request was spent.

## Claude discussion corrections adopted

- Ordinary in-Run goal does not inherently create a second terminal authority; default native plugin installation is a distinct compatibility/accounting/lifecycle question. Host orchestration remains the first portable implementation.
- No public SDK scheduler/store API; only the existing private basic example and its workspace lock row change.
- Message-free result steps use dispatchFreshAgentEgress; recurring.submit requires messageEgress and is not used to pretend this step is a user-visible message.
- Results use exact small lowercase contracts and strict JSON; model verdicts require explicit Host acceptance. SDK attempt cancellation outranks late device terminal.
- Paused complete/blocked results are retained; only continue/wait stay paused.
- Home-busy decline persists failed Attempt and device terminal (inbound.ts:628); it is not missing-attempt evidence. The native AgentHome cap remains one.
- Original package pins, wire, packages/**, public API goldens and server.ts behavior remain unchanged. SQLite is built-in node:sqlite; the database is Host-owned and never an SDK store.

Implementation and usage: [goal-btw.ts](../../examples/basic/goal-btw.ts), [usage](../../examples/basic/goal-btw-usage.md), [public-API acceptance tests](../../examples/basic/goal-btw.test.ts).
