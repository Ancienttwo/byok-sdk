> **Archived**: 2026-08-13 03:30
> **Related Plan**: plans/archive/plan-20260813-0259-pg-pool-error-and-flake.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260813-0330

# Implementation Notes: pg-pool-error-and-flake

> **Status**: Active
> **Plan**: plans/plan-20260813-0259-pg-pool-error-and-flake.md
> **Contract**: tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md
> **Review**: tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md
> **Last Updated**: 2026-08-13 02:59
> **Lifecycle**: notes

## Part 1 — pg Pool error handler (landed, production bug)

`packages/cloud-postgres/src/pool.ts`

- `createByokPool` now installs a mandatory `pool.on('error', ...)` listener. A
  `pg.Pool` with no `'error'` listener rethrows an idle-client backend reset
  (failover / `pg_terminate_backend` / idle proxy timeout / network blip) as an
  uncaught exception that terminates the host process — there is no in-flight
  `await` to reject, so `pg` surfaces it on the pool.
- Added optional `onPoolError?: (err: Error, client?: PoolClient) => void` to
  `ByokPoolOptions`. Supplied → reset routed to it. Absent → observable default
  `console.error('[byok-sdk] idle pg pool client error (handled, not fatal)', err)`,
  never a silent no-op. Host owns policy; SDK gives a fail-safe default.
- `onPoolError` is destructured out before the config reaches `new pg.Pool`, the
  same discipline `types` gets (not a `PoolConfig` field).
- Untouched, as required: pool ownership model, process-wide `pg.types`, int8
  parser. `allowExitOnIdle` NOT added — it changes exit semantics and the flake
  finding shows it is irrelevant (resets are undici HTTP sockets, not pg
  backends; dataplane pools are already `.end()`-ed in `support/dataplane.ts`).

Tests: `packages/cloud-postgres/src/__tests__/pool.test.ts` (4 cases, no DB):
routed-to-onPoolError-without-throw; observable-default-listener-installed;
onPoolError-stripped-from-config; int8-bigint regression + non-int8 defers to
default. Runner-portable (no `vi`, no `vi.setConfig`; manual console save/restore).

## Part 2 — flake origin finding

**Finding: the `socket hang up` flake is undici→MinIO keep-alive, NOT the pg
pool.** Reasoned from code — did NOT run the dataplane suite (no MinIO / no
`BYOK_TEST_S3_ENDPOINT` in this env; only an unrelated salesko Postgres sidecar
exists). No run fabricated.

Evidence:
1. `socket hang up` is undici/Node-http's verbatim message for ECONNRESET on a
   pooled keep-alive socket; pg's reset message is
   `Connection terminated unexpectedly` — a different string. CI shows the undici one.
2. Object/conformance/cleanup suites drive MinIO over `globalThis.fetch` (undici)
   with keep-alive — `putViaGrant`, `landBlobBytes`, R2 maintenance, the stores'
   default `#fetch` (`stores/r2-blobs.ts:277,600`), aws4fetch `storage.client`.
   Nothing closes/drains the undici global dispatcher, so idle keep-alive sockets
   to MinIO outlive the last assertion.
3. pg is already drained on the passing path (`dispose()` → `pool.end()`), so the
   pg crash does not fire in the test happy path — which is why the flake reads as
   a post-pass teardown failure, not a mid-test pg error.
4. Timing matches an idle keep-alive reset: after pass, an idle MinIO socket is
   reset during the wind-down window; undici raises `'error'` with no in-flight
   request → uncaught rejection vitest reports after assertions passed.

Mechanism confirmed locally against a throwaway `node:http` server (not MinIO):
undici pools keep-alive by default (2 reqs → 1 socket); request-level
`Connection: close` opens a fresh socket per request and does not pool it
(2 reqs → 2 sockets) while preserving the signed `authorization` header.

Falsifier outcome: the contract's hypothesis (pg pool is the CI-flake source) is
**falsified**; the pg handler stays as an independent production fix per contract.

## Flake fix — LANDED (option b: keep-alive-off global dispatcher)

After the orchestrator widened Allowed Paths to include `pnpm-lock.yaml` and
`packages/cloud-postgres/package.json`, the fix is landed.

- `packages/cloud-postgres/package.json`: added `"undici": "8.9.0"` devDep,
  pinned to the version already in the lockfile → 3-line lock delta, no new
  package resolution, nothing downloaded.
- `packages/cloud-postgres/vitest.config.ts` (new): registers one `setupFiles`
  entry; every other vitest default untouched.
- `packages/cloud-postgres/src/__tests__/support/disable-fetch-keepalive.ts`
  (new): runs once per test worker before its files import, calling
  `setGlobalDispatcher(new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }))`.
  Keep-alive is effectively off — each MinIO socket closes ~immediately after its
  response, so no idle keep-alive socket survives to be reset by
  `docker compose down -v`. Node's built-in `fetch` reads the same process-wide
  global dispatcher, so this covers EVERY MinIO fetch — including the conformance
  path through `createPostgresCloudStores` (no per-client `fetch` seam needed).

**Mechanism chosen: (b), not (a).** Option (a) (keep-alive ON, close the
dispatcher once at the END) needs a once-per-worker teardown hook vitest does
not cleanly offer here: `globalSetup` runs in the MAIN process (not the worker
that owns the sockets), and a setup-file `afterAll` runs per file, not once per
worker. Per the orchestrator's own rule ("if (a) can't be wired cleanly, fall
back to (b)"), (b) is used — a setup-time dispatcher swap that needs no teardown
timing to be correct and cannot break sibling files in a reused worker.

**Guardrail honored:** no `process.on('uncaughtException')` swallow — the fix
prevents the reset rather than hiding it. Live query errors still reject their
`await`; the pg idle-client path still routes to `onPoolError`/the observable
default from Part 1.

**Verification split:** the flake fix itself is **CI-verified, not
locally-verified** — the real dataplane suite cannot run here (no MinIO). True
acceptance surface = Node 22 + Node 24 dataplane CI green across reruns. What IS
verified locally: the dispatcher mechanism against a throwaway `node:http` server
with the installed undici@8.9.0 driving Node's built-in fetch — keep-alive-off
yields a fresh socket per request (no idle socket lingers), fetch stays
functional, and cross-major (undici 8 npm ↔ Node's bundled undici 7.28) interop
works; `pnpm install --frozen-lockfile` consistent; `typecheck`/`test`/`build`
all green.

## Deviations From Plan Or Spec

- None outstanding. The earlier hand-back on the flake fix was resolved by the
  orchestrator's Allowed-Paths amendment; the fix is now landed as above.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Silent no-op pool error handler | Rejected | Hides real connection failures; repo principle is fail-safe AND observable |
| Add `allowExitOnIdle` | Rejected | Changes process-exit semantics; flake finding shows it is irrelevant to teardown |
| Symbol-level `getGlobalDispatcher().close()` in test teardown | Rejected | Global dispatcher symbol is non-resettable without the undici pkg; per-file close breaks sibling files in reused workers |
| Per-call `Connection: close` across suites | Rejected | `createPostgresCloudStores` has no fetch seam → partial coverage |
| Option (a): keep-alive on, close dispatcher once at END | Rejected | No clean once-per-worker teardown hook in vitest (globalSetup is main process; setup-file afterAll is per file) |
| Option (b): `undici` devDep + setup-time keep-alive-off `setGlobalDispatcher` | **Chosen, landed** | Complete (process-wide, covers conformance), no teardown-timing fragility, reuse-safe |

## Open Questions

- None. Flake fix landed (option b); its acceptance is the dataplane CI job,
  which the orchestrator runs on the PR.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
