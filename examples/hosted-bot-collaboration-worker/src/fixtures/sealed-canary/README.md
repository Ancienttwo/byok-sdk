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
The driver runs a real daemon and Node member on the machine executing the command,
with a scripted runtime and OS credential custody. Run it on each approved physical
device to collect separate results. It does not use the W2 remote device runner.

1. Build the workspace with `bun run build`. Prepare a disposable Postgres schema,
   a role whose database-scoped `search_path` selects that schema, and an existing
   bucket used only for this canary. Apply the SDK migrations from Node with
   `DATABASE_URL` in the environment using `deploy/scripts/migrate`. The driver
   provisions a new tenant's quota through the direct DSN, but does not migrate,
   create or delete a bucket, create a Hyperdrive config, or drop schemas. It leaves
   tenant rows and objects for owner teardown. The Worker Hyperdrive origin and the
   direct scan DSN must select the same schema; its S3 secret and the driver's S3
   config must name the same bucket.
2. Copy `wrangler.deployable.template.jsonc` to
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

4. Capture all Worker tail events into a private file on the machine running the
   driver. Keep the tail open while the driver runs; if the operator is on another
   machine, privately stream that capture to the driver's machine first:

   ```sh
   bunx wrangler@4.158.0 tail byok-p9-canary --format json > _ops/p9/canary-tail.jsonl
   ```

   Observer records contain only envelope type, task id and a payload SHA-256;
   they contain no payload text or credentials. They replace the fixture's module
   array and `/probe/observed`. Fixed error diagnostics also omit request content
   and connection strings. Keep the raw tail private, including request metadata.
5. Load the following variables from an owner-managed environment or a mode-600
   ignored `_ops/p9/p9.env` file. Do not pass the DSN or secrets on argv:

   | Variable | Required value |
   | --- | --- |
   | `BYOK_CANARY_BASE_URL` | HTTPS origin of `byok-p9-canary`, without a path/query/credentials |
   | `BYOK_CANARY_POSTGRES_URL` | Direct DSN for the same isolated schema as Hyperdrive |
   | `HOST_ADMIN_TOKEN` | Same operator bearer as the Worker secret |
   | `BYOK_CANARY_STORAGE` | Same S3 JSON configuration as the Worker secret |
   | `BYOK_CANARY_TAIL_FILE` | Absolute path to the live private tail capture |

   Then run on the device from the repository root:

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
Tail observation of both tasks is required; the driver reports only counts and a
member content hash. The safe observer intentionally retains no raw payload, so
this probe does not reproduce the local suite's raw-observer ciphertext inventory
comparison. The broader deployed inventory diff, W2 cross-device coordination and
browser matrix remain separate owner-run acceptance evidence under #654.
