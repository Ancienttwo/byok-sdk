# Hosted Bot collaboration on Workers (H, D3)

Private example for #794 (#606 D3). It composes the hosted (H) Host of `examples/hosted-bot-collaboration` (D2) as one
Cloudflare Worker and runs it on local workerd (`wrangler dev`). It changes no H code.

Do not use this example as a deployed Host. It has never run on Cloudflare: see Evidence.

## Composition

`src/worker.ts` composes the whole Host for each invocation (a request or a `scheduled` event) and ends it before the
invocation is done:

- two new pools over the Hyperdrive binding `BYOK_PG`: the SDK pool from `createByokPool` (its int8 parser, `max: 3`),
  and the H store's own `pg.Pool` (`max: 2`), as the H README asks. Together they stay below the connections that one
  Worker invocation may hold open at once;
- `createPostgresCoreStores` and `createPostgresCloudStores` from `@byok-sdk/cloud-dataplane/runtime`, and
  `createByokCloud` with H's message consumer and a new in-process mailbox wake with a 1 s fallback;
- `HostedCollaborationStore` and its passes: the routine scheduler (`start()` and `run()`), the reconciler, the composed
  sync of each changed scope (reply checker, device observer, `store.sync`), the due scheduler and the submitter.

A device response keeps its invocation's pools open until its body ends or is cancelled (`src/body-lifetime.ts`): the
board SSE stream keeps querying after `cloud.fetch` returns its headers.

Module scope holds no mutable state. Postgres is the only memory between invocations: no `LISTEN`, no timer that
outlives an invocation, no session map.

- The Host passes run from the cron trigger (`scheduled`) and from `POST /host/passes`. Both call the same function.
- A notification only schedules one more pass with `ctx.waitUntil`. A notification is an SDK observer call after a device
  commit, or a product command. That pass rereads Postgres. A lost notification delays work to the next pass, and a
  repeated one changes nothing.
- `HostedRoutineScheduler.start()` is K4 `recover`. It reads the routine rows, so it runs on every pass: a Worker has no
  process start.

Node migrates and provisions; the Worker serves. The SDK migrations, the H DDL and the `host_scope` table are created
from Node before `wrangler dev` starts. The Worker never migrates.

### Routes

| Route | Caller | What it does |
| --- | --- | --- |
| `/byok/*` | device | the SDK device surface (`cloud.fetch`) |
| `POST /host/input` | owner, with the session bearer | `HostedCommandEntry.input`: authenticate, commit, sync |
| `POST /host/passes` | operator bearer | one Host pass; returns its report |
| `POST /host/pairing-code` | operator bearer | `cloud.createPairingCode` for a provisioned scope |
| `POST /host/board-item` | operator bearer | `cloud.createBoardItem`: the Host's own board write |
| cron `* * * * *` | Cloudflare | the same pass as `/host/passes` |

### Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `BYOK_PG` | Hyperdrive binding | the database of the SDK, H and `host_scope` schemas |
| `H_SCHEMA`, `HOST_SCHEMA` | var | the H store's schema; the schema of `host_scope` |
| `BYOK_TOKEN_SECRET` | secret | lowercase hex HMAC key of the SDK token signer |
| `HOST_ADMIN_TOKEN` | secret | the operator bearer |
| `BYOK_S3_ENDPOINT`, `BYOK_S3_BUCKET`, `BYOK_S3_ACCESS_KEY_ID`, `BYOK_S3_SECRET_ACCESS_KEY`, `BYOK_S3_REGION` | var, secret | the S3 API of the object store (R2's S3 endpoint in a deployment) |
| `H_SUBMIT_LEASE_MS`, `H_RECONCILE_POLL_MS` | var, optional | the submitter lease and the reconciler's wait between readbacks |
| `H_FAULT` | var, tests only | one fault of `drop-notify`, `duplicate-notify`, `hang-after-submit`, `hang-after-terminal-read`, `hang-after-consume` |

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
  `/byok/board/stream` returned its headers arrives as `event: board` (the stream keeps its pools); the cron route runs
  the `scheduled` handler. `body-lifetime.test.ts` checks the release on body end, error and cancel.
- `faults.test.ts`: a lost notification (the next cron pass finds the work); a duplicate notification (one submit, one
  outcome); an instance destroyed after the SDK accepted a submit (the next instance reads the offer back and submits
  nothing new); an instance destroyed after it read a device terminal (the next one applies the outcome once); a scope
  whose sync throws is retried on every pass while the other scopes go on.
- `two-devices.test.ts`: two device processes, each with its own pairing, store dir and Agent home. Bot A on device 1
  delegates to Bot B on device 2; B's reply answers the delegation; A's report Turn runs on device 1. Each Turn runs once
  on its Bot's device, with one outcome and one reply record. Also an instance destroyed after the consumer committed a
  reply: the decision and its record stay.

A kill is SIGKILL to wrangler and workerd with no grace, so nothing in the Worker runs after it. The device processes
(`src/device.child.ts`) run the K8 stub adapter as a synthetic runtime. Their machine identities are synthetic.

## Evidence

Results are given per row and never merged into one PASS. `VALIDATION.md` of `examples/bot-collaboration` is not changed
here; its two rows stay OPEN.

Each row's result is recorded in its PR, with the commit and the CI run.

| Row | Evidence here | What it still needs |
| --- | --- | --- |
| Node H (D2) | `examples/hosted-bot-collaboration` on Node and Postgres (D2's suites) | none from this lane |
| Worker H, local workerd | `worker.test.ts`, `faults.test.ts` on wrangler 4.123.0 (workerd 1.20260811.1), Postgres 17, the compose S3 endpoint | a deployment: real Hyperdrive (transaction pooling, the connection limit per invocation), R2 over its S3 endpoint, cron on Cloudflare, isolate eviction by Cloudflare, and a routine driver below 60 s (Limits) |
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
- H keeps the due scheduler's and the routine scheduler's backoff in memory. Each invocation starts with an empty map, so
  a failing scope or routine is retried on every pass (`faults.test.ts` shows it). Correctness does not depend on it;
  load does. A durable backoff is an H change.
- Routine timing is not met on a cron trigger. H's routine scheduler must run more often than the K8 late bound
  (`ROUTINE_LATE_AFTER_MS`, 60 s), or every slot fires as `catch_up` with an occurrence key that differs from L's. A
  Cloudflare cron fires at most once a minute, and a notification does not come from a slot's time. The due steps (batch
  seals, card expiries, reply checks) run up to a minute late for the same reason. A sub-minute driver, for example a
  Durable Object alarm, is a design choice that this example does not make. No test here runs a routine.
- H's `host(scope)` is synchronous, so each invocation reads every `host_scope` row before it runs. At 10x scopes that
  read grows with them; a per-pass read of only the due scopes needs an H change.
- The H bundle pulls `node:sqlite` and `node:http` through the K4 index. workerd loads them today, and H never calls
  them.
