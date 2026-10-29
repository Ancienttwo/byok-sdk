This is a **local test fixture**, not a deployable Host. Its unauthenticated
`/probe/*` control plane is available only through the loopback `wrangler dev`
instance created by `sealed-zero-hit.test-support.ts`.

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
