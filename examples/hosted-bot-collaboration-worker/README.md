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
- `HostedCollaborationStore` and one `HostedPasses`, which runs the routine scheduler (`start()` and `run()`), the reconciler,
  the composed sync of each changed scope (reply checker, device observer, `store.sync`), the due scheduler and the
  submitter, then the composed sync of each scope where the submitter concluded an intent with no SDK call (the queued
  expiry, or a sealed row with no sealed lane), so that Turn settles in the same pass. The task port has both lanes:
  `submit` is `submitAgentExecution`, and `submitSealed` is `submitSealedAgentExecution`.

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
- Each `HostedPasses` pass also runs the outbox sender, after the submitter, and then syncs the scopes that the sender changed. It
  delivers projection rows to the `host_projection` table (deduplicated by `(scope, id)`) and runs the Agent home
  operations through the SDK, so a Bot becomes ready and its next Turn can freeze. The Worker wires no channel and no
  connector: a card row or a delivery row is listed in `send.failed` (`The Host has no connector for a card call`, `The
  Host has no channel for a delivery`) and retried after the sender's `backoffMs`. A pass sends at most 100 rows.
- `HostedRoutineScheduler.start()` is K4 `recover`. It reads the routine rows, so it runs on every pass: a Worker has no
  process start. The scheduler gets `H_CLOCK_MS` as its `intervalMs`, so H's own check against the K8 late bound runs.

Node migrates and provisions; the Worker serves. The SDK migrations, the H DDL, the `host_scope` table and the `host_projection` table (`hostProjectionDdl`) are created
from Node before `wrangler dev` starts. The Worker never migrates. See [Operator provisioning](#operator-provisioning)
for the scope and tenant rows used by the deployed Host.

## Operator provisioning

Build the workspace and apply the SDK migrations first. Set `DATABASE_URL` to the direct Postgres DSN for the role whose
`search_path` selects the SDK schema. For a Host scope also set `HOST_SCHEMA` to the Worker's `host_scope` schema;
create that table with `hostScopeDdl` first. Keep these values in the private operator environment, not command arguments.
From `examples/hosted-bot-collaboration-worker` run:

```sh
node --import tsx src/operator-provision-cli.ts scope SCOPE --owner OWNER_ID --config host-config.json
node --import tsx src/operator-provision-cli.ts entitlement TENANT
```

The config is a HostConfig JSON object with `models` containing the Bot execution templates; the owner is a human
principal ID. The scope command also provisions its tenant entitlement and prints the owner session token exactly once
to stdout. Capture it privately. Running scope again rotates the token and invalidates the prior token. Both commands
preserve existing entitlements; new tenants get the example limits (1 GB total, 100 MB per object, 1 MB inline,
100 MB mailbox). Use a fresh tenant for each acceptance run.

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
owner principal and H Host config. It stands in for a product's own user and device tables. An invocation reads only
the rows it needs, each once: H awaits `host(scope)` and the entry's `owner(scope)`, and the owner's token is looked up
by its hash.

## Running a device

`device-runner` is a private example CLI. For device acceptance, start with a clean checkout of tag `v0.41.0`
(`2895560b37a5741d777241dcefc5c7fb1663fcb6`), then copy only the two runner files from the merge commit providing
this sealed runner extension. Set `W2_MERGE_SHA` / `$W2MergeSha` below to that actual merge SHA before running the commands. The runner is an example
overlay; the SDK packages are built from the tag. Record that SDK source commit and state in the evidence that the npm
packages for this tag were published from the same commit. Record the runner's merge SHA separately.

Use Node satisfying the tagged client's `engines` requirement. Run one runner per dedicated OS user on each device.
The Host must already have a provisioned scope and supply a fresh pairing code from `POST /host/pairing-code`; the
device needs only the Host URL and that code, never the operator bearer.

macOS, from the repository root (replace the merge SHA, Host and pairing-code placeholders locally):

```sh
git fetch origin --tags
git checkout v0.41.0
W2_MERGE_SHA='REPLACE_WITH_RUNNER_MERGE_SHA'
git checkout "$W2_MERGE_SHA" -- \
  examples/hosted-bot-collaboration-worker/src/device-runner.ts \
  examples/hosted-bot-collaboration-worker/src/device-session.ts
bun install --frozen-lockfile
bun run build
cd examples/hosted-bot-collaboration-worker
node --import tsx src/device-runner.ts \
  --server-url 'https://HOST.workers.dev' \
  --pairing-code 'PAIRING_CODE' \
  --root "$HOME/byok-worker-device" \
  --runtime stub
```

Windows PowerShell, from the repository root:

```powershell
git fetch origin --tags
git checkout v0.41.0
$W2MergeSha = 'REPLACE_WITH_RUNNER_MERGE_SHA'
git checkout $W2MergeSha -- `
  examples/hosted-bot-collaboration-worker/src/device-runner.ts `
  examples/hosted-bot-collaboration-worker/src/device-session.ts
bun install --frozen-lockfile
bun run build
Set-Location examples/hosted-bot-collaboration-worker
node --import tsx src/device-runner.ts `
  --server-url 'https://HOST.workers.dev' `
  --pairing-code 'PAIRING_CODE' `
  --root "$env:USERPROFILE\byok-worker-device" `
  --runtime stub
```

Use the same root for that device's enrollment and Agent homes. The runner uses the SDK's best-effort OS machine
identity probe and OS credential custody: the user's macOS Keychain or Windows Credential Manager. It supplies no
synthetic identity or in-memory credential backend. The unpackaged Windows runner requires the client's `koffi`
optional dependency; install optional dependencies and verify it loads on the acceptance machine. If `koffi` is missing
or cannot load, custody fails closed. A locked or unavailable credential store also fails the run.

The machine-id probe can return no identity when the OS identifier is unavailable. For cross-device acceptance, check
that the enrolled device's `device.machine_id` is non-null in Postgres; a `ready` event alone does not prove that fact.
A different root does not create a second physical machine identity, and the SDK refuses a store not bound to the
existing enrollment. Use the dedicated user's original root; this CLI does not implicitly replace another store's
enrollment.

Stdout is JSON lines, suitable for capturing through an operator's remote terminal (`hc run` / `hc exec`):

```jsonl
{"type":"ready","deviceId":"device-id","runtime":"stub"}
{"type":"started","taskId":"task-id","agentId":"agent-a","runtime":"stub"}
{"type":"finished","taskId":"task-id","runtime":"stub"}
```

`ready` means the Host accepted this run's `conn.hello`. In stub mode, send a JSON line on stdin for each result after
`started`, using its task id and the result document required by the Host's template. For the collaboration example:

```jsonl
{"type":"finish","taskId":"task-id","document":{"delegate":[{"to":"agent-b","request":"Check the totals"}]}}
```

B's reply and A's report can finish with `"document":{}`. Stub `finished` acknowledges result submission to the local
session, as the IPC fixture does; read the Host's settled Turn to establish completion. Task stdout events carry
`runtime` so synthetic evidence stays separate from real-runtime evidence. The local `approval-code` display described
below uses its own exact shape without `runtime`. Credentials, pairing codes, result documents
and raw SDK errors are omitted from the event output. Operational SDK diagnostics and a generic CLI failure go to stderr.
Keep pairing-code argv and remote-terminal history private; do not paste them into evidence.

For a Host requiring E2EE pairing, also pass `--verification-secret 'VERIFICATION_SECRET'` beside `--pairing-code`.
The member supplies that base32 secret through the same private operator channel as the code. Keep both values private,
including argv and terminal history. The runner passes the secret to the SDK and never echoes it. An invalid secret or
failed member verification fails closed. This mode emits one additional metadata-only event immediately after enrollment:

```jsonl
{"type":"paired","deviceId":"device-id","runtime":"stub"}
```

`paired` means the device registered its member bundle. The operator member can now verify its MAC, approve it and put
scope keys. It precedes `ready`; for E2EE, `ready` also requires the persisted relay approver key to match the locally
compared key. In both member and non-member runs, runtime admission opens only as `ready` is emitted; it stays closed
while startup is still waiting for the connection. Scope-key readiness is established by the Host's capability read.

For the deployed sealed canary, keep the W1 driver, member keys, Postgres/R2 credentials, bearer and tail capture on
mini-cf, following [the deployed canary setup](src/fixtures/sealed-canary/README.md). Prepare the device with the tagged
SDK and two-file overlay above. In mini-cf's private operator environment, optionally set `BYOK_CANARY_DEVICE` to a JSON
object with `machine` (the configured hc machine name), `cwd` (the absolute prepared checkout path on that machine), and
`root` (that dedicated user's absolute enrollment root). For example, using placeholder paths:

```sh
export BYOK_CANARY_DEVICE='{"machine":"mac-pro","cwd":"/path/to/byok-sdk","root":"/path/to/device-root"}'
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test \
  src/sealed-zero-hit.test.ts -t 'owner-configured HTTPS canary'
```

Without this variable the driver uses its in-process daemon. With it, the driver uses `hc run --bg --on <machine>` to
start the stub runner with `--canary-controls`, `hc send` for stdin and `hc read` for metadata. Before adding the device,
the driver sends its public bundle, verifies the runner's code against the MAC-authenticated device registration, and
sends `approve` (a mismatch sends `reject` and fails). Only the Host URL, pairing code, verification secret, public member
bundle and synthetic canary content reach the device. It approves the registered member and installs scope keys from
mini-cf, runs the sealed task and plaintext twin, then stops and removes its own hc terminal. Run each physical device
separately and record its SDK source commit, overlay merge commit, OS identity and result independently.

After `started`, the driver sends this single canary trigger on stdin:

```jsonl
{"type":"canary","taskId":"task-id","text":"synthetic-canary","sealed":true}
```

With `--runtime stub --canary-controls`, this checks the opened instruction, emits progress, waits for `Steer synthetic-canary`, requests
`Approve synthetic-canary`, and requires approval. It writes a fixed `notes.txt` artifact, emits two bounded progress
events to exercise terminal object spill, submits `{ "text": "synthetic-canary" }`, and waits for local task cleanup
before `finished`. The Host driver supplies the steer and approval through the existing sealed canary RPCs. Set
`sealed` to `false` for the plaintext twin's smaller progress events. Missing sessions, mismatched input, refused
approval, timeout or interruption fail the run. The command adds no content-bearing output event; the existing
`ready/started/finished/error` shapes stay the same. Each command runs sequentially; Ctrl-C/SIGTERM interrupts a pending
canary, while a stdin `stop` follows the current command. This synthetic probe makes no model call. The default stub
retains its original non-interactive capabilities; only explicit canary modes select the scripted adapter. The two
canary flags are mutually exclusive and valid only with `--runtime stub`.

For the browser member's separate round trip, add `--stub-canary` with `--runtime stub`. This opt-in mode sets
`agentMemoryMcp: 'off'` so the SDK does not prepend Agent-memory guidance to the opened instruction. It automatically
submits `{ "text": instruction }` for each admitted instruction task, using the instruction bytes the daemon opened.
It needs no stdin `finish` or canary trigger. Its extra event hashes exactly the UTF-8 instruction bytes:

```jsonl
{"type":"canary-result","taskId":"task-id","sha256":"64-lowercase-hex-digits","runtime":"stub"}
```

The browser compares that digest with its decrypted C3 `document.text`. The terminal summary can differ because the
stub emits the JSON result document as progress. `finished` still follows the daemon's completed event; a digest event
alone does not prove Host completion. Prepared launches are refused by this mode. The flag is invalid with
`--runtime real`. With the flag off, the runner continues waiting for stdin controls.

Whenever `--verification-secret` is given, in stub or real mode, the runner registers its device member, emits `paired`,
and pauses before `daemon.start()`. Copy the browser member's **public** bundle JSON from the page into the device's local
stdin, using this command (the placeholder denotes the actual JSON object):

```jsonl
{"type":"member-bundle","bundle":{"v":1,"memberId":"...","signingPublicJwk":{"kty":"EC","crv":"P-256","x":"...","y":"..."},"kemPublicJwk":{"kty":"EC","crv":"P-256","x":"...","y":"..."},"kemEpoch":1,"kemSig":"..."}}
```

The runner validates the complete public bundle and its self-signature, rejecting private key fields and unexpected
fields. It reads only the tenant id and public device bundle from the local OS `member-state` entry and emits exactly:

```jsonl
{"type":"approval-code","code":"50 decimal digits without spaces"}
```

Compare these digits with the page's ten groups of five **before** confirming either side. On a match, send
`{"type":"approve"}` to the device, then confirm on the page so it signs `add(device)` and relays the client MAC.
The device can now start and resume member verification. Before emitting `ready`, it reads the public persisted
`anchor.approverSigningPublicJwk` and compares its canonical `kty/crv/x/y` fields with the approved key; a different or
missing anchor stops the daemon and emits a fixed error. A successful binding alone does not open admission: the
single admission gate stays pending until the connection is open and `ready` is emitted, for both member and non-member
runs. Before that, `prepare()` returns `member binding pending` with `retryable:false`; any failed `start()` or `pair()`,
including a binding failure, abort, SDK rejection or readiness failure, closes the gate with `member binding failed`
and `retryable:false` before rethrowing. `stop()` also closes it.
Submit work only after `ready`: tasks offered before it are terminally declined and are not retried.
A sealed offer may still be opened in process memory before this refusal; nothing leaves the
process and no runtime starts. On a mismatch send `{"type":"reject"}`; the
runner stops before daemon startup or member relay acceptance. `approve` without a successful comparison, a second
bundle or task controls during the comparison fails closed. Keep this code on the device's local operator display;
do not send it to the browser or include it in evidence. The SDK's 10-minute pairing-verification TTL runs during this
pause: a slow operator fails closed and must pair again. The runner imports the SDK TTL from the pinned internal
module and measures the deadline from initiating pairing, never extending it. Binding waits remain interruptible by
Ctrl-C/SIGTERM. Discard the device root after a binding failure: its persisted anchor must never be resumed.

This comparison uses SDK-internal `DeviceMemberRecords` and the credential provider through source imports from the
pinned checkout. It reads only `member-state`, never the private `member-keys` entry or pairing-secret entry. The
public `@byok-sdk/core/sealed-payload` parser and fingerprint function are resolved through the installed client's
dependency. Missing modules or an incompatible/missing local record fail with a fixed comparison diagnostic. This is
an example overlay pinned to the checkout above; no SDK export or wire shape changes. The remote W1 driver follows
this same comparison gate.

For an explicitly approved real-runtime run, change only `--runtime stub` to `--runtime real` in the commands above.
That selects the SDK's bundled runtime adapters (Pi, Claude and Codex); the Host's execution template selects the
runtime and model, and the runtime must already be installed and authenticated on the device. The runner makes no
model call during setup. A real task completes through its runtime, and `finished` follows the daemon's completed
event. A stdin `finish` in real mode stops the daemon and exits the runner with status 1. Failures and cancellations
emit an `error` event with the task id and fixed text.
This CLI does not grant approval for model calls or establish cross-device acceptance evidence.

Send `{"type":"stop"}` on stdin, close stdin, or press Ctrl-C to stop and release the daemon. SIGTERM also stops it.
Keep stdin open while driving the Host from another terminal. A TTY enters raw mode before reading controls to disable
echo; its original mode is restored on success, error and interruption. Ctrl-C/Ctrl-D still stop the runner. Malformed
arguments or commands exit nonzero without echoing their contents. The original `device.child.ts` remains the test-only IPC entry with synthetic identities and
in-memory custody; both entries share task and event logic in `device-session.ts`.

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
  reply: the decision and its record stay. The same file tests runner argument/command validation, sealed pairing and canary controls, the hc driver adapter,
  shutdown and real adapter event forwarding without a model call. Its local runner case drives stdin/stdout against the Worker Host,
  checks an OS-derived machine id and uses a disposable macOS keychain (in-memory test custody on other platforms).

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
  the time of the pass before it. At 10x scopes the pass grows (the due scan, one sync per due scope), so lateness climbs toward the K8 late bound (60 s), past which a slot fires as `catch_up` with an
  occurrence key that differs from L's. Requests never reach the clock object: only the alarm and the once-a-minute
  arm-only cron do, so an alarm that is gone is replaced within a minute, with or without traffic. The next step is an
  alarm per scope: each scope's object sets its alarm to its own next due time and passes only its own rows.
- The H bundle pulls `node:sqlite` and `node:http` through the K4 index. workerd loads them today, and H never calls
  them.
