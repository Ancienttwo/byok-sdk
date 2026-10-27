# External-Bot MCP beta: B2, B3, B4 and B5

This private, copy-and-own example supplies the Host authorization and admission
ledger (B2), the task tool catalogue (B3), the routine tools (B4) and the
read-only memory tool (B5) from
[the beta plan](../../docs/plans/2026-10-19-byok-mcp-server-external-bot-beta.md).
It reuses the public B1 HTTP transport, the public `@byok-sdk/server` API and the
K4 Host execution core (`examples/host-execution-core`) for routines and memory.
It adds no public SDK API or new SDK runtime dependency.
There is no listener, admin HTTP route, default key or model invocation here.
- [Grok Bot client guide and owner acceptance checklist (B6)](docs/grok-bot.md)

- [Hermes client guide, setup check and live acceptance checklist (B7)](docs/hermes.md)
## Host composition

```ts
import type { AgentExecutionInput, ByokServer } from '@byok-sdk/server';
import { BetaLedger, createBetaMcpServer, createTaskTools } from './src/index';

export function composeBeta(
  sdk: ByokServer,
  filename: string,
  tenant: string,
  origin: string,
  sdkOrigin: string,
  egressPolicy: AgentExecutionInput['payload']['egressPolicy'],
) {
  const ledger = new BetaLedger(filename, tenant, { tasks: sdk.tasks });
  try {
    const endpoint = createBetaMcpServer({ ledger, origin,
      serverInfo: { name: 'byok-host', version: '1' },
      tools: createTaskTools({ sdk, ledger, egressPolicy, blobBaseUrl: sdkOrigin }) });
    return { ledger, fetch: endpoint.fetch,
      close() { endpoint.close(); ledger.close(); } };
  } catch (error) { ledger.close(); throw error; }
}
```

The Host supplies its SDK instance, trusted tenant, private file, public MCP origin,
the origin where it serves the SDK routes (`sdk.hono`), for artifact URLs, and the
Agent egress policy of task executions. Each task is a fresh Agent execution, so the
receiving daemon needs `agentHome` and `agentEgress: { policy }` configured to accept it.
It mounts `fetch` at the MCP endpoint behind its TLS termination. Use HTTPS for
remote clients and loopback HTTP locally. B1 owns framing, body limits, session
limits and the MCP protocol. The wrapper checks Origin before authentication.
It authenticates every POST, GET and DELETE, then selects a separate transport
from the verified key ID. A session header never selects a caller.

`ScopedTool` registrations contain a definition, an explicit scope policy and
a Host callback. Discovery can use the explicit `authenticated` policy. Omitting
the policy is invalid. Only authenticated caller handles reach that callback. The tool
list excludes denied scopes. A manual call still checks current ledger state.
Domain refusals use JSON text with `isError: true`, `code`, `message` and optional
`retryAfterSeconds`. `createTaskTools` returns the B3 registrations and
`createRoutineTools` the B4 registrations and `createMemoryTools` the B5
registration; pass the arrays the Host offers as `tools`. The B2 tests
register local protocol probes only to exercise this boundary.

## Keys and ownership

Use `ledger.issueKey` only from trusted in-process Host administration. It takes
a label, scopes, device IDs, runtimes, optional AgentRef and optional quota limits.
It returns `{ token, key }` once. Store the token in the external client's own
credential field. Do not log it. Only its salted SHA-256 digest is stored in the
ledger. The secret has 256 random bits. Authentication uses an indexed public
key ID and a fixed-length `timingSafeEqual` digest comparison. See the
[Node crypto contract](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b).

Missing, unknown, wrong and revoked keys receive the same HTTP 401. Safe key views
contain no secret, salt or digest. Key grants are immutable. Revoke and issue a
new key to change them. Rotation does not transfer old tasks to the new key.

Scopes are `tasks.dispatch`, `tasks.read`, `tasks.cancel`, `artifacts.read`,
`routines.read`, `routines.write`, `memory.read` and `memory.write`. Dispatch,
memory and routine grants require one AgentRef: `issueKey` refuses a
`tasks.dispatch` key without one, and every submitted task runs as that Agent.
A key without an AgentRef fails authentication with `invalid_input`. Wire v4
has fresh Agent executions only, so a `tasks.dispatch` key issued before it
without an AgentRef must be revoked and issued again with one. An Agent home
has one writer, so a device runs one task of a key at a time and declines a
second one while the first holds the home, even when the key's
`runningTasks` quota allows more.
Beta v1 has no memory-write tool (`byok_memory_propose` waits for beta plan §9 Q9
and PRD P5). `tasks.read`, `tasks.cancel` and `artifacts.read` need no AgentRef.

Caller objects are immutable, in-process authenticated handles. Rebuilding one
from JSON does not create authority. Ledger operations check the current key
again. A key owns only its admission references. `requireTask` and
`requireRoutine` give the same `not_found` refusal for foreign and absent IDs.
The Host must call these guards before reading SDK task results or artifact URLs.

`revokeKey` persists the revocation before it drops cached transports. An active
MCP wait can end, but revocation does not cancel an SDK task or release its slot.
Transport cleanup is best effort; current-state auth still refuses every later
request. No provider credential store or task-scoped helper is proxied here.

## Admission and retry

Call `lookupTask(caller, args)` before any async device selection. If no reservation
exists, select a device from trusted Host state, then call
`reserveTask(caller, args, deviceId)`. Its synchronous SQLite transaction checks
revocation and idempotency again before it checks device/runtime grants and quota.
It saves the identity and immutable binding before returning. It does not dispatch.

`instruction` is at most 32 KiB of UTF-8. `workspace` is an opaque registered ID,
not a raw path. B3 refuses it until the SDK can select a workspace. Unknown arguments,
lossy/non-finite JSON, cycles, accessors and excessive nesting are refused before
admission. Object keys have a deterministic order; array order stays significant.

- With `clientRequestId`, identity derives from tenant, key ID and that ID. IDs
  use 1–160 ASCII letters, digits, dot, underscore, colon or hyphen. Reusing one
  with changed arguments gives `idempotency_conflict`. Explicit IDs do not expire.
- Without it, reuse the first saved admission for the same argument hash during
  the 15 minutes after that admission. There is no UTC quarter-hour boundary.
  A deliberate rerun inside that interval needs a new `clientRequestId`.
- A retry preserves the first device and Agent context, even if the new device
  selection differs or the original device is offline. It consumes no new slot
  or hourly submit. The ledger's `deduplicated` means reservation reuse, not SDK
  dispatch success.

B3 must dispatch only with this saved binding. An SDK conflict requires full
offer readback against that binding. Never invent success from a missing receipt.
A reservation whose slot is already released is readback-only. Missing SDK data
must never cause that retired identity to be dispatched again.

`reserveRoutine` deduplicates on key ID and local ID. A changed definition
conflicts. It stores ownership and a quota slot, not a second routine scheduler.
Only trusted Host/K4 completion calls `releaseRoutineSlot`. B4 owns the routine
ledger, wake calls and occurrence dispatch.

## Quota and reconciliation

| Limit | Default | Refusal |
| --- | --- | --- |
| Occupied task slots | 4 | `quota_exceeded` |
| New task admissions per rolling hour | 60 | `quota_exceeded` |
| Occupied routine slots | 8 | `quota_exceeded` |
| Owned-task status reads per rolling minute | 120 | `rate_limited` |

Task slots include unresolved reservations and offered work. They prevent a
crash before dispatch from bypassing the running cap. `reconcileTask` releases
one only after the owning SDK supplies an exact device terminal and matching
task/device/runtime/instruction binding. The offered AgentRef must equal the
binding's; an offer without one never releases a slot. A missing task, Host cancellation or MCP cancellation does not free it.
This is a quota release check, not a substitute for B3's complete conflict readback.
Release never refunds the hourly admission. Status-rate events are pruned inside
their transaction. Running/routine retry hints are advisory, not a promised delay.

Time windows use trusted Host wall time and half-open intervals ending at `now`.
Clock corrections can change these abuse windows. There is no persisted future
clock and no billing promise. Occupied-slot limits do not depend on wall time.
The Host must use `consumeStatusRead` before each status query. Tool names do not
implicitly perform ledger operations. B3 wires the specific task handlers.

## Task tools (B3)

| Tool | Scope | Input | Result |
| --- | --- | --- | --- |
| `byok_whoami` | authenticated | `{}` | Key ID, label, scopes, runtimes, granted devices, quota limits and use now |
| `byok_runtimes` | `tasks.read` | `{}` | Per granted device: the key's runtimes, `installed` (`null` while presence is stale), version |
| `byok_task_submit` | `tasks.dispatch` | `{ runtime, instruction, toolsets?, clientRequestId? }` | `{ taskId, state, deduplicated }` |
| `byok_task_status` | `tasks.read` | `{ taskId, waitSeconds? }` (0–50) | `{ taskId, state, finalMessage?, document?, artifacts, reason?, code?, retryable? }` |
| `byok_task_cancel` | `tasks.cancel` | `{ taskId, reason? }` | `{ taskId, state }` |
| `byok_task_list` | `tasks.read` | `{ cursor?, limit? (1–50, default 20), state? }` | `{ tasks: [{ taskId, runtime, createdAt, state }], nextCursor? }` |
| `byok_artifact_url` | `artifacts.read` | `{ taskId, index }` | `{ taskId, index, url, contentType, size }` |

Each handler takes the caller from the authenticated key and reaches the SDK only
through that key's saved reservations. A foreign or unknown `taskId` gives `not_found`.

Submit follows the B2 contract. It calls `lookupTask` first, so a retry reuses the
saved binding and its device, even when that device is offline. For a new
admission it reconciles the key's open slots, selects a device and calls
`reserveTask`. Device selection keeps the key's device order and prefers a
device whose fresh presence reports the runtime. It then prefers an offline
device (the SDK queues the work) over an online device without the runtime. A
key with no registered granted device gets `unavailable` before admission.

Dispatch uses `sdk.executions.submit`: a fresh Agent execution with the saved task
ID, device, runtime, instruction and toolsets, the binding's AgentRef, the Host's
egress policy and terminal projection `none`. If an offer already exists, or the
submit fails, submit reads the offer back and accepts it only when it is a
`task.offer_for_agent_with_egress_fresh` whose device, AgentRef, runtime,
instruction and toolsets match the binding exactly. Otherwise the call fails, and a retry of the
same call dispatches again. A reservation whose slot is released only reads back.

Submit refuses these inputs before admission, so they use no quota:

- `toolsets` that the SDK would refuse: it takes 1–16 distinct lowercase IDs.

- `resultSchema`: task executions use terminal projection `none` and define no
  result contract. Routines do (B4).
- `workspace`: an Agent execution has no workspace selection. A Host workspace
  registry needs an SDK field first.

`state` is the SDK task state. Two ledger states exist when the SDK has no task:
`Reserved` (admitted, not dispatched; a retry of the same submit dispatches it)
and `Unknown` (slot released, SDK record gone). The list `state` filter accepts
these two as well. Cancel of a `Reserved` task changes nothing: a later retry of
the same submit still dispatches it. The tool description says so. Status waits only for a task in a
non-terminal SDK state. It reads the task every 500 ms until the state changes,
the wait ends or the MCP call is cancelled. MCP cancellation ends the wait only.

Status, cancel and list release a slot when they read an SDK terminal and
`reconcileTask` finds the exact device terminal. Submit and whoami reconcile the
key's open slots first. Host cancellation alone frees no slot; the device's
`task.cancelled` does. Cancel of a terminal task returns its state and sends nothing.

`artifacts` lists `TaskResult.artifactRefs` by index, with content type and size.
The SDK keeps no artifact name for a finished task, so there is none here. The
current daemon reports files as live `task.artifact` events and sets no
`artifactRefs` on `task.complete`; daemon tasks therefore list no artifacts.
`byok_artifact_url` resolves the SDK's signed blob path against `blobBaseUrl`.
That origin must be HTTPS, or HTTP on loopback, as for the MCP origin.
The URL expires with the SDK blob grant (15 minutes by default).

A dispatch that the SDK refuses before the task exists (for example, a device
without `toolset-selection`, or a daemon without `agentHome` and `agentEgress`) keeps its slot, as B2 requires for any missing SDK
task. Device selection does not read device capabilities, which `machines.list`
does not expose. To clear such slots, revoke the key and issue a new one.

## Routine tools (B4)

| Tool | Scope | Input | Result |
| --- | --- | --- | --- |
| `byok_routine_create` | `routines.write` | `{ localId, schedule, task: { runtime, instruction, toolsets?, resultSchema? } }` | `{ routineId, lifecycle, nextAt, deduplicated }` |
| `byok_routine_list` | `routines.read` | `{ cursor?, limit? (1–50, default 20) }` | `{ routines: [{ routineId, localId, createdAt, lifecycle, status?, nextAt, schedule?, runtime?, lastOccurrence? }], nextCursor? }` |
| `byok_routine_cancel` | `routines.write` | `{ routineId }` | `{ routineId, state: "completed" }` |

The routines run on the Host's own K4 `HostExecutionCore`. The Host creates that
core with `nextOccurrence: routineScheduleCalendar` and installs `core.consume` as
the SDK's `wake.consume`. It passes the core, its Agent egress policy, `waitMs`
(how long an occurrence may wait for its device) and `lateAfterMs` (the catch-up
threshold) to `createRoutineTools`. K4 is the only scheduler: it stores the
definition, the next one-shot wake `<routineId>:1:<t>`, every occurrence and its
outcome. The beta ledger stores only key ownership and the routine slot.

```ts
const core = new HostExecutionCore(sdk, hostLedger, { nextOccurrence: routineScheduleCalendar });
const tools = [...createTaskTools({ sdk, ledger, blobBaseUrl: sdkOrigin }),
  ...createRoutineTools({ sdk, ledger, core, egressPolicy, waitMs: 3_600_000, lateAfterMs: 300_000 })];
```

`schedule` is the SDK `RoutineSchedule`: `{ minute, hour, tz }` plus either
`daysOfWeek` or `dayOfMonth` (with optional `month`). `tz` is an IANA zone. The beta
plan's `{ cron, tz }` has no dialect in this repository; K4 and K8a both use this
shape and `nextRoutineOccurrence`. The calendar refuses any other rule.

Create refuses these inputs before admission, so they use no slot: an invalid
schedule (`checkRoutineSchedule`), a `clientRequestId` (an occurrence takes its
identity from `(routineId, version, t)`), a `workspace`, toolsets the SDK would
refuse, a `resultSchema` outside the SDK result subset, and a runtime the key may
not use. A key with no registered granted device gets `unavailable`.

Each occurrence is a fresh Agent execution of the key's AgentRef on the device
saved at creation. `toolsets` become `requiredToolsets`. A `resultSchema` becomes a
`result-document` projection with contract `byok-mcp-routine-v1`; without one the
projection is `none`. K4 runs one occurrence per Agent at a time and keeps only the
latest queued slot.

`localId` deduplicates: the same arguments return the same routine with
`deduplicated: true`, and other arguments give `idempotency_conflict`. A routine
never changes. To change one, cancel it and create one with a new `localId`. A
retry of a cancelled routine's create returns `completed` and schedules nothing.

`lifecycle` is K4's `active` or `completed`. Two ledger states exist when K4 has no
routine: `reserved` (admitted, K4 did not commit; a retry of the same create
schedules it) and `completed` (cancelled before K4 committed). `nextAt` is K4's next
wake time, or `null`. `lastOccurrence` is the newest occurrence: `plannedAt`,
`trigger` (`scheduled` or `catch_up`), `taskId`, `attempts`, K4's `conclusion` once
settled, and the result `document` when it succeeded. These task IDs are not
`byok_task_*` tasks: `byok_task_status` answers `not_found` for them.

Cancel sets K4's lifecycle to `completed`. No new occurrence starts; one that
already started finishes, and list then shows its outcome. Then the slot is
released. K4 completion is the only release authority: list also releases a
completed routine whose release was lost. Paused routines and same-ID versions
(K8a `update_routine`) are not part of the beta.

Revocation stops a key's routines. A future occurrence would be a new call for a
revoked key, so `createRoutineTools` completes that key's routines on K4 from the
ledger's revocation listener, as cancel does. An occurrence that already started
finishes, as a running task does. Call `retireRevokedRoutines(ledger, core)` at
Host startup, after `core.recover()`, to finish a retirement that a crash or a
listener failure interrupted.

## Memory tool (B5)

| Tool | Scope | Input | Result |
| --- | --- | --- | --- |
| `byok_memory_read` | `memory.read` | `{ path? }` (only `MEMORY.md`, the default) | `{ path, text, revision?, projectedAt? }` |

The tool reads byok's own Agent-home memory for the key's AgentRef. It is not
the external Bot's own memory, and its description says so in its first sentence.
It is read-only. There is no `byok_memory_propose`.

The Host passes its K4 `HostMemoryPage` and a `placement` callback:

```ts
const page = new HostMemoryPage(hostLedger, { isCurrent, notify, authorizeProjection });
const tools = [...createTaskTools({ sdk, ledger, blobBaseUrl: sdkOrigin }),
  ...createMemoryTools({ ledger, memory: page, placement: agentRef => currentDevice(agentRef) })];
```

The page receives the device's redacted `agent.memory.projection` mutations
through `projectionPort(deviceId)`. Its `contextPack` is the only read: the tool
keeps no copy of memory text and does not read the K4 ledger directly.
`placement` names the device that holds the Agent's home now. It must come from
the same trusted Host state as the page's `isCurrent`. The tool never takes an
Agent or a device from arguments.

- `text` is the redacted resident memory in K4's profile
  `{ residentMemory: string | null }`. The device's Host-owned redactor decides it.
- `revision` is the projection's `mutationId`, and `projectedAt` is when the Host
  accepted it. The revision names a projection, not a file. The projection
  contract carries no source revision, so it cannot be a compare-and-swap base.
- `text` is `null` with no `revision` when the page holds no current projection:
  none yet, a projection whose policy shows no resident memory, or an applied
  `MEMORY.md` write whose refreshed projection has not arrived. Stale text never
  comes back.
- `path` accepts only `MEMORY.md`. K4's profile carries no `notes/` files, so a
  `notes/**` path is `invalid_input`. Serving notes needs a Host redactor profile
  that carries them; that is not part of this beta.

Refusals: no current placement gives `unavailable` (retry hint 60 s). A placement
on a device that the key does not grant gives `forbidden`. When the page refuses
the read (placement or Agent profile changed, projection grant revoked, or
`MEMORY.md` over K4's 8 KiB resident limit), the tool gives one fixed
`unavailable` message for the Host owner. A changed Agent profile needs a new key
with the new AgentRef. Memory reads have no quota counter; the beta plan sets none.
Every result enters the external Bot vendor's storage (beta plan §9 Q10); only
redacted text that the Host policy projected leaves.

## Storage boundary

Choose a dedicated private directory and regular SQLite file. POSIX directories
must be owner-only, and files must be owner-only. On Windows the Host must set
the directory and file ACL; this example does not prove Windows ACL protection.
Do not place this file in the SDK database or an Agent home.

One Host process owns the file with SQLite exclusive locking. The metadata fixes
one tenant and schema version. A second owner, another tenant or an unknown schema
fails closed. Key administration stays in that process. There is no CLI writer,
busy timeout, retry loop, added timer or compatibility migration. Transactions
contain no async operation. SQLite uses WAL and FULL synchronous writes.

Pending task bindings can contain private instruction text. The ledger stores
no second task result or artifact body. Explicit IDs and ownership rows remain
for replay safety. Each canonical binding is bounded to 4 MiB. At the default
60 admissions per hour, the maximum binding growth rate is 240 MiB per hour,
or 5.625 GiB per sustained day, before SQLite and WAL overhead. Choose storage
and backup controls appropriate for this Host. Closing the HTTP wrapper before the
ledger releases transport resources; ledger close does not abandon reservations.

## Evidence and checks

The [B2 plan](../../docs/plans/2026-10-19-byok-mcp-beta-b2.md) records P1/P2/P3.
Tests use actual temporary SQLite files, the standard MCP HTTP client over local
sockets, and the SDK's device simulator against the real embedded coordinator.
They do not claim vendor runtime execution or require a paid model/account.
All new tests use the repository's existing default time limits.

The SDK reconciliation tests prove that a pre-dispatch reservation stays occupied
when no SDK row exists, that Host cancellation alone cannot release it, and that
key revocation leaves an SDK task Running until an authenticated device terminal arrives.

### Verification record: 2026-10-19

Node `v24.21.0`, Bun `1.4.3`, macOS arm64. The final build completed before
typecheck and the complete root test run. No production code changed after it.

| Command from the repository root | Result |
| --- | --- |
| `bun run build` | Exit 0. |
| `bun run typecheck` | Exit 0. |
| `bun run test` | Exit 0. 9,721 Vitest tests passed; 237 skipped. All 10 Node tests passed. |
| `bun run check:api-surface` | Exit 0 in check mode. All 9 package goldens match. |
| `bun run check:version-authority` | Exit 0. |
| `bun run --cwd examples/byok-mcp-server test` | Exit 0. 22 tests passed in 3 files. |

Read-only Claude Opus security and test-integrity review, round 2: PASS. The final
root test condition is met. No existing test file or assertion changed. No test
or runtime timeout was added or increased. The optional Docker/Postgres substrate
was not started. Skipped cases are not verified cases.

### B3 verification record: 2026-10-20

The [B3 plan](../../docs/plans/2026-10-20-byok-mcp-beta-b3.md) records P1/P2/P3.
B3 tests drive the tools with the standard MCP HTTP client over a loopback socket.
`tools.test.ts` uses the real device daemon from `@byok-sdk/client`, paired to the
embedded server, with a scripted `RuntimeAdapter` defined in this example. It covers
submit, retry, status long poll, the outcome, slot release, list, cancel and the
pre-admission refusals. `tools-artifacts.test.ts` uses the testkit device simulator
for a terminal with `artifactRefs` (the download is fetched and compared), list
paging, toolset offers and a dispatch that the SDK refuses. No paid model or account
is used. Mutation checks: removing the status slot release, reversing the list order,
forcing the offer type and weakening the toolset check each made a test fail.

Node `v24.21.0`, Bun `1.4.3`, macOS arm64. The commands ran on the final source.

| Command from the repository root | Result |
| --- | --- |
| `bun run build` | Exit 0. |
| `bun run typecheck` | Exit 0. |
| `bun run test` | Exit 0. 9,993 Vitest tests passed; 245 skipped. All 10 Node tests passed. |
| `bun run check:api-surface` | Exit 0 in check mode. All 9 package goldens match. |
| `bun run check:version-authority` | Exit 0. |
| `bun run --cwd examples/byok-mcp-server test` | Exit 0. 29 tests passed in 5 files (three runs). |

Read-only Claude Opus security and test-integrity review, round 2: PASS. No existing
test file or assertion changed. No test or runtime timeout was added or increased.
Not tested: an MCP cancellation that ends a status wait early (the wait loop checks
the call signal).

### B4 verification record: 2026-10-20

The [B4 plan](../../docs/plans/2026-10-20-byok-mcp-beta-b4.md) records P1/P2/P3.
`routines.test.ts` uses K4's test Host: the embedded server, the real device daemon
with Agent homes and egress, and the stub Pi runtime that calls the real
`submit_result` helper. The beta endpoint runs on a loopback origin with the
standard MCP HTTP client. Only `Date` is mocked, as in K4's routine tests. The tests
cover create, retry and conflict, the one-shot wake, two due occurrences and their
outcomes, cancel during a run, pre-admission refusals, the routine cap, foreign IDs,
a failure before the K4 commit, a cancel that races a retry, a lost slot release,
and revocation with startup retirement. Two failures are injected with spies: a
rejected `addRoutine` or `lifecycle` call before K4 commits, and a throwing slot
release. No paid model or account is used. Mutation checks: dropping the released-slot
guard, the reservation reread, the runtime grant check, the tz check, the outcome
document, the newest-occurrence order, the list release, the revocation listener or
the cancel readback each made a test fail.

Node `v24.18.0`, Bun `1.4.3`, macOS arm64, `TMPDIR` set to a fresh short directory.
The commands ran on the final source.

| Command from the repository root | Result |
| --- | --- |
| `bun run build` | Exit 0. |
| `bun run typecheck` | Exit 0. |
| `bun run test` | Exit 0. 10,001 Vitest tests passed; 243 skipped. All 10 Node tests passed. |
| `bun run check:api-surface` | Exit 0 in check mode. All 9 package goldens match. |
| `bun run check:version-authority` | Exit 0. |
| `bun run --cwd examples/byok-mcp-server test` | Exit 0. 35 tests passed in 6 files (three runs). |

No existing assertion changed. One test was added to `ledger.test.ts`. No test or
runtime timeout was added or increased. B3 helpers (`json`, `input`, `integer`,
`selectDevice`) moved to module scope for reuse, with no behavior change.
Not tested: a Host that injects another K4 calendar, and a device without Agent-home support.

### B5 verification record: 2026-10-20

The [B5 plan](../../docs/plans/2026-10-20-byok-mcp-beta-b5.md) records P1/P2/P3.
`memory.test.ts` runs K4's `HostMemoryPage` on a temporary SQLite ledger and the beta
endpoint on a loopback origin with the standard MCP HTTP client. The device side is
synthetic: redacted mutations go through the page's own `projectionPort`, and one
MEMORY.md write goes through the page's intent transport. The tests cover the read,
newer and null projections, stale hiding after an applied write and its refresh,
per-key Agent isolation, bad input, missing and ungranted placement, a changed
profile, a revoked projection grant, the 8 KiB limit, scope filtering and revocation.
No runtime, paid model or account is used. Mutation checks: dropping the device
grant check, the path check or the Host placement, or returning another revision,
each made a test fail.

Node `v24.18.0`, Bun `1.4.3`, macOS arm64, `TMPDIR` set to a fresh short directory.
The commands ran on the final source.

| Command from the repository root | Result |
| --- | --- |
| `bun run build` | Exit 0. |
| `bun run typecheck` | Exit 0. |
| `bun run test` | Exit 1. `@byok-sdk/client`: 4,184 passed, 67 skipped, 2 failed (`mcp-server-http.test.ts` "isolates equal request IDs and cancellation", `task-runner-cancel-native.test.ts` 10 s timeout). This slice changes no file under `packages/`. In isolation the native test passed and the HTTP test failed in 2 of 3 runs; it is a pre-existing flake, reported, not changed. |
| `bun run check:api-surface` | Exit 0 in check mode. All 9 package goldens match. |
| `bun run check:version-authority` | Exit 0. |
| `bun run --cwd examples/byok-mcp-server test` | Exit 0. 39 tests passed in 7 files. |

No existing test file or assertion changed. No test or runtime timeout was added
or increased. Not tested: the real-device projection path (it needs the secure
memory filesystem) and a Host redactor.
