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

All commands run 2026-09-19 on this branch (claude/issue-196-recurring-smoke-roundtrip, base a6c5a297 = origin/main).

- `bun run build` exit 0; `bun run typecheck` exit 0; `bun run check:api-surface` "10 package golden(s) match"; `bun run check:version-authority` README/spec agree with byok-sdk@0.18.0 / keys@0.5.0.
- Full release driver WITH substrate env: `BYOK_TEST_POSTGRES_URL=... BYOK_TEST_S3_ENDPOINT=... node scripts/release/pack-and-smoke.mjs --out-dir /private/tmp/byok-196-artifacts` → exit 0 (packs 11 tarballs, isolated npm install, both smoke legs, Pi launcher, packed-CLI MCP). Manifest printed at end (sourceGitSha 125b89063b4421a174daa49da011809a3df8dd0b, per-tarball sha256) — also copied to tasks/runs/20260919-0418-issue-196-release-manifest.json.
- Standalone isolated install (`/private/tmp/byok-196-isolated`, npm install of the manifest tarballs):
  - in-memory leg only: `node recurring-smoke.mjs` → exit 0 (tasks/runs/20260919-0418-issue-196-smoke-in-memory.green.log)
  - both legs: with env pair → exit 0, durable markers visible (tasks/runs/20260919-0418-issue-196-smoke-durable-restart.green.log): reopened-process read-back with no TaskHandle, zero-execution exact replay, per-run `byok_smoke_<uuid>` database migrated by the installed runner, dropped in `finally` (DROP ... WITH (FORCE)).
  - fail-closed: `BYOK_REQUIRE_DATAPLANE=1` without substrate → exit 1; half-configured (POSTGRES_URL only) → exit 1 (tasks/runs/20260919-0418-issue-196-fail-closed.env-check.log).
- Mutation check (checkbox 6): patched installed `@byok-sdk/cloud/dist/index.js` `readTaskAgentMessage` head to `return undefined;` → smoke exit 1, failing on the new non-empty read-back assertion (recurring-smoke.mjs:286); pre-existing assertions still passed — they alone cannot catch it. Reverted; dist sha256 re-verified (69cc080e...). Evidence: tasks/runs/20260919-0418-issue-196-mutation-check.red.log.
- `bun run test` → exit 1 with EXACTLY the pre-existing darwin baseline: `pi-s2-bundle-resolution.test.ts:327` local registry tripwire (2872 passed / 1 failed / 11 skipped). Failure set diffed identical to the pre-existing baseline log tasks/runs/20260919-0244-wp5-s2-ci-flip.full-test.log (same single FAIL line) — zero new failures from this branch (tasks/runs/20260919-0418-issue-196.full-test.log).
- `.github/workflows/ci.yml` YAML validity: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → OK (step inserted in dataplane job only, ci.yml:586-603).
- `repo-harness run check-task-workflow --strict`: run at close; result recorded in the review file.

## Deviations

- None from the agreed design. pack-and-smoke.mjs untouched (substrate env flows through `run()`'s default spawnSync env inheritance — verified in source and by the durable leg executing during the driver run). packages/client/src/__tests__ untouched (scenarios copied, not extracted).
- The durable restart leg composes `createByokCloud` + Postgres stores instead of `createByokServer` — this is the design, not a deviation: `ByokServerStorage` is memory|sqlite only (packages/server/src/types.ts:29-39); the kernel-level public composition is the same one dataplane conformance uses (packages/cloud-dataplane/src/__tests__/conformance.test.ts:56-78, incl. filtering blobsContentProxy when no proxy is mounted).
- `objectStorage` is a REQUIRED construction parameter of `createPostgresCloudStores`; the leg passes the compose MinIO config but never exercises the byte plane and leaves blobs.contentproxy undeclared — structural absence, not a hidden skip.
- The smoke's injected-outage scenario surfaces Hono's console error line for the injected 500 between markers in standalone runs; pack-and-smoke's `run()` discards smoke stdout, so CI logs never see it. Asserted behavior is the >=500 response plus the recovery path.
- The mutation RED fails as a TypeError (undefined payload access) rather than a formatted assertion — the contract "smoke must fail" holds (exit 1); noted for honesty in the evidence header.
