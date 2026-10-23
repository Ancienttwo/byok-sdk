# Hosted Bot collaboration (H)

Private reference example for #793 (#606 D2). It is the hosted (H) adapter of the K8 collaboration
commit contract (`examples/bot-collaboration`, #739 D1), on Node and Postgres.

Status: the commit store, the intent submitter (D2b-1) and the sync step (D2b-2). The message consumer,
result reconciliation, the command entry, the routine scheduler and retention come in later slices of #793.
Do not use this example as a deployed Host yet.

## Commit store

`HostedCollaborationStore` runs one command through the D1 commit contract in one Postgres
transaction. The transaction holds the state change, the command record and the outbox rows.

- A commit first upserts its scope row and then locks it, so the commits of one scope run one at a time.
- A replay returns the first result and writes nothing. A throw rolls back every row.
- H has no K4 ledger, so the store also records the terminal and message callbacks.
- The caller passes the scope that the authenticated product user owns. A request for another scope is
  a `scope_mismatch` conflict.
- A scope row of an unknown store version is refused before any write. `read()` refuses it too.

## Intent submitter

`freezeIntent` saves one intent for a Turn: its source, the frozen SDK input and the stable task id
`taskId(turnId, 0)` of K4. The caller holds the scope lock. A second freeze with the same source, input and
wait changes nothing. Another one throws `Intent identity conflict`, as K4 `enqueue` does.

`HostedSubmitter.run()` takes the due rows and runs the K4 rules on them: the FIFO head (`fifoHeads`), the
queued expiry (`queuedExpiry`) and the frozen submit (`submitFrozen`).

- A try first raises `tries` and takes a lease, under the scope lock. Then it calls the SDK.
- Every write after the SDK call is fenced: `WHERE tries = $mine AND submission <> 'delivered'`. A stale
  submitter cannot overwrite a newer try, and a delivered row never changes back.
- A row that was never tried expires at `wait_until`. A tried row past `wait_until` is never submitted
  again. It gets `cancel_reason = 'expired'` and no conclusion, because an SDK attempt can still exist.
  Reconciliation (D2d) checks the attempt first. A sync cancel that lands during the try keeps its reason.
- A delivered head holds its agent's queue until it has a conclusion. The scan returns only FIFO heads, so the
  followers of a queue never fill a pass ahead of a due head.
- A row whose try throws outside the SDK call is backed off, and the pass goes on. `run()` reports it in
  `failed`. A scope of an unknown store version is not written at all.
- The SDK input never changes, and the task id never changes. After a lost response, a readback finds the
  offer, and no second submit runs.

## Tables

`src/ddl.ts` holds the DDL. The statements are unqualified, and `migrate()` runs them in the store's own
schema. The SDK tables stay under the SDK migrations. This example never writes them.

| Table | One row per |
|---|---|
| `scope` | scope: the store version and the frame (the state without its rows) |
| `entity` | map entry of the state (Turn, card, Bot, room, delivery, ...), keyed by its id |
| `entry` | element of a list (audit, rejected, team note, home operation, room message), keyed by position |
| `command` | command record: the dedup evidence, the first result and the retention root (nullable) |
| `outbox` | projection or delivery that a commit wrote |
| `intent` | Turn intent: the frozen SDK input, the stable task id, the FIFO order and the submit state |

Each scope and each key is stored as `JSON.stringify(value)`, so two values that UTF-8 would merge stay
apart, and a NUL is safe. Each body is `json` text, so the stored bytes keep their key order. `ordinal`
keeps the insertion order of each kind.

## Accepted limits

- A commit loads every row of its scope, except the command records: it loads only the one record that
  it can replay. Retention, after #798, bounds the scope rows.
- When a list gets shorter, the positions of its later elements are renumbered. No K8 list gets shorter
  today. Retention needs a base offset, so that positions never change.
- The `kind` CHECK lists come from the layout at the first `migrate()`. `CREATE TABLE IF NOT EXISTS`
  keeps the old CHECK, so a new kind needs an explicit `ALTER` in a later migration.
- One commit must not delete a map key and add it back. The store keeps the old ordinal, but a JavaScript
  object moves the key to the end. K8 never deletes a map entry today.

## Database

One Postgres database can hold the SDK tables and this example's schema. The store takes its own
`pg.Pool`, so a separate database also works. No path assumes one atomic commit across the store and an
SDK call.

## Sync step

`HostedCollaborationStore.sync(scope, options)` runs the K8 sync rule (`syncTurn`) for each stored Turn, in
insertion order, in one transaction under the scope lock. It writes each step as L writes it to K4:

- `freeze`: `freezeIntent` stores the rule's intent input as it is.
- `cancel`: the open intent of an archived Bot gets `cancel_reason = 'cancelled'`.
- `ended`: nothing for a Turn that is not a routine Turn.
- A routine Turn throws, because H has no routine occurrences before D2f.

In history mode, `options.history` maps each Turn id to that Turn's history rows, as L reads them. A Turn without
an entry does not freeze.

The projections that the rule publishes reach the outbox in the same transaction. A sync writes no command
record and keeps the revision. A throw writes nothing. H records no execution start before D2d, so the rule
sees every open intent as not started. H retires no Turn id before D2g.

## Tests

```sh
docker compose -f docker-compose.test.yml up -d --wait
BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
  bun run --cwd examples/hosted-bot-collaboration test
```

Without `BYOK_TEST_POSTGRES_URL`, the Postgres suites skip. The submitter suite also needs
`BYOK_TEST_S3_ENDPOINT` (`http://127.0.0.1:9100` with the compose file), because the SDK composition takes an
object store. With `BYOK_REQUIRE_DATAPLANE=1`, a missing value is a failure. The CI `dataplane` job sets all
three and runs these suites.

- The D1 commit vectors run on the store and on a reference subject (the pure rules in memory).
- The D2b sync vectors run on the store.
- The sync test freezes the same Turns in an L ledger with K4 `enqueue`. Each H input is byte-equal to the K4
  execution input, and the H state bytes equal the L state bytes.
- The submitter tests use the hosted SDK composition (`createByokCloud` over `createPostgresCloudStores`, with
  the SDK migrations in its own schema), served over loopback HTTP, and a real daemon paired through the
  public pairing route. The intents are frozen directly, because D2b ships no product entry.
- After each step of two command scripts, the store's state bytes equal the reference subject's state bytes.
