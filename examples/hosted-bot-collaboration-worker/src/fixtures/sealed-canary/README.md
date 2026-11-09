This directory includes a **local test fixture** (`worker.ts`) and a separate
operator-authenticated deployment entry (`deployable-worker.ts`). The local
fixture's unauthenticated `/probe/*` control plane is available only through
the loopback `wrangler dev` instance created by `sealed-zero-hit.test-support.ts`.
Never deploy `worker.ts`.

The Node driver runs migrations and provisions quota in a disposable SDK
schema, using the role's database-scoped `search_path`. The Worker uses that
same role through `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG`;
all pairing, member-chain, submission, steering, approval, device traffic and
Host readback then execute in workerd. Each invocation creates the public
`cloud-dataplane/runtime` stores and closes its pool via `waitUntil`.

The shared E6 suite pairs a real daemon and a member with OS credential custody,
then runs one C1/C3 sealed task and its plaintext twin through a scripted
runtime. The plain twin has less filler to stay within the existing 256 KiB
journal record limit, while the sealed terminal exercises its ciphertext object.
Both tasks must complete. No provider or paid model is called. It checks device delivery, member
decryption, every SDK tenant table/column, all bucket objects, committed observer
envelopes, Node console calls, and Wrangler/workerd stdout and stderr. Ciphertext
locations must still match the inventory in `docs/security.md`; plaintext
locations and the Worker terminal log supply positive controls.

From the repository root:

```sh
docker compose -f docker-compose.test.yml up -d --wait
BYOK_TEST_WORKER_SEALED_CANARY=1 \
BYOK_TEST_WORKER_DATAPLANE=1 \
BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test \
BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test src/sealed-zero-hit.test.ts
```

On Linux, wrap the test command with `bash scripts/ci/with-secret-service.sh`.
On macOS, the shared driver creates and deletes a temporary keychain. The suite
skips without both the dedicated canary opt-in and the Worker dataplane substrate.
`BYOK_REQUIRE_WORKER_SEALED_CANARY=1` rejects either missing prerequisite; the
existing `BYOK_REQUIRE_WORKER_DATAPLANE=1` still rejects a missing substrate.
Only loopback endpoints are accepted. The separate canary opt-in keeps the
existing CI Worker step from executing E2EE outside a Secret Service session;
its future CI enablement and wrapper require approval.

This is local workerd + a Hyperdrive **local connection string**. It does not
exercise Cloudflare's deployed Hyperdrive service, remote R2, a real deployment,
two physical devices, or the Chromium/WebKit/Gecko member matrix. Those remain
separate evidence for #654. CI selector/mapping changes require approval and are
not part of this patch.

Owner-run deployment day

The following steps are for the owner to run during the approved staging window.
This change provides the entry and driver; it records no deployed acceptance.
Run the W1 driver, its in-process daemon and Node member only on the operator
machine mini-cf, with all configuration loaded from mode-600 ignored
`_ops/p9/p9.env`. Label this evidence **operator-machine daemon (mini-cf)**.
It uses a scripted runtime and OS credential custody; it is not physical-device
evidence. Keep the DSN, S3 keys, `HOST_ADMIN_TOKEN` and raw tail only on mini-cf.
The physical devices mac-pro and win-ci run only the W2 `device-runner`, receiving
the public server URL and a pairing code, never the operator environment or tail.
Physical-device sealed execution for #654 (d) needs a W2 extension for E2EE
pairing with `verificationSecret` and the driver's steer, progress, approval and
artifact controls. t3 tracks that work separately; this driver does not use the
current W2 runner for sealed execution.

1. Build the workspace with `bun run build`. Prepare a disposable Postgres schema,
   a role whose database-scoped `search_path` selects that schema, and an existing
   bucket used only for this canary. Apply the SDK migrations from Node with
   `DATABASE_URL` in the environment using `deploy/scripts/migrate`. The driver
   provisions a new tenant's quota through the direct DSN, but does not migrate,
   create or delete a bucket, create a Hyperdrive config, or drop schemas. It leaves
   tenant rows and objects for owner teardown. The Worker Hyperdrive origin and the
   direct scan DSN must select the same schema; its S3 secret and the driver's S3
   config must name the same bucket.
2. Copy `wrangler.deployable.template.json` to
   `_ops/p9/byok-p9-canary.wrangler.jsonc` from the repository root. Its `main` path
   is already relative to that destination. Fill only the canary Hyperdrive id.
   Keep real account identifiers and configuration under ignored `_ops/`, with
   no real routes in the tracked template. Use the owner's account environment.
3. Generate the operator bearer and token key privately. Set these Worker secrets
   using the pinned Wrangler CLI from the repository root, entering the values
   at the prompts (or supplying stdin from the owner's private environment):

   ```sh
   bunx wrangler@4.158.0 secret put HOST_ADMIN_TOKEN -c _ops/p9/byok-p9-canary.wrangler.jsonc
   bunx wrangler@4.158.0 secret put BYOK_TOKEN_SECRET -c _ops/p9/byok-p9-canary.wrangler.jsonc
   bunx wrangler@4.158.0 secret put BYOK_CANARY_STORAGE -c _ops/p9/byok-p9-canary.wrangler.jsonc
   ```

   `BYOK_TOKEN_SECRET` must be 32 random bytes encoded as exactly 64 lowercase hex
   characters. `HOST_ADMIN_TOKEN` must be a high-entropy operator-only bearer.
   `BYOK_CANARY_STORAGE` is a JSON object with `endpoint`, `bucket`, `region`,
   `accessKeyId`, and `secretAccessKey`; for R2 use the account's HTTPS S3 endpoint
   and region `auto`. Never put these secrets in Wrangler vars, tracked files,
   command arguments, or device-runner output. Missing operator configuration
   refuses admin calls; a missing or malformed signing key returns 503 before
   either admin RPC or `/byok/*` can run. Deploy only after secrets are set:

   ```sh
   bunx wrangler@4.158.0 deploy -c _ops/p9/byok-p9-canary.wrangler.jsonc
   ```

4. On mini-cf only, capture all Worker tail events into the private file below.
   Keep the tail open while the W1 driver runs. Do not copy or stream the raw
   tail to the physical devices:

   ```sh
   bunx wrangler@4.158.0 tail byok-p9-canary --format json > _ops/p9/canary-tail.jsonl
   ```

   Observer records contain only envelope type, task id and a payload SHA-256;
   they contain no payload text or credentials. They replace the fixture's module
   array and `/probe/observed`. Fixed error diagnostics also omit request content
   and connection strings. Keep the raw tail private, including request metadata.
5. On mini-cf only, load the following variables from mode-600 ignored
   `_ops/p9/p9.env`. Do not pass the DSN or secrets on argv or send this file
   to mac-pro or win-ci:

   | Variable | Required value |
   | --- | --- |
   | `BYOK_CANARY_BASE_URL` | HTTPS origin of `byok-p9-canary`, without a path/query/credentials |
   | `BYOK_CANARY_POSTGRES_URL` | Direct DSN for the same isolated schema as Hyperdrive |
   | `HOST_ADMIN_TOKEN` | Same operator bearer as the Worker secret |
   | `BYOK_CANARY_STORAGE` | Same S3 JSON configuration as the Worker secret |
   | `BYOK_CANARY_TAIL_FILE` | Absolute path to the live private tail capture |

   Then run on mini-cf from the repository root (export the private file's values
   in the operator shell first):

   ```sh
   bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test \
     src/sealed-zero-hit.test.ts -t 'owner-configured HTTPS canary'
   ```

   On Linux use the Secret Service wrapper described above. The remote case is
   skipped unless `BYOK_CANARY_BASE_URL` is set; it is independent of the local
   dataplane opt-ins. An incomplete remote configuration fails closed before any
   remote request. The existing local command continues to use loopback only.
   No real configuration is read from tracked files.

The deployed probe runs a sealed task and plaintext twin, checks device input and
member terminal decryption, scans every tenant table/column and every bucket
object with the shared S0 scanner, and scans captured Worker and Node console
output for sealed content. The twin must appear in `outbox.body` and an object.
Tail observation of both terminal completions is required; the driver reports only
counts, a member content hash and the ciphertext inventory diff. It scans the
sealed offer, steer, progress, approval and terminal ciphertext in every tenant
column and object, normalizes object locations with the shared scanner, and
compares the measured locations with the `hosted-sealed-inventory` block in
`docs/security.md`. Every ciphertext location must also hold the plaintext twin's
canary. Missing or unexpected locations fail with the diff; success requires
`{ "missing": [], "unexpected": [] }`. Observer logs retain only metadata and
digests, so no raw observer payload is needed for this store/object inventory.
Physical-device sealed execution and browser evidence remain separate acceptance
work under #654; the W1 result is **operator-machine daemon (mini-cf)**.
