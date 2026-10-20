# B3: external-Bot beta task tools

Issue: [#585](https://github.com/Ancienttwo/byok-sdk/issues/585). Source: [beta plan §3.1/§5/§8](2026-10-19-byok-mcp-server-external-bot-beta.md).
Base: `f9a6ac75`. B1 (#547) and B2 (#550, [plan](2026-10-19-byok-mcp-beta-b2.md)) are on `main`.
This slice changes the private copy-and-own example. It does not change SDK APIs.

## P1: map

- Auth and admission: `examples/byok-mcp-server/src/{ledger,http}.ts` (B2). The
  wrapper authenticates each request and passes an immutable caller handle to a
  `ScopedTool`. The ledger saves reservations and quota slots. It never dispatches.
- SDK surface: `ByokServer.dispatch`, `tasks.{get,offer,cancel,deviceTerminal}`,
  `blobs.getDownloadUrl` and `machines.list` (`packages/server/src/index.ts`).
- `tasks.list` pages all tenant tasks by task ID. It has no owner filter and no
  time order, so the task list pages the key's ledger rows instead.
- `dispatch` without an AgentRef parses `terminalProjection` and drops it. The
  `task.offer` and `task.offer_with_toolsets` payloads have no field for it.
- `DispatchInput` has no workspace field. The wire `workspaceHint` is reserved and
  ignored. The daemon runs a plain task in `<workspaceRoot>/<taskId>`.
- `TaskResult.artifactRefs` comes only from `task.complete`. The daemon sends files
  as live `task.artifact` events and sets no `artifactRefs`.
- `machines.list` runtime facts come from fresh presence only. The real daemon
  publishes them; the testkit simulator does not.

## P2: one real path

1. A standard MCP client calls `byok_task_submit` over Streamable HTTP with a key.
2. The handler validates the arguments, refuses `resultSchema` and `workspace`,
   and calls `lookupTask`. With no saved reservation, it reconciles the key's
   open slots, selects a granted device from `machines.list` and calls `reserveTask`.
3. `ensureDispatched` reads `tasks.offer`. With no offer, it calls `dispatch` with
   the saved task ID and binding. After a failure it reads the offer back and
   accepts only an exact match.
4. The daemon claims, the fake runtime emits progress and `turn_end`, and the
   daemon sends `task.complete`.
5. `byok_task_status` consumes one status read, long-polls `tasks.get` and, on a
   terminal state, calls `reconcileTask`. The slot is released.

## P3: decisions and invariants

- The B2 ledger stays the one owner record. The tools store no task state, result
  or artifact. Every SDK read starts from the key's saved reservation.
- Refuse plan inputs that the SDK cannot honor, before admission. Do not drop
  them silently. Record both as SDK gaps for a later slice.
- No new SDK API, no new ledger table, no schema version change. The two ledger
  additions (`listTasks`, `openTasks`) read existing rows.
- Status waits by reading `tasks.get` at a fixed interval. `events.subscribe`
  replays up to 1000 tenant events per reader and its iterator has no `return()`,
  so a waiter per status call is costlier than a bounded durable read.
- Device selection is deterministic: key order, then fresh runtime presence, then
  offline (queued), then online without the runtime.
- A dispatch refused before the task exists keeps its slot (B2 rule). The Host
  clears such slots by revoking the key and issuing a new one.

## Verification

Use the real device daemon from `@byok-sdk/client`, paired to an embedded
`createByokServer`, with a scripted `RuntimeAdapter` in the example. Use the
standard MCP HTTP client over a loopback socket. Use the testkit device simulator
only for a terminal with `artifactRefs`, which the daemon does not produce.
Keep the repository's default test time limits. Change no existing assertion.
Run all five required root checks on the final source.

## Task Breakdown

- [x] Map the SDK task surface and the B2 contract. Record P1/P2/P3.
- [x] Implement the seven tools and the two ledger reads.
- [x] Prove submit, status, cancel, list and artifact URL over MCP with the real daemon and the simulator.
- [x] Run the five root checks and an independent security and test review. Record results in the example README.
