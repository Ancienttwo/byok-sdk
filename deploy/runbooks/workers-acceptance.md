# Workers acceptance runbook (#654 / #794)

Status: window preparation only. This document claims no cloud or physical-device acceptance PASS. On 2026-11-14 the owner approved restarting W1-W4 acceptance with a total cap of **USD 10: Workers Paid USD 5 + runtime USD 5**, `workers.dev` only (no zone or route), a PlanetScale **development branch**, and teardown on the same day. This work does not block 0.43.0. Each real model call still needs approval for its model, call count and budget allocation; the deployment budget does not authorize model calls.

Roles: the **owner** creates and deletes cloud resources, enters all credentials, operates the GUI and compares approval codes. The **operator seat** prepares builds and non-sensitive materials on mini-cf and records redacted evidence. The **device seat** uses hc to operate dedicated device checkouts. **t3** fixes the window and records each row's verdict. The owner runs commands that use credentials in a private operator terminal; seats may guide the owner but must not read the filled environment or secrets in command output. mac-pro belongs to another account: remote verification for this documentation/code delivery is limited to build, typecheck and pure unit tests. The pairing, keychain, browser and other acceptance commands below are for the owner's actual window, with the roles specified in each row.

Start with the [Worker example](../../examples/hosted-bot-collaboration-worker/README.md), [W1/W4 operations and member page](../../examples/hosted-bot-collaboration-worker/src/fixtures/sealed-canary/README.md) and [hosted operations runbook](hosted-operations.md). The C, 2.x, 5.x and T identifiers preserve the old execution sheet's numbering for comparison with historical records. W1=#1625 (deployed canary), W2=#1624 and W2b=#1630 (devices), W3=#1628 (vectors), W4=#1629 (member page), W5=#1638 (provisioning); all have merged to main.

## Boundaries, evidence and stop conditions

- Create only the `byok-p9-h` and `byok-p9-canary` Workers. H uses the `HostClock` DO and a once-per-minute cron. Do not deploy the local fixture `src/fixtures/sealed-canary/worker.ts`, AgentDO or the smoke Worker. Leave `H_FAULT` unset.
- PlanetScale: use the new dev branch `byok-p9` of `aiphabee-staging`, database `postgres`, four `byok_p9_*` schemas and two roles with that prefix. Do not connect to main. **Postgres major version must be 18, ssl=on, and available connections >=13**. Limit each Hyperdrive to 5 origin connections, leaving 3 for migrations/checks. Monitor headroom during concurrent work; do not raise the limits yourself.
- Do not open, reuse or modify AiphaBee's three Hyperdrive configurations: `AIPHABEE_HYPERDRIVE`, `AIPHABEE_RELEASED_MARKET_DATA_HYPERDRIVE`, `AIPHABEE_AUTH_HYPERDRIVE`. Seats do not create cloud resources, log in to Cloudflare/PlanetScale, or read/write real credentials.
- Cross-machine operations use only `hc run|exec|file|send|read --on <machine>`. No raw ssh/scp, tunnels or Cloudflare Access login. If hc cannot reach a machine, report to t3; do not log in or reconnect yourself. t3 coordinates a Windows slot with t8 first. Verify physical machine versus VM and label VM results as VM results.
- Seats may stop only processes they can prove are their own: cwd/argv points to their worktree, or the ppid chain reaches their shell. Record the hc terminal, PID and cwd/argv. Report unknown processes to t3. Do not kill node/wrangler by name. The owner also checks runner ownership before cleanup.
- Keep `_ops/p9` on the operator machine only, with mode 700 directories and mode 600 private files. Do not send DSNs, S3 keys, bearers, raw tails or member private keys to devices. Devices receive only the Host URL, pairing code, pv, public bundle and synthetic input. Disable shell tracing; do not print env, dump keychains or read `member-keys`.
- For each row record UTC start/end, operator, command with secrets removed, `WINDOW_SHA`, SDK tag/SHA, overlay file hashes, deployment version ID, OS/browser versions, counts/hashes, PASS/FAIL/OPEN and cleanup status. Keep Node, Worker, cross-process, each physical device, each browser engine, synthetic runtime and real runtime results separate. Do not combine them into one PASS.
- Do not commit tokens, passwords, DSNs, pairing/pv/approval codes, presigned URLs, canary plaintext, raw objects or raw tails. Put research and runtime evidence in `docs/researches/` and row verdicts in the issue/PR. Do not mark either of the two [VALIDATION](../../packages/bot-collaboration/VALIDATION.md#open-acceptance-rows) rows PASS without its own evidence: **Two physical computers** maps to the macOS + Windows chain / W2.10 row below; **Two Topology L Host processes** is outside this Workers window and stays **OPEN (#606 O4)**. Worker/DO or two-daemon evidence does not close the Topology L service-relay and durable request/verdict recovery gap.
- If any C5 preflight/statement fails, especially GRANT, or any C6 comparison fails, stop and report immediately; do not change database configuration. Do not pair devices after a P2 smoke failure. After an acceptance row fails, continue only independent rows. Do not change code and retry in the window: stop your runner, record FAIL, then perform P5. Code changes require a new window SHA and rebuild.
- If a secret is exposed, stop the affected operation. The owner rotates/revokes it; evidence records only the incident and response. Stop acceptance when spending reaches USD 10 or the remaining budget cannot cover the remaining operations, leaving time for teardown. Complete P5 that day even after failure, a machine handoff or an hc interruption.
- This work does not enable CI `test:browser` or `BYOK_TEST_WORKER_SEALED_CANARY`, and does not cover #1499, downstream migration or #977. Manual W3 and remote HTTPS W1 in the window are separate from those CI switches.

## P0: Pin versions, build and preflight devices (seats, about 20-40 minutes)

| Row | Who / command or action | Pass / stop condition | Acceptance mapping |
| --- | --- | --- | --- |
| C1 / 2.1 | t3 / operator seat: `git fetch origin main --tags`; pin `WINDOW_SHA` below in a clean checkout, record `git rev-parse HEAD`; `hc machine ls` | SHA is on main and includes #1663's sender fix and this runbook's keychain argument; otherwise stop | #794 D3, shared by #654(d)(e) |
| C2 / 2.2 | device seat: `hc exec --on mac-pro 'uname -sm; sw_vers; node -v; bun -v; git --version'`; inspect only the directories/checkouts it prepared under `~/byok-p9` | Node meets the selected tag's engines; Bun follows that tag's packageManager. Do not reuse a root paired on 11-11 | #794 devices / #654(d)(e) |
| C11 | operator seat: `bun ci`, `bun run build`, `bun run typecheck` at the window SHA; confirm `bunx wrangler@4.158.0 --version` in the example directory | All exit 0; otherwise stop in P0 | All rows |
| 2.3-2.6 | device seat: latest published stable tag (at least v0.42.0) plus the two-file window SHA overlay; build/typecheck with the commands below | Exactly two overlay files, compilation exits 0; no unpublished SDK code | #794 5.2/chain, #654 5.11/5.15 |
| 2.8 | device seat: `bun ci && bun run build` in a separate window SHA checkout. During the window the owner installs browsers: `PLAYWRIGHT_BROWSERS_PATH="$HOME/byok-p9/ms-playwright" bun node_modules/playwright/cli.js install chromium firefox webkit` | W3 uses the main checkout; do not install browser dependencies into the SDK tag checkout. Record an affected engine OPEN/FAIL on failure | #654(e) 5.13 |

Pin versions (operator / t3; all later steps reuse these variables, without taking a new main SHA mid-window):

```sh
set -e
git fetch origin main --tags
WINDOW_SHA="$(git rev-parse origin/main)"
# #1663's implementation merged in #1705; the issue number is not a commit.
git merge-base --is-ancestor 333a5ef9f53e12952613132d7bb94d7a35d1e48a "$WINDOW_SHA"
git merge-base --is-ancestor "$WINDOW_SHA" origin/main
git checkout --detach "$WINDOW_SHA"
SDK_TAG="$(gh release view --json tagName --jq .tagName)"
gh release view "$SDK_TAG" --json tagName,isDraft,publishedAt
# t3 confirms: stable, published, not a draft, >= v0.42.0; record the tag's commit.
git rev-list -n 1 "$SDK_TAG"
```

The window SHA must also include this PR's keychain CLI/W1 forwarding. At selection, confirm `device-runner.ts` implements `--macos-keychain-path`. #1663 runs the outbox sender on every pass so projection/home/card/host_job rows are handled; D3 evidence must come from a head containing it. Record `send.steps / send.failed / send.synced` and `host_projection` deduplication. An explicit failure when no card/channel connector exists is not successful delivery evidence.

In the separate device checkout, set local `WINDOW_SHA` / `SDK_TAG` to the **same window SHA** and published tag supplied by t3. Do not transfer the operator environment:

```sh
git fetch origin main --tags
git checkout --detach "$SDK_TAG"
git checkout "$WINDOW_SHA" -- \
  examples/hosted-bot-collaboration-worker/src/device-runner.ts \
  examples/hosted-bot-collaboration-worker/src/device-session.ts
git status --short
bun install --frozen-lockfile
bun run build
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker typecheck
shasum -a 256 examples/hosted-bot-collaboration-worker/src/device-{runner,session}.ts
```

Do not start from an older SDK tag and edit package manifests to supply missing APIs. The runner's `daemon.whenTaskSettled` comes from #1838, hence the v0.42.0 minimum. The example README has equivalent PowerShell commands. On Windows omit the macOS keychain argument, install optional dependencies and verify `koffi` loads first. Use one dedicated OS user per device. On 11-11 the owner allowed mac-pro's existing account; the owner confirms that account for this window, keeping all files in the window's directory and dedicated keychain.

## P1: Owner resources and private configuration (about 50-65 minutes)

Only the owner performs these dashboard/private-terminal steps. Seats do not run them while preparing this document. If resources already exist at handoff, verify their creator, window and names and report to t3. They still need teardown that day.

On the window day, the operator seat saves the C5, C6 and C10 fenced blocks below verbatim on mini-cf as `_ops/p9/c5-roles.sql`, `_ops/p9/c6-baseline.sql` and `_ops/p9/p9.env.template`. Create mode 700 `_ops/p9`, set these files to mode 600 and confirm `git check-ignore _ops/p9`. These files contain SQL or placeholders only. The owner then makes and fills the separate private `p9.env`; seats never read or copy the filled file. This runbook is the tracked source for all three files.

| Row | Who / command or action | Pass / stop condition | Acceptance mapping |
| --- | --- | --- | --- |
| C3 | owner: Cloudflare > Workers & Pages > Plans > Workers Paid; confirm Workers Paid USD 5 + runtime USD 5 = USD 10 and same-day teardown | Return "Paid on" and billing start time; stop if cost differs from approval | All cloud rows |
| C4 | owner: PlanetScale > `aiphabee-staging` > New **development branch** `byok-p9` | Connect page confirms the target branch and its separate host/branch ID; not main | All storage rows |
| C5 | owner: from repo root run `pscale shell aiphabee-staging byok-p9 --role admin`; run the [preflight](#c5-preflight-before-role-or-grant-changes) **before** `\i _ops/p9/c5-roles.sql`, then `\password byok_p9_h` and `\password byok_p9_canary` | **major=18, ssl=on, available_connections>=13** before any role/GRANT changes. Two roles, four schemas, database-scoped search_path. Stop on any failure, especially `GRANT CREATE ON DATABASE postgres` | #794 H, #654(d)(e) |
| C6 | owner: in the same shell, `\i _ops/p9/c6-baseline.sql` | Keep sorted non-P9 schema/role names only in the private `_ops/p9` file below. Public evidence contains version, connection counts, schema/role counts and MD5 only; exclude `current_user` from role comparison | All cloud rows |
| C7 | owner: create Hyperdrive `byok-p9-h` / `byok-p9-canary`; origin is dev branch host:5432 / postgres, with branch-qualified `byok_p9_h.<branch_id>` / `byok_p9_canary.<branch_id>`, TLS and max origin connections=5 each | Both Active; give seats only non-secret configuration IDs. Do not open AiphaBee's three configurations | #794 pooling, #654(d) |
| C8 | owner: create R2 bucket `byok-p9-staging`; S3 token grants Object Read & Write for this bucket only | Keep endpoint/keys private on operator. W4 uses same-origin `/member/ciphertext`; the page needs no R2 CORS rule | #794 5.7, #654(d)(e) |
| C9 | owner: deployment token expiring that day, Account Workers Scripts: Edit + Workers Tail: Read, no zone permissions; enable workers.dev | Account ID / subdomain may go to seats; the token may not. Owner creates Hyperdrive/R2, so the deploy token needs no extra permissions | Shared |
| C10 | owner: copy `_ops/p9/p9.env.template` from the [C10 block](#c10-environment-template) to ignored `_ops/p9/p9.env`, directory mode 700 / file mode 600; fill it with a private editor and load it into the private process with the owner's env loader | Direct DSNs on 5432, `sslmode=verify-full`, correct roles/schemas; different H/canary token keys; single-line JSON. Return only "filled"; seats do not inspect file/env | Shared |

### C5 preflight before role or GRANT changes

At the private branch-admin prompt, run this read-only gate **before** `\i _ops/p9/c5-roles.sql`. A failed gate exits the shell; report to t3 and do not change configuration. Continue monitoring connection headroom throughout the window.

```sql
\set ON_ERROR_STOP on
select current_setting('server_version_num')::integer / 10000 = 18
  and current_setting('ssl') = 'on'
  and current_setting('max_connections')::integer - (select count(*) from pg_stat_activity) >= 13
  as p9_preflight_ok \gset
\if :p9_preflight_ok
  \echo 'P9 preflight OK; role SQL may proceed'
\else
  \echo 'P9 preflight failed; stop'
  \quit
\endif
```

### C5 role and schema file

Save this block verbatim as `_ops/p9/c5-roles.sql`. It temporarily grants database CREATE to the H role for migration only; the owner revokes it after C12.

```sql
-- C5: run on the NEW dev branch only (never main), as the default role:
--   pscale shell aiphabee-staging <new-branch> --role admin
-- From the repo root, then: \i _ops/p9/c5-roles.sql
-- No passwords in this file. Set them afterwards with \password (typed by the owner).
\set ON_ERROR_STOP on
CREATE ROLE byok_p9_h LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE byok_p9_canary LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE SCHEMA byok_p9_sdk_h AUTHORIZATION byok_p9_h;
CREATE SCHEMA byok_p9_h AUTHORIZATION byok_p9_h;
CREATE SCHEMA byok_p9_host AUTHORIZATION byok_p9_h;
CREATE SCHEMA byok_p9_sdk_canary AUTHORIZATION byok_p9_canary;
ALTER ROLE byok_p9_h IN DATABASE postgres SET search_path TO byok_p9_sdk_h, public;
ALTER ROLE byok_p9_canary IN DATABASE postgres SET search_path TO byok_p9_sdk_canary, public;
-- Needed only for steps 3.3-3.4 (store.migrate runs CREATE SCHEMA IF NOT EXISTS); revoked right after.
-- If this GRANT is refused: STOP, change nothing else, and tell t3.
GRANT CREATE ON DATABASE postgres TO byok_p9_h;
\dn byok_p9_*
\du byok_p9_*
```

### C6 baseline file

Save this block verbatim as `_ops/p9/c6-baseline.sql`. These read-only queries exclude P9 names and the shell's temporary `current_user` role, so T4 can compare non-P9 counts/hashes across admin sessions. They do not scan business data. Before running C6, the owner creates an empty mode 600 `_ops/p9/non-p9-names.private.txt` on mini-cf. `\o` keeps schema/role names in that private file; never paste its contents into a public issue/PR. Publish only counts and MD5. T4 overwrites the private file and compares the public counts/hashes with C6.

```sql
-- C6 baseline, NEW dev branch byok-p9 only. Names stay in the private file; no data rows.
\set ON_ERROR_STOP on
select version();
select current_setting('server_version_num')::integer / 10000 as major_version;
show ssl;
show max_connections;
select count(*) as current_connections,
  current_setting('max_connections')::integer - count(*) as available_connections
  from pg_stat_activity;
\o _ops/p9/non-p9-names.private.txt
select nspname from pg_namespace
  where nspname not like 'pg\_%' and nspname <> 'information_schema' and nspname not like 'byok\_p9\_%' order by nspname;
select rolname from pg_roles where rolname not like 'byok\_p9\_%' and rolname <> current_user order by rolname;
\o
select count(*) as schemas, md5(string_agg(nspname, ',' order by nspname)) as schema_list_md5
  from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema' and nspname not like 'byok\_p9\_%';
select count(*) as roles, md5(string_agg(rolname, ',' order by rolname)) as role_list_md5
  from pg_roles where rolname not like 'byok\_p9\_%' and rolname <> current_user;
```

### C10 environment template

Save this block verbatim as `_ops/p9/p9.env.template`. The owner copies it to private `_ops/p9/p9.env` and replaces placeholders there only. The template is not a shell script.

```dotenv
# Placeholder reference only; NOT a shell script. Owner enters real values privately.
# Copy to ignored _ops/p9/p9.env, mode 600. Never source this placeholder file.
# Use an owner-controlled env loader; JSON and URLs need quoting if converted to shell syntax.
# Seats never read, print or copy the filled p9.env. Operator machine only.
# PlanetScale Postgres 18, dev branch byok-p9, direct port 5432, sslmode=verify-full.
P9_H_DATABASE_URL=<H_DIRECT_DSN>
BYOK_CANARY_POSTGRES_URL=<CANARY_DIRECT_DSN>
HOST_ADMIN_TOKEN=<OPERATOR_BEARER>
BYOK_TOKEN_SECRET_H=<H_64_LOWERCASE_HEX>
BYOK_TOKEN_SECRET_CANARY=<CANARY_64_LOWERCASE_HEX>
BYOK_S3_ACCESS_KEY_ID=<BUCKET_SCOPED_ACCESS_KEY_ID>
BYOK_S3_SECRET_ACCESS_KEY=<BUCKET_SCOPED_SECRET_ACCESS_KEY>
BYOK_CANARY_STORAGE=<ONE_LINE_JSON_WITH_ENDPOINT_BUCKET_REGION_ACCESSKEYID_SECRETACCESSKEY>
CLOUDFLARE_API_TOKEN=<END_OF_WINDOW_DEPLOY_TOKEN>
CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID>
BYOK_CANARY_BASE_URL=<CANARY_HTTPS_ORIGIN>
P9_H_BASE_URL=<H_HTTPS_ORIGIN>
BYOK_CANARY_TAIL_FILE=<ABSOLUTE_OPERATOR_CHECKOUT>/_ops/p9/canary-tail.jsonl
```

## P2: Migrate, deploy and smoke (owner handles credential commands; seats check redacted results, about 30-45 minutes)

| Row | Who / command or action | Pass / stop condition | Acceptance mapping |
| --- | --- | --- | --- |
| C12a | owner: in the private environment run `DATABASE_URL="$P9_H_DATABASE_URL" deploy/scripts/migrate`, then `DATABASE_URL="$BYOK_CANARY_POSTGRES_URL" deploy/scripts/migrate` | Use the **window SHA's** `deploy/sql` list/checksums, not an old pinned final SQL filename. Stop on checksum or migration failure | Shared |
| C12b | owner: H Node DDL below; then in branch admin shell `REVOKE CREATE ON DATABASE postgres FROM byok_p9_h;` | H tables, `byok_p9_host.host_scope` and `host_projection` exist; stop if revocation fails | #794 / #1663 |
| C13 | operator seat: `bun examples/hosted-bot-collaboration-worker/src/build-member.mjs`; prepare the two `_ops/p9` configs and check paths against the list below (non-sensitive configuration only) | Assets exist, `git check-ignore _ops/p9` succeeds, tracked configs unchanged | #654(e) / shared |
| C14 | owner: seven `wrangler secret put` commands below, with private input | Check names only with `secret list`; stop on any error. Do not send values to seats | Shared |
| C15 | owner: `bunx wrangler@4.158.0 deploy -c _ops/p9/byok-p9-h.wrangler.jsonc`; `GET /byok/capabilities` | 200, includes longpoll/batch/presigned, excludes contentproxy; BYOK_PG, HOST_CLOCK and cron bindings. Record version ID | #794 Worker |
| C16 | owner: `bunx wrangler@4.158.0 tail byok-p9-h --format json > _ops/p9/h-tail.jsonl`; wait <=75 seconds; `POST /host/passes {}` with/without admin bearer | Cron starts without requests; at least two alarm passes about 15 seconds apart. With bearer 200 / without bearer 401; otherwise stop | #794 clock/auth |
| C17 | owner: deploy canary; `GET /member`, `GET /member.js`, unauthenticated `POST /probe/call`, `GET /member/ciphertext`, then capabilities | Static assets 200; both control endpoints 401; E2EE member capability present. A 503 for a missing key is a failure, not a skip | #654(d)(e) |
| C18 | owner: W5 scope CLI below; owner session token is printed once to the owner and stored privately | Scope entitlement + host_scope exist. Rerunning rotates the session token; do not paste stdout to seats | #794 5.1-5.8 |
| C19 | t3 / seat: check H smoke, canary auth/static, versions, budget and remaining teardown time; go/no-go | Historical handoff calls this phase C14-C22, but the execution sheet defines rows only through C19. This runbook preserves C14-C19 without inventing other rows. Any P2 failure leads to P5 | Shared |

H DDL: the owner starts at repository root after selecting the H role in private `DATABASE_URL`. The subshell changes to the Worker example so Bun's isolated dependencies resolve, then returns to repository root. Imports come from the window SHA. Fixed error messages prevent driver errors from printing DSNs:

```sh
(
set -e
cd examples/hosted-bot-collaboration-worker
DATABASE_URL="$P9_H_DATABASE_URL" node --import tsx --input-type=module <<'JS'
import pg from 'pg';
import { HostedCollaborationStore } from '../hosted-bot-collaboration/src/index.ts';
import { hostScopeDdl, hostProjectionDdl } from './src/host-scopes.ts';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const store = new HostedCollaborationStore(pool, 'byok_p9_h', { host: async () => ({ models: {} }) });
  await store.migrate();
  await pool.query(hostScopeDdl('byok_p9_host'));
  await pool.query(hostProjectionDdl('byok_p9_host'));
  console.log('H DDL OK');
} catch { console.error('H DDL failed; stop and report'); process.exitCode = 1; }
finally { await pool.end(); }
JS
)
```

C13 configuration checklist (operator seat prepares; owner checks account and IDs):

- H: copy `examples/hosted-bot-collaboration-worker/src/wrangler.json` to `_ops/p9/byok-p9-h.wrangler.jsonc`; set `name=byok-p9-h`, `main=../../examples/hosted-bot-collaboration-worker/src/worker.ts`, `workers_dev=true`; replace the Hyperdrive ID. Preserve compatibility date/flags, DO `HostClock` SQLite migration v1 and cron `* * * * *`.
- H vars: `H_SCHEMA=byok_p9_h`, `HOST_SCHEMA=byok_p9_host`, `H_CLOCK_MS=15000`, `BYOK_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `BYOK_S3_BUCKET=byok-p9-staging`, `BYOK_S3_REGION=auto`. No `H_FAULT` or secret vars.
- Canary: copy `src/fixtures/sealed-canary/wrangler.deployable.template.json` to `_ops/p9/byok-p9-canary.wrangler.jsonc`; fill only the new canary Hyperdrive ID / owner account configuration. The template's main path is already relative to that destination; ASSETS `./member-assets` is the C13 output. The same-origin member page needs no R2 CORS rule.

C14 (owner enters values in the private operator terminal; if the first invocation needs to create a Worker stub, allow only the two P9 names. Stop on failure; do not switch to a public deployment without secrets):

```sh
bunx wrangler@4.158.0 secret put BYOK_TOKEN_SECRET -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put HOST_ADMIN_TOKEN -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_S3_ACCESS_KEY_ID -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_S3_SECRET_ACCESS_KEY -c _ops/p9/byok-p9-h.wrangler.jsonc
bunx wrangler@4.158.0 secret put HOST_ADMIN_TOKEN -c _ops/p9/byok-p9-canary.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_TOKEN_SECRET -c _ops/p9/byok-p9-canary.wrangler.jsonc
bunx wrangler@4.158.0 secret put BYOK_CANARY_STORAGE -c _ops/p9/byok-p9-canary.wrangler.jsonc
bunx wrangler@4.158.0 deploy -c _ops/p9/byok-p9-canary.wrangler.jsonc
```

C18: the owner first prepares private `_ops/p9/host-config.json` (HostConfig, with `models.default` set to the selected stub execution template and `readOnlyToolsets: []`; take the shape from the window's `examples/host-execution-core/src/test-support.ts#template`). A pending device may be used initially. After pairing, update the template with the actual deviceId, reprovision and use the new token.

```sh
cd examples/hosted-bot-collaboration-worker
# Owner's private environment: DATABASE_URL=H direct DSN, HOST_SCHEMA=byok_p9_host.
node --import tsx src/operator-provision-cli.ts scope p9-scope --owner p9-owner --config ../../_ops/p9/host-config.json
# W4 uses a fresh tenant per browser run; select the canary direct DSN in DATABASE_URL.
node --import tsx src/operator-provision-cli.ts entitlement p9-browser-tenant
```

HTTP commands use `METHOD /path JSON` notation, with the body and method listed in each row. The owner sends them with a private client, taking Authorization from memory/env rather than putting it in curl argv. For example, `POST /host/passes {}`:

```sh
node --input-type=module <<'JS'
try {
  const r = await fetch(new URL('/host/passes', process.env.P9_H_BASE_URL), {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.HOST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}'
  });
  console.log('HTTP', r.status);
  if (!r.ok) process.exitCode = 1;
  // Extract only approved counts for evidence; do not print the whole response.
} catch { console.error('P9 request failed'); process.exitCode = 1; }
JS
```

## P3: Rows independent of the mac-pro keychain (about 30-45 minutes)

| Row | Who / command or action | Pass / stop condition | Acceptance mapping |
| --- | --- | --- | --- |
| 5.9 / W1.1 | owner (on mini-cf): `bunx wrangler@4.158.0 tail byok-p9-canary --format json > _ops/p9/canary-tail.jsonl`; keep its own tail process alive and record terminal/PID | Capture logs throughout; an interrupted tail cannot support complete zero-hit evidence | #654(d) logs |
| 5.10 / W1.2 | owner (on mini-cf): load canary URL, direct DSN, bearer, storage JSON and absolute tail path privately; **leave BYOK_CANARY_DEVICE unset**; run the W1 command below | Sealed and plain twin complete; sealedHits=0; inventory missing/unexpected arrays empty; twin found in outbox.body and an object; member decrypts. Label separately "operator-machine daemon (mini-cf)" | #654(d), does not replace physical-device evidence |
| 5.4 / W2.1 | owner (on mini-cf): open `GET /byok/board/stream` with a separate SDK device client; after headers arrive, `POST /host/board-item {"scope":"p9-scope","item":{"itemId":"p9-after-headers","channel":"worker","title":"synthetic"}}` (admin) | A new `event: board` arrives; record event ID. Requires a device bearer, not the admin bearer. Without an authorized client, wait for P4; do not claim PASS without a device | #794 SSE/pool lifetime |
| 5.5 / W2.2 | owner (on mini-cf): use the window's `src/clock.test.ts` routine fixture with Node `store.seed`/`bindDevice` to set a future slot; let cron/alarm run it, without `/host/passes` | Fires `scheduled` within the 60-second late bound; one occurrence, one offer. If unpaired/not ready, wait for P4 | #794 DO/cron |
| 5.6 / W2.3 | owner (on mini-cf): send 10 concurrent `POST /host/input {"botId":"main","key":"<distinct-id>","request":"synthetic"}` requests to a ready Bot (owner session) | Each commits once; tail has no prepared statement/search_path errors. Without a ready Bot, wait for P4 | #794 Hyperdrive pooling |
| 5.13 / W3 | owner on mac-pro's separate main checkout: `cd examples/hosted-bot-collaboration-worker`, `PLAYWRIGHT_BROWSERS_PATH="$HOME/byok-p9/ms-playwright" bun run test:browser` | Chromium/Firefox/WebKit pass; record each userAgent and Playwright version. Record a failed engine FAIL and a missing engine OPEN | #654(e) Layer V |

W1 command (owner on mini-cf; the remote HTTPS case opts in through `BYOK_CANARY_BASE_URL`, **without enabling the local canary CI switch**):

```sh
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test \
  src/sealed-zero-hit.test.ts -t 'owner-configured HTTPS canary'
```

Complete fixtures/assertions for 5.4-5.6 are in `src/worker.test.ts` and `src/clock.test.ts`. Their local suites create roles/schemas and wrangler dev themselves. **Do not replace their POSTGRES_URL with PlanetScale and run the whole local suite.** In the window, apply only the scenario setup to the existing P9 role/schemas and send requests through the deployed URL. t3 checks the prepared Node scenario commands/fixture hashes in P0. Direct SQL writes of result rows cannot stand in for Worker execution evidence.

## P4: mac-pro dedicated keychain, devices and browsers (owner, about 60-90 minutes)

### 2.7 Dedicated keychain by default (owner; verify a security round trip first)

On 11-11, row 2.7's login keychain writes returned exit 36 even in a GUI terminal; unlocking it is not a demonstrated fix. This window uses a **new dedicated keychain** on mac-pro by default, through public `deviceCredentials.macosKeychainPath`. The runner exposes `--macos-keychain-path`, and W1's `BYOK_CANARY_DEVICE.macosKeychainPath` forwards the same argument. No manual checkout patch or change to the system default keychain/global search list is needed.

The owner creates/unlocks it in a mac-pro GUI terminal, entering the password interactively at the system prompt. Do not use `-p <password>` in argv or expose it to a seat:

```sh
P9_KEYCHAIN="$HOME/Library/Keychains/byok-p9.keychain-db"
# If it exists, verify ownership first; do not overwrite it.
security create-keychain "$P9_KEYCHAIN"
security unlock-keychain "$P9_KEYCHAIN"
security set-keychain-settings "$P9_KEYCHAIN"
# Public synthetic round-trip value only; no device credential.
security add-generic-password -s byok-p9-roundtrip -a byok-p9-probe -w p9-public-probe "$P9_KEYCHAIN"
test "$(security find-generic-password -s byok-p9-roundtrip -a byok-p9-probe -w "$P9_KEYCHAIN")" = p9-public-probe
security delete-generic-password -s byok-p9-roundtrip -a byok-p9-probe "$P9_KEYCHAIN"
```

Repeat the round trip as the same OS user and in the same launch context as the runner (owner-operated; do not put the password in hc messages). If any command exits nonzero, including exit 36, **stop all rows depending on the keychain** and report to t3. Do not switch to in-memory credentials or write the password to a file. Delete the dedicated keychain at teardown. Record the change from the 11-11 login-keychain procedure, and include the public configuration path in #654 evidence (the username may be redacted).

### Device and cross-device rows

| Row | Who / command or action | Pass / stop condition | Acceptance mapping |
| --- | --- | --- | --- |
| 5.1 / W2.5 | owner (on mini-cf): `POST /host/pairing-code {"scope":"p9-scope"}` (admin); use the fresh code promptly | Code stays out of evidence; re-pair if expired | #794 |
| 5.2 / W2.6 | owner/mac-pro: runner command below, root under `~/byok-p9/`, stub runtime, dedicated keychain argument | ready event; DB device.machine_id non-null. Record device hash, SDK tag/SHA and overlay hashes | #794 macOS |
| setup / 5.3 | owner (on mini-cf): update C18 HostConfig with the actual deviceId; follow Node setup in `src/worker.test-support.ts#openHome.bot`: `store.seed` (seedCollaboration, initial t1 terminal state, main.execution) and `store.bindDevice`. Do not call `openHome`, which creates a local substrate. Then `POST /host/input {"botId":"main","key":"p9-turn-1","request":"synthetic"}` > pass > started > `hc send <owned-terminal> '{"type":"finish","taskId":"<id>","document":{"text":"synthetic"}}'` > pass | One offer, one command/outcome, Turn settled; #1663 sender runs every pass, projections deduplicate and home becomes ready. Do not continue dependent rows after failure | #794 single device and sender |
| 5.7 / W2.8 | owner/mac-pro: upload a synthetic artifact through SDK blob prepare/upload/commit, then download through presigned GET; W1 physical-device row also covers artifact upload | R2 object and manifest exist, sizes/hashes match. Record hashes/sizes, not URLs/bytes. W1 upload alone cannot prove download PASS | #794 R2 |
| 5.8 / W2.9 | owner (on mini-cf): redeploy the same window code/config during an in-flight scenario, `bunx wrangler@4.158.0 deploy -c _ops/p9/byok-p9-h.wrangler.jsonc` | Next alarm rereads PG and completes once; record both version IDs and before/after counts. Redeploy proves version-switch recovery, not observation of natural platform eviction | #794 isolate recovery |
| chain / W2.10 | owner: only with an available, approved physical Windows slot on win-ci, pair a second Bot with independent enrollment/home; run A->B->A from `src/two-devices.test.ts` | Two distinct non-null machine_ids; each Turn runs once on its assigned device, each outcome/reply once. With mac-pro only, leave OPEN; a second Mac does not satisfy macOS+Windows | #794 two physical devices |
| Topology L / #606 O4 | t3: outside this Workers window; no Topology L Host relay acceptance is run | **OPEN**; needs service relay and durable request/verdict recovery evidence | #794 VALIDATION: Two Topology L Host processes |
| real / W2.10 | owner approves runtime/model and the 3-Turn budget for each run, then repeats the chain with `--runtime real` | Record model/runtime, usage/cost and the same counts in a separate real row. Without approval or Windows, leave OPEN | #794 real runtime |
| 5.11 / W1.3 | owner (on mini-cf): first stop 5.2 and any prior runner and clear the four T1 product accounts as required below; set BYOK_CANARY_DEVICE below and rerun the W1 command | Automatic 50-digit code/MAC comparison, sealed zero hits, positive twin and member decryption; label "physical device (mac-pro)" | #654(d) macOS |
| 5.12 / W1.4 | owner: independent Windows root, machine=win-ci, omit macosKeychainPath; repeat W1 | Separate Windows evidence; label a VM as VM. If unreachable, OPEN | #654(d)(e) Windows |

Runner example (the owner may launch it with `hc run --bg --on mac-pro --cwd <device-checkout>/examples/hosted-bot-collaboration-worker`; pairing argv/hc history remain private):

```sh
node --import tsx src/device-runner.ts \
  --server-url 'https://byok-p9-h.<subdomain>.workers.dev' \
  --pairing-code '<private-code>' --root "$HOME/byok-p9/device-root" \
  --runtime stub --macos-keychain-path "$HOME/Library/Keychains/byok-p9.keychain-db"
```

In W1's private operator environment, set only public path configuration here. Use actual absolute paths; `$HOME` inside JSON does not expand:

```sh
export BYOK_CANARY_DEVICE='{"machine":"mac-pro","cwd":"<absolute-device-checkout>","root":"<absolute-fresh-canary-root>","macosKeychainPath":"<absolute-dedicated-keychain-path>"}'
```

W1 operates, stops and removes only the runner terminal returned by its own `hc run`. It must not handle other sessions. Keychain records are keyed by **product**, not root: service=SHA-256(productId), with the four fixed T1 accounts. A fresh root for the same product overwrites the previous enrollment in that keychain. **Before 5.11 and before every 5.15 run**, the owner stops the 5.2 runner and any prior W1/W4 runner, confirms they ended using the T1 ownership rules, and deletes all four product accounts listed in T1 from the dedicated keychain (keep the keychain itself until teardown). Then pair with a fresh root under `~/byok-p9/`. After any pairing/binding failure, keep the failed verdict, clear those same four product accounts and discard that root's anchor before pairing again. To resume 5.2 later, repeat this stop/clear/fresh-root pairing and update C18/5.3 with the new deviceId; do not resume the overwritten enrollment.

### 5.3 Node preparation command (owner on mini-cf)

At the operator repository root, select the H role in private `DATABASE_URL` and set `P9_DEVICE_ID` to the paired device's public ID. The subshell changes to the Worker example for dependency resolution and returns to repository root. This command sets up the initial scenario, not acceptance results. Then rerun the C18 scope CLI to rotate the owner token. It uses the same fixture setup as `openHome.bot`; provisioning a scope alone does not make its Bot ready:

```sh
(
set -e
cd examples/hosted-bot-collaboration-worker
DATABASE_URL="$P9_H_DATABASE_URL" node --import tsx --input-type=module <<'JS'
import pg from 'pg';
import { writeFile } from 'node:fs/promises';
import { HostedCollaborationStore } from '../hosted-bot-collaboration/src/index.ts';
import { seedCollaboration } from '@byok-sdk/bot-collaboration/testing';
import { template } from '../host-execution-core/src/test-support.ts';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  if (!process.env.P9_DEVICE_ID) throw new Error();
  const execution = template(process.env.P9_DEVICE_ID, 'main');
  const config = { models: { default: execution }, readOnlyToolsets: [] };
  const store = new HostedCollaborationStore(pool, 'byok_p9_h', { host: async () => config });
  await store.seed('p9-scope', state => {
    seedCollaboration(state);
    Object.assign(state.turns.t1, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    state.team.bots.main.execution = execution;
  });
  await store.bindDevice('p9-scope', process.env.P9_DEVICE_ID);
  await writeFile('../../_ops/p9/host-config.json', JSON.stringify(config), { mode: 0o600 });
  console.log('H scenario prepared; reprovision scope before input');
} catch { console.error('H scenario preparation failed; stop and report'); process.exitCode = 1; }
finally { await pool.end(); }
JS
)
```

### W4 browser member page (#654(e) Layer M; owner; about 15-20 minutes per engine)

| Row | Who / command or GUI action | Pass / stop condition |
| --- | --- | --- |
| 5.14 / W4.1-2 | owner (on mini-cf) first runs C18 `entitlement <fresh-tenant>` with the canary DSN; owner opens `https://byok-p9-canary.<subdomain>.workers.dev/member` in the target browser, enters bearer, tenant and product=`hosted-collaboration-worker`, creates keys | Only public bundles displayed; bearer stays in tab memory, not console/URL. Fresh tenant each run |
| 5.15 / W4.3 | owner: first stop 5.2 and any prior runner and clear the four T1 product accounts as required below; start fresh tenant on the page; give private pairingCode/pv to mac-pro runner with `--verification-secret <pv> --runtime stub --stub-canary --macos-keychain-path <dedicated-path>` and a fresh root under `~/byok-p9/` | paired event; 10-minute pair-verification TTL. On timeout record FAIL and use a fresh root |
| 5.16 / W4.4 | owner: enter deviceId on page and verify MAC; Copy public bundle; send `{"type":"member-bundle","bundle":<public-json>}` on device stdin. Compare all 50 approval-code digits on both screens. Only on a match send `{"type":"approve"}` to the device and check page confirmation; otherwise `{"type":"reject"}` | Device becomes ready only after anchor match. Do not send the code to the page or evidence, or bypass visual comparison |
| 5.17 / W4.5 | owner: active tab signs C1/C3 policy and issues epoch 1 scope keys; paste routing template `{deviceId,payload}` (fields in W4 README; omit instruction/sealing/sealed), submit then decrypt C3 | Page PASS, hash=device canary-result sha256, chain length/task/epoch/userAgent. finished must arrive; digest alone is not completion |
| 5.18 / W4.6 | owner: approve a second tab through both-screen comparison per W4 README; remove one member; remaining tab signs a fresh epoch and submits a new task | Removed tab FAIL/member_revoked + scopeKey absent; remaining tab PASS with matching hash. Old-epoch failure is not new-epoch revocation evidence |

Record separate matrices for Layer V and Layer M: Chromium, Gecko/Firefox and WebKit on mac-pro, plus actual GUI Chrome stable, Firefox release and system Safari. Repeat applicable rows on Windows. Capture versions/UA at runtime; do not reuse 11-11 versions. Verify Firefox `about:support` Update Channel=release; a Store package version does not prove the channel. If an engine is missing on mac-pro or Windows is unreachable, leave its row OPEN. Vector PASS does not replace member e2e, and three engines on one macOS machine do not replace two physical devices.

## P5: Same-day teardown T0-T9 (reserve about 30-45 minutes)

This is a manual checklist, with **no script that automatically deletes cloud resources**. The owner verifies ownership and deletes cloud resources one by one. The device seat deletes only the explicitly named window runner entries, dedicated keychain, roots and checkouts, without reading entry values. This delivery does not execute these cleanup commands. Failed cleanup remains incomplete; do not record "torn down". t3 follows up that day.

| Row | Who / command or action | Completion evidence / stop condition | Acceptance mapping |
| --- | --- | --- | --- |
| T0 | **owner**: immediately after the last W4 run, rotate both Workers with `bunx wrangler@4.158.0 secret put HOST_ADMIN_TOKEN -c <P9-config>`; test old bearer on H `POST /host/pairing-code` and canary `POST /probe/call` | Both reject old token with 401; owner verifies privately without recording values. If this fails, stop acceptance and continue revocation/resource deletion | #654(e) cleanup after bearer entered in page |
| T1 | **owner** stops acceptance runners. Seats may stop only their own processes with cwd/argv/ppid ownership proof: first `hc send <owned-terminal> '{"type":"stop"}'`, confirm ended, then `hc rm`; kill after timeout only with ownership proof. Device seat deletes runner keychain entries, round-trip item and dedicated keychain as listed below. Seat checks each own checkout with `git status -uall` and removes its `~/byok-p9` checkouts/roots/browser cache and this window's enrollment data | Terminals ended, own processes gone, roots/checkouts removed. Report unknown files/processes to t3. On Windows clean only the specified Credential Manager targets | #794 and #654 device cleanup |
| T2 | **owner**: in Cloudflare dashboard delete Worker `byok-p9-h` (including this window's HostClock DO/cron) and `byok-p9-canary`; verify associated DO storage/bindings are removed, with no cron deployment left | Worker/DO/cron name lists contain no window resources. Changing an existing Worker is not teardown | Shared |
| T3 | **owner**: delete Hyperdrive configurations `byok-p9-h` and `byok-p9-canary`; empty/delete R2 bucket **byok-p9-staging**; revoke its S3 token | Dashboard confirms both new configs, bucket and token absent. Do not open the other three configs | Shared |
| T4 | **owner**: connect only with `pscale shell aiphabee-staging byok-p9 --role admin`; revoke CREATE, explicitly drop four schemas/two roles below, rerun C6 and compare non-P9 counts/hashes; then delete dev branch **byok-p9** in dashboard | Baseline matches and dev branch is deleted. Report drop/comparison failure to t3; do not change main or delete non-P9 objects | Shared |
| T5 | **owner**: revoke that day's Cloudflare deploy API token | Dashboard confirms revocation; do not merely wait for TTL | Shared |
| T6 | **owner**: decide whether to keep Workers Paid. If not, cancel in dashboard (effective at period end); if kept, record reason and expected bill in teardown | Explicit owner decision, daily cost and no remaining P9 billable resources recorded. Do not cancel a plan serving other uses without the owner's decision | Budget |
| T7 | **owner**: save redacted counts/hashes, then delete operator `_ops/p9` (env, tails, private config/token captures). **Seats** delete only extra worktrees/non-secret temporary files they created; first `git status -uall`, then `git worktree remove <exact-owned-path>` | Private directory absent. Do not use `/tmp/byok-sdk-wt-*` wildcard deletion or clean another seat's directory | Shared |
| T8 | **owner**: close member tabs, remove this run's dedicated browser profile/site data, check for private-key/secret exports and retained pairing clipboard/history | In-memory member keys are lost; private inputs stay out of delivered evidence | #654(e) |
| T9 | **t3**: record itemized teardown in #654/#794: names, UTC, deletion/keep-Paid decision, costs and incomplete items; record acceptance per row and keep remaining gaps in the parent issue | Mark window ended only after owner resource/credential cleanup is confirmed. Missing Windows/real-runtime rows stay OPEN | Both issues independently |

T1 keychain cleanup (device seat, without reading values): verify the service for product `hosted-collaboration-worker` against `serviceFor` in the window's `packages/client/src/daemon/device-credential-store.ts`, which uses SHA-256(productId). This product's service is `com.byok.client.device.2b3d0f2634593b65f8264cc7b4eb57012017c0f066ba513317d7e641aa2fd498`. Inspect/delete only its four accounts: `device-enrollment`, `device-member-p256-v1`, `device-member-pairing-v1`, `device-member-state-v1`. Do not use `-w` / `-g` to read real entries. For each, use `security find-generic-password -s <service> -a <account> <dedicated-keychain>` (metadata) and `security delete-generic-password -s <service> -a <account> <dedicated-keychain>`. If this window accidentally wrote an item into the login keychain, the owner verifies ownership by the same service/account before deleting it; do not delete all byok items. Then:

```sh
# Device seat: verify ownership of this dedicated path; never target login.keychain-db.
P9_KEYCHAIN="$HOME/Library/Keychains/byok-p9.keychain-db"
test -f "$P9_KEYCHAIN" || { echo 'dedicated keychain missing; stop'; exit 1; }
security delete-generic-password -s byok-p9-roundtrip -a byok-p9-probe "$P9_KEYCHAIN"
# The round-trip item should already be gone; record item-not-found, not other errors.
security delete-keychain "$P9_KEYCHAIN"
```

On Windows the device seat deletes this product service's enrollment target and the three `<service>/device-member-{p256,pairing,state}-v1` targets, checking names without reading passwords; remove the fresh root and window checkout. If unreachable, T1 remains incomplete and is reported to t3. Deleting the cloud branch does not clean device state.

T4 manual SQL (owner, dev branch only; verify `current_database()` and connection target first, with no schema wildcard):

```sql
REVOKE CREATE ON DATABASE postgres FROM byok_p9_h;
DROP SCHEMA byok_p9_h, byok_p9_host, byok_p9_sdk_h, byok_p9_sdk_canary CASCADE;
ALTER ROLE byok_p9_h IN DATABASE postgres RESET ALL;
ALTER ROLE byok_p9_canary IN DATABASE postgres RESET ALL;
DROP ROLE byok_p9_h, byok_p9_canary;
-- Rerun c6-baseline.sql and compare non-P9 counts/hashes; owner then deletes byok-p9 in dashboard.
```

## Sources and recovery

This runbook combines the original P9 plan, updated n1 runbook, 11-11 deploy-day-sheet/exec-log and [handoff section 6](../../docs/releases/2026-11-11-coordination-handoff.md#6-%E9%83%A8%E7%BD%B2%E6%97%A5654794). The 11-11 log proves only C1/C2/C11 preflight/build, with **no successful deployment evidence after C3**. Do not carry its PASS results into the new window. Current paths use `packages/bot-collaboration`. The old plan's W1-W4 implementation gaps and W5 missing CLI have been addressed by the merged PRs.

For local compatibility verification, check out `v0.42.0` (`14e0628d2`) in a temporary worktree, overlay only the two runner files, then run `bun ci`, `bun run build` and the example typecheck. The PR verification record gives the final SHA, file hashes, commands and results. This proves compilation compatibility only; P1-P5 require separate evidence during the owner's window.
