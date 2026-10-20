# External-Bot MCP beta: B2 and B3

This private, copy-and-own example supplies the Host authorization and admission
ledger (B2) and the task tool catalogue (B3) from
[the beta plan](../../docs/plans/2026-10-19-byok-mcp-server-external-bot-beta.md).
It reuses the public B1 HTTP transport and the public `@byok-sdk/server` API.
It adds no public SDK API or new SDK runtime dependency.
Routines and memory tools belong to B4/B5.
There is no listener, admin HTTP route, default key or model invocation here.

## Host composition

```ts
import type { ByokServer } from '@byok-sdk/server';
import { BetaLedger, createBetaMcpServer, createTaskTools } from './src/index';

export function composeBeta(
  sdk: ByokServer,
  filename: string,
  tenant: string,
  origin: string,
  sdkOrigin: string,
) {
  const ledger = new BetaLedger(filename, tenant, { tasks: sdk.tasks });
  try {
    const endpoint = createBetaMcpServer({ ledger, origin,
      serverInfo: { name: 'byok-host', version: '1' },
      tools: createTaskTools({ sdk, ledger, blobBaseUrl: sdkOrigin }) });
    return { ledger, fetch: endpoint.fetch,
      close() { endpoint.close(); ledger.close(); } };
  } catch (error) { ledger.close(); throw error; }
}
```

The Host supplies its SDK instance, trusted tenant, private file, public MCP origin
and the origin where it serves the SDK routes (`sdk.hono`), for artifact URLs.
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
`retryAfterSeconds`. `createTaskTools` returns the B3 registrations. The B2 tests
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
`routines.read`, `routines.write`, `memory.read` and `memory.write`. Memory and
routine grants require one AgentRef. Beta v1 has no memory-write tool. Task-only
keys need no AgentRef. A saved AgentRef records the key's context; it does not
force the Host to turn an ordinary coding task into an Agent execution.

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
task/device/runtime/instruction binding. An offered AgentRef must match the key
context. A missing task, Host cancellation or MCP cancellation does not free it.
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

Dispatch uses `sdk.dispatch` with the saved task ID, device, runtime, instruction
and toolsets. If an offer already exists, or dispatch fails, submit reads the
offer back and accepts it only when type, device, runtime, instruction and
toolsets match the binding exactly. Otherwise the call fails, and a retry of the
same call dispatches again. A reservation whose slot is released only reads back.

Submit refuses these inputs before admission, so they use no quota:

- `toolsets` that the SDK would refuse: it takes 1–16 distinct lowercase IDs.

- `resultSchema`: the SDK carries a terminal projection only on Agent-bound
  offers. Plain `dispatch` and the `task.offer` wire message have no field for it.
- `workspace`: `DispatchInput` has no workspace selection, and the daemon ignores
  the wire `workspaceHint`. A Host workspace registry needs an SDK field first.

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
without `toolset-selection`) keeps its slot, as B2 requires for any missing SDK
task. Device selection does not read device capabilities, which `machines.list`
does not expose. To clear such slots, revoke the key and issue a new one.

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
