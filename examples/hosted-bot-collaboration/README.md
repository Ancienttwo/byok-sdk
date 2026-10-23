# Hosted Bot collaboration (H)

Private reference example for #793 (#606 D2). It is the hosted (H) adapter of the K8 collaboration
commit contract (`examples/bot-collaboration`, #739 D1), on Node and Postgres.

Status: the commit store only. The SDK submit path, the message consumer, result reconciliation, the
command entry, the routine scheduler and retention come in later slices of #793. Do not use this
example as a deployed Host yet.

## Commit store

`HostedCollaborationStore` runs one command through the D1 commit contract in one Postgres
transaction. The transaction holds the state change, the command record and the outbox rows.

- A commit first upserts its scope row and then locks it, so the commits of one scope run one at a time.
- A replay returns the first result and writes nothing. A throw rolls back every row.
- H has no K4 ledger, so the store also records the terminal and message callbacks.
- The caller passes the scope that the authenticated product user owns. A request for another scope is
  a `scope_mismatch` conflict.
- A scope row of an unknown store version is refused before any write.

## Tables

`src/ddl.ts` holds the DDL. The statements are unqualified, and `migrate()` runs them in the store's own
schema. The SDK tables stay under the SDK migrations. This example never writes them.

| Table | One row per |
|---|---|
| `scope` | scope: the store version and the frame (the state without its rows) |
| `entity` | map entry of the state (Turn, card, Bot, room, delivery, ...), keyed by its id |
| `entry` | element of a list (audit, rejected, team note, home operation, room message), keyed by position |
| `command` | command record: the dedup evidence and the first result |
| `outbox` | projection or delivery that a commit wrote |

Each key is `JSON.stringify(id)`. Each body is `json` text, so the stored bytes keep their key order.
`ordinal` keeps the insertion order of each kind.

Known limit: a commit loads every row of its scope, but only the one command record that it can replay.
Retention, after #798, bounds the scope rows.

## Database

One Postgres database can hold the SDK tables and this example's schema. The store takes its own
`pg.Pool`, so a separate database also works. No path assumes one atomic commit across the store and an
SDK call.

## Tests

```sh
docker compose -f docker-compose.test.yml up -d --wait
BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test bun run --cwd examples/hosted-bot-collaboration test
```

Without `BYOK_TEST_POSTGRES_URL`, the Postgres suites skip. With `BYOK_REQUIRE_DATAPLANE=1`, a missing URL
is a failure. The CI `dataplane` job sets both and runs these suites.

- The D1 commit vectors run on the store and on a reference subject (the pure rules in memory).
- After each step of two command scripts, the store's state bytes equal the reference subject's state bytes.
