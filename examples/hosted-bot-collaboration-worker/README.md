# Hosted Bot collaboration on Workers (H, D3)

Private example for #794 (#606 D3). It composes the hosted (H) Host of `examples/hosted-bot-collaboration` (D2) as one
Cloudflare Worker and runs it on local workerd (`wrangler dev`). It changes no H code.

Do not use this example as a deployed Host. It has never run on Cloudflare: see Evidence.

## Composition

`src/worker.ts` composes the whole Host for each invocation (a request or a clock alarm) and ends it before the
invocation is done:

- two new pools over the Hyperdrive binding `BYOK_PG`: the SDK pool from `createByokPool` (its int8 parser, `max: 3`),
  and the H store's own `pg.Pool` (`max: 2`), as the H README asks. Together they stay below the connections that one
  Worker invocation may hold open at once;
- `createPostgresCoreStores` and `createPostgresCloudStores` from `@byok-sdk/cloud-dataplane/runtime`, and
  `createByokCloud` with H's message consumer and a new in-process mailbox wake with a 1 s fallback;
- `HostedCollaborationStore` and its passes: the routine scheduler (`start()` and `run()`), the reconciler, the composed
  sync of each changed scope (reply checker, device observer, `store.sync`), the due scheduler and the submitter, then
  the composed sync of each scope where the submitter concluded an intent with no SDK call (its `changed` option: the
  queued expiry, or a sealed row with no sealed lane), so that Turn settles in the same pass. The task port has both
  lanes: `submit` is `submitAgentExecution`, and `submitSealed` is `submitSealedAgentExecution`.

A device response keeps its invocation's pools open until its body ends or is cancelled (`src/body-lifetime.ts`): the
board SSE stream keeps querying after `cloud.fetch` returns its headers.

Module scope holds no mutable state. Postgres is the only memory between invocations: no `LISTEN`, no timer that
outlives an invocation, no session map.

- The Host passes run from the clock and from `POST /host/passes`. Both call the same function. The cron trigger runs no
  pass: it only arms the clock.
- The clock is one Durable Object for the deployment, `HostClock` (`idFromName('deployment')`). Its `alarm()` first sets
  the next alarm `H_CLOCK_MS` later (10 s by default, 15 s at most), then runs one pass in its own composition. A failed
  pass is logged, not thrown; `alarm()` throws only when `H_CLOCK_MS` or `H_FAULT` is invalid, before it sets the next
  alarm. The alarm keeps no Host state, only its next time, so a lost, repeated or cut-off alarm is made up by the next
  one, which rereads Postgres. The cron trigger (`* * * * *`) asks the clock to arm itself if it has no alarm, so a new
  deployment starts its clock, and a clock whose alarm is gone starts again, within a minute and with no request.
- A notification only schedules one more pass with `ctx.waitUntil`. A notification is an SDK observer call after a device
  commit, or a product command. That pass rereads Postgres. A lost notification delays work to the next pass, and a
  repeated one changes nothing.
- `HostedRoutineScheduler.start()` is K4 `recover`. It reads the routine rows, so it runs on every pass: a Worker has no
  process start. The scheduler gets `H_CLOCK_MS` as its `intervalMs`, so H's own check against the K8 late bound runs.

Node migrates and provisions; the Worker serves. The SDK migrations, the H DDL and the `host_scope` table are created
from Node before `wrangler dev` starts. The Worker never migrates.

### Routes

| Route | Caller | What it does |
| --- | --- | --- |
| `/byok/*` | device | the SDK device surface (`cloud.fetch`) |
| `POST /host/input` | owner, with the session bearer | `HostedCommandEntry.input`: authenticate, commit, sync |
| `POST /host/sealed-routine` | owner, with the session bearer | `HostedCommandEntry.createSealedRoutine`: the member endpoint's sealed routine (#953) |
| `POST /host/sealed-routine/reseal` | owner, with the session bearer | `HostedCommandEntry.resealRoutine`: the next version of a sealed routine, after its Bot's Agent changed (#953) |
| `POST /host/passes` | operator bearer | one Host pass; returns its report |
| `POST /host/pairing-code` | operator bearer | `cloud.createPairingCode` for a provisioned scope |
| `POST /host/board-item` | operator bearer | `cloud.createBoardItem`: the Host's own board write |
| `HostClock` alarm | Cloudflare | the same pass as `/host/passes`, every `H_CLOCK_MS` |
| cron `* * * * *` | Cloudflare | arms `HostClock` if it has no alarm; runs no pass |

### Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `BYOK_PG` | Hyperdrive binding | the database of the SDK, H and `host_scope` schemas |
| `HOST_CLOCK` | Durable Object binding | the namespace of `HostClock` (SQLite-backed class, migration `v1`) |
| `H_SCHEMA`, `HOST_SCHEMA` | var | the H store's schema; the schema of `host_scope` |
| `BYOK_TOKEN_SECRET` | secret | lowercase hex HMAC key of the SDK token signer |
| `HOST_ADMIN_TOKEN` | secret | the operator bearer |
| `BYOK_S3_ENDPOINT`, `BYOK_S3_BUCKET`, `BYOK_S3_ACCESS_KEY_ID`, `BYOK_S3_SECRET_ACCESS_KEY`, `BYOK_S3_REGION` | var, secret | the S3 API of the object store (R2's S3 endpoint in a deployment) |
| `H_SUBMIT_LEASE_MS`, `H_RECONCILE_POLL_MS` | var, optional | the submitter lease and the reconciler's wait between readbacks |
| `H_CLOCK_MS` | var, optional | the clock's alarm interval, from 1 to 15 000 ms; 10 000 when unset |
| `H_COALESCE_WINDOW_MS` | var, optional | input coalescing (the H store's `coalesce` option) with this window and the K8 defaults; off when unset |
| `H_FAULT` | var, tests only | a comma-separated list of `drop-notify`, `duplicate-notify`, `drop-alarm`, `duplicate-alarm`, `hang-after-submit`, `hang-after-terminal-read`, `hang-after-consume` |

One scope is one SDK tenant, and the scope string is the tenant id. `host_scope` holds each scope's owner session hash,
owner principal and H Host config. It stands in for a product's own user and device tables.

## Tests

The suites need the substrate of `docker-compose.test.yml` and an opt-in, because they start `wrangler dev`:

```sh
docker compose -f docker-compose.test.yml up -d --wait
export BYOK_TEST_WORKER_DATAPLANE=1
export BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test
export BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test
```

Without the opt-in they skip. CI's `dataplane` job sets `BYOK_REQUIRE_WORKER_DATAPLANE=1`, which turns an unmet gate into
a failure (`src/ci.test.ts` pins that step). Each run has its own Postgres role and schemas, and drops them.

- `worker.test.ts`: one owner Turn through the command entry, a pass, a device process and a pass, with one offer row and
  one command record; a request with no valid owner session writes nothing; a board row written after
  `/byok/board/stream` returned its headers arrives as `event: board` (the stream keeps its pools); requests do not
  arm the clock, the cron trigger does, and then its alarm runs passes. `body-lifetime.test.ts` checks the release on
  body end, error and cancel.
- `clock.test.ts` (H4): each test arms the clock once through the cron route, then reaches its subject with notifications
  dropped and no `/host/passes` call, so only an alarm pass can do the work. A
  routine slot fires as `scheduled` within the K8 late bound and its Turn is offered; a duplicate alarm (two passes at
  once) records one occurrence and makes one offer; an instance lost mid-alarm after the routine Turn's submit leaves one
  occurrence and one offer, and the next instance's stored alarm reads the offer back; a coalesced input batch seals with
  reason `window` within a minute of its seal time; dropped alarms leave a due batch open, and the next alarm seals it.
- `sealed.test.ts` (#953): an owner creates a sealed routine through `/host/sealed-routine`, and its occurrence goes to
  `submitSealedAgentExecution`, not `submit`. The device has no E2EE member keyring, so the SDK refuses the sealed offer
  before its mailbox append (`sealed-payload-v1`), and no mailbox row is written. Also an untried intent that reaches
  its wait time ends `expired` in the submitter, and its Turn ends in the same pass. A reseal through
  `/host/sealed-routine/reseal` with no open occurrence replaces version 1 with version 2 at once. A request with no
  session or an unknown one gets 401, and another scope's owner acts only in its own scope; neither writes anything here.
- `faults.test.ts`: a lost notification (the alarm passes find the work); a duplicate notification (one submit, one
  outcome); an instance destroyed after the SDK accepted a submit (the next instance reads the offer back and submits
  nothing new); an instance destroyed after it read a device terminal (the next one applies the outcome once); a scope
  whose sync throws is retried on every pass while the other scopes go on.
- `two-devices.test.ts`: two device processes, each with its own pairing, store dir and Agent home. Bot A on device 1
  delegates to Bot B on device 2; B's reply answers the delegation; A's report Turn runs on device 1. Each Turn runs once
  on its Bot's device, with one outcome and one reply record. Also an instance destroyed after the consumer committed a
  reply: the decision and its record stay.

A kill is SIGKILL to wrangler and workerd with no grace, so nothing in the Worker runs after it. A restart of the same
scope keeps the local storage dir (`--persist-to`), so the clock keeps its alarm, as Durable Object storage does on
Cloudflare: local workerd fires a stored alarm after a restart with no request. The device processes
(`src/device.child.ts`) run the K8 stub adapter as a synthetic runtime. Their machine identities are synthetic.

## Evidence

Results are given per row and never merged into one PASS. `VALIDATION.md` of `examples/bot-collaboration` is not changed
here; its two rows stay OPEN.

Each row's result is recorded in its PR, with the commit and the CI run.

| Row | Evidence here | What it still needs |
| --- | --- | --- |
| Node H (D2) | `examples/hosted-bot-collaboration` on Node and Postgres (D2's suites) | none from this lane |
| Worker H, local workerd | `worker.test.ts`, `faults.test.ts`, `clock.test.ts`, `sealed.test.ts` on wrangler 4.123.0 (workerd 1.20260811.1), Postgres 17, the compose S3 endpoint | a deployment: real Hyperdrive (transaction pooling, the connection limit per invocation), R2 over its S3 endpoint, Durable Object alarms on Cloudflare (at-least-once delivery, retries, placement), cron on Cloudflare (the clock's start and recovery path), isolate eviction by Cloudflare, and a sealed routine run on a device with the hosted E2EE member setup |
| Two device processes, one Host | `two-devices.test.ts`, synthetic runtime, one computer | two physical computers (macOS and Windows), each with its own OS user and network path |
| Real runtime delegation and reply | none: no paid runtime call is approved | one A -> B -> A chain with real runtimes, each call approved by the maintainer, recorded apart from the synthetic results |

### For `examples/bot-collaboration/VALIDATION.md`

Proposed text for lane K8 or the coordinator to apply. The status stays OPEN:

- "Two Topology L Host processes": the D3 lane ran two device processes against one H Host on local workerd
  (`examples/hosted-bot-collaboration-worker/src/two-devices.test.ts`). That is the H topology with a synthetic runtime;
  it is not evidence for two L Host processes, which stay out of the first release (#606 O4).
- "Two physical computers": still needs the same scenario on a macOS and a Windows computer against a deployed H Host,
  then one chain with real runtimes. Two processes on one computer with synthetic machine identities do not prove it.

## Limits

- Local Hyperdrive is a direct connection, so these runs cannot show a transaction-pooling fault. The H store was checked
  by reading it: every statement runs in `inSchema` (`BEGIN`, `SET LOCAL search_path`, `COMMIT`), `migrate()` uses
  `pg_advisory_xact_lock`, and there is no `LISTEN`, session `SET`, named prepared statement or temp table.
- R2: the SDK object path is the S3 API (`R2CloudBlobStore`, presigned URLs that the device uploads to). Miniflare's R2
  is a binding with no S3 endpoint, so the tests use the compose S3 endpoint, as `packages/cloud-dataplane/worker-smoke/`
  does. No scenario here stores an object.
- A failing scope or routine waits out H's backoff (`scope.retry_at`, `routine.retry_at`), which every invocation reads
  from Postgres. The Worker uses H's default of 60 s; `faults.test.ts` shows that the next pass does not retry a failed
  scope. H's own tests cover the retry after the wait.
- One clock for the whole deployment. Each alarm pass reads every scope's due rows: at most 100 routine fires and 100 due
  syncs a pass, so about 10 of each a second at the default 10 s. A slot or due step is late by up to `H_CLOCK_MS` plus
  the time of the pass before it. At 10x scopes the pass grows (the `host_scope` read below, the due scan, one sync per
  due scope), so lateness climbs toward the K8 late bound (60 s), past which a slot fires as `catch_up` with an
  occurrence key that differs from L's. Requests never reach the clock object: only the alarm and the once-a-minute
  arm-only cron do, so an alarm that is gone is replaced within a minute, with or without traffic. The next step is an
  alarm per scope: each scope's object sets its alarm to its own next due time and passes only its own rows.
- H's `host(scope)` is synchronous, so each invocation reads every `host_scope` row before it runs. At 10x scopes that
  read grows with them; a per-pass read of only the due scopes needs an H change.
- The H bundle pulls `node:sqlite` and `node:http` through the K4 index. workerd loads them today, and H never calls
  them.
