# Implementation Notes: issue-196-recurring-smoke-roundtrip

## Ground truth verified this session

- `scripts/release/recurring-smoke.mjs` (47 lines): only function-existence + undefined read-backs for absent messages; wired by `pack-and-smoke.mjs:535-536` (copied into isolated install, run with `node`, env inherited by default through `run()`'s spawnSync — no env filtering).
- `ByokCloud` public message path: `submitRecurringExecution` requires a registered consumer (cloud.ts:1924); inbound choke point = `handleInboundEnvelope` (inbound.ts), reached authenticated via `POST /byok/messages` over `cloud.fetch` with bearer token minted by `/byok/pair` (pairing needs `core.quota.writeEntitlement` first — harness idiom in packages/cloud/src/__tests__/support/harness.ts).
- Read-back surfaces: `cloud.readTaskAgentMessage` (task-agent-message.ts; transport evidence never the Host body) and `cloud.readAgentMessageDisposition` (inbound.ts; missing/pending → undefined, corrupt → throw).
- Durable substrate: `createByokServer.storage` is memory|sqlite ONLY (server/src/types.ts:29-39). The public Postgres composition is `createByokCloud` + `createPostgresCoreStores` + `createPostgresCloudStores` (all exported from `@byok-sdk/cloud-dataplane` main entry, together with `migrate`/`migrationsDir`/`createByokPool`) — exactly the dataplane conformance recipe (conformance.test.ts:56-78), which also filters `CLOUD_CAPABILITIES.blobsContentProxy` out of the declaration because no blob proxy is mounted.
- `createPostgresCloudStores` REQUIRES `objectStorage` config even when blobs are never exercised (stores/index.ts:84-101) — the durable leg passes the MinIO endpoint config but never touches blobs; the undeclared blobs.contentproxy capability keeps that honest.
- Fail-closed law: `BYOK_REQUIRE_DATAPLANE=1` + missing substrate = hard failure at the point of use (support/dataplane.ts import-time throw idiom). One substrate, one gate: both `BYOK_TEST_POSTGRES_URL` and `BYOK_TEST_S3_ENDPOINT`, never half.

## Design decisions

1. The smoke is substrate-parameterized INSIDE recurring-smoke.mjs. In-memory leg always runs (3 OS npm-release-pack legs unchanged + richer). Durable leg runs only when both substrate vars are present; half-configured or REQUIRE=1-unmet → throw. No "skipped durable" success output anywhere (structural absence).
2. Durable leg composition = kernel-level (`createByokCloud` + Postgres stores), NOT `createByokServer` (cannot take Postgres). "Reopen server/consumer" = a fresh independent process composing the same public parts over the same database with a NEW pool; same-identity reopen is preserved by sharing the token-signer secret + access token through a handoff file.
3. "Recovery starts no new model Execution" is proven in the reopened process by exact-replay of the publish envelope: wire-level success (`{accepted:1}`), disposition byte-identical (same receiptId — no new decision), and the reopened composition's consumer records ZERO invocations.
4. Finalize-outage recovery (checkbox 3) is ported from agent-message-readback.test.ts: injected `stores.tasks.finalizeAgentMessage` failure after the product consumer "committed" (its own ledger) → HTTP 5xx → admission pending → exact replay → consume called a SECOND time (at-least-once; never asserted to be once) → product ledger still ONE logical effect → identical terminal disposition, payload not duplicated.
5. ci.yml dataplane job gains exactly one step: `bun run check:release-pack -- --out-dir .ci-artifacts/release-pack`. Job-level env (POSTGRES_URL/S3/REQUIRE) flows into the smoke run inside pack-and-smoke, so the durable leg executes against the compose Postgres from the packed tarballs. `pack-and-smoke.mjs` itself needs NO change (env inheritance verified in source); contract lists it as conditional-only.

## Verification log

(filled at close)

## Deviations

(filled at close)
