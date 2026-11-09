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
   is already relative to that destination. Run
   `bun examples/hosted-bot-collaboration-worker/build-member.mjs` before deploying
   to produce the secret-free static assets under `_ops/p9/member-assets` using
   Bun's existing bundler. The template binds that directory as `ASSETS` and runs
   the Worker first for every route. Fill only the canary Hyperdrive id.
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

Browser member page (W4)

The deployable entry serves `/member` and `/member.js` publicly. These two static
assets carry no deployment values or secrets and open no database connection.
The page asks the owner to type `HOST_ADMIN_TOKEN` at run time, clears the input
after key creation, and keeps the bearer only in the tab's memory. API requests
carry it in the Authorization header, never a URL or cookie. No localStorage,
sessionStorage or private-key export is used. Public assets allow direct browser
navigation without putting the operator bearer in browser history. All control
plane calls, including `/member/ciphertext`, retain operator authentication.
The page restricts connections and scripts to its own origin, disables framing,
and requests no caching or referrer transmission.

1. Build the workspace and page assets as above. Deploy only during the separately
   approved staging window. For local workerd, use a private Wrangler config with
   the same asset binding and local Hyperdrive connection as the deployable entry.
   Open `/member` on that origin. The local fixture `worker.ts` has no member page.
2. On the operator machine, provision an isolated tenant's quota in the same
   schema, using `core.quota.writeEntitlement` as the W1 driver does. Enter that
   tenant and product ID, then create browser keys. Both P-256 private keys are
   WebCrypto non-extractable keys and remain in memory; public bundles alone are
   shown for copying. The library's scope-key byte arrays exist temporarily in
   memory, are never sent unwrapped, and are zeroed after use. Reloading loses
   membership keys: use a fresh tenant or approve a fresh member from another tab.
3. Start the fresh tenant. Give the displayed `<pairingCode>.<pv>` input to the
   device privately. The verification secret never goes to the Host. Use W2b's
   E2EE pairing and local comparison flow, then enter its device ID. Verify its
   MAC, compare all 50 digits on both screens, check the comparison box and confirm
   the device. The page signs `add(device)` and relays the authenticated client
   MAC. Never copy pairing inputs or comparison codes into acceptance evidence.
4. To add another browser, create keys in another tab with the same tenant. Copy
   its public bundle into the active tab, and the active tab's bundle into the
   new tab. Show and compare codes on both screens. Approve from the active tab,
   then join from the new one. The new tab pins the approver's signing key and
   verifies its `add(self)` anchor and the full chain. The first tab creates the
   genesis `add(self)`; later browsers require an existing member's signature.
5. Issue scope keys once from an active tab, starting at epoch 1. This signs the
   C1/C3 scope policy and wraps the fresh scope key separately to each current
   member. Wait for the device to advertise sealed-payload support. In the page,
   paste a fresh Agent execution routing template as `{ "deviceId": "...",
   "payload": { ... } }`, omitting `instruction`, `sealing`, and `sealed`.
   The payload needs `runtime`, `session: { "mode": "fresh" }`, `agentRef`,
   `egressPolicy`, and `terminalProjection`. Use the same result-document contract
   as `examples/host-execution-core/src/test-support.ts#template`, with required
   string field `text`; no provider call is needed. W2b's opt-in `--runtime stub
   --stub-canary` must echo the decrypted instruction into `document.text` and
   print its exact UTF-8 SHA-256. The normal manual stub does not echo it.
6. Submit from the page. It generates a random canary privately, seals C1 using
   `@byok-sdk/core/sealed-payload`, and calls the existing
   `submitSealedAgentExecution`. It reports only task ID and expected canary hash.
   When the device completes, decrypt C3. The page reads the original offer's
   binding and the terminal from the Host, verifies the current chain and scope
   key package, opens inline or referenced ciphertext, and compares the hash of
   decrypted `document.text`. Referenced ciphertext is fetched from an
   authenticated route that derives its blob reference from that tenant/task's
   terminal; callers cannot supply a blob ID or URL. Its content hash is checked
   before opening. The page and console report PASS plus hash, chain length and
   browser user agent; failures report FAIL and a fixed reason, never plaintext.
   Copy only task ID and expected hash to other admitted tabs and compare with the
   device's hash. W1's separate driver creates its own Node member and tenant;
   its result is not this browser's acceptance evidence.
7. Remove one browser member from an active tab. From a remaining member, issue
   a fresh scope epoch and submit another task. The removed tab must report
   `FAIL` / `member_revoked` when asked to decrypt the new task; remaining tabs
   must report PASS with matching hashes. Record this separately for each engine.
   Old epoch knowledge cannot be recalled: the new task must use the new epoch.

Local page-logic coverage needs no credentials, Docker or browser installation:

```sh
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test src/browser-member.test.ts
```

These tests exercise the page's fetch/JSON transport, real in-memory cloud member
stores and WebCrypto, both pairing MACs, genesis and subsequent browser admission,
C1 submission, C3 inline/object opening, hash integrity, and post-removal refusal
with another tab still decrypting. They are Node evidence. They do not execute a
browser DOM or a deployed daemon; the physical-device and three-engine member
rows remain for the owner's staging window. W3 owns the separate vector runner.

