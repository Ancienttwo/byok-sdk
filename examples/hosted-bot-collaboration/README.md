# Hosted Bot collaboration (H)

Private reference example for #793 (#606 D2). It is the hosted (H) adapter of the K8 collaboration
commit contract (`examples/bot-collaboration`, #739 D1), on Node and Postgres.

Status: the package entry only. The Postgres store and its schema come in the next slice.
The SDK tables stay under the SDK migrations. This example owns only its own collaboration tables.

## Tests

`bun run --cwd examples/hosted-bot-collaboration test` runs the D1 commit vectors on the reference
subject. The CI `dataplane` job runs this suite against a real Postgres.
