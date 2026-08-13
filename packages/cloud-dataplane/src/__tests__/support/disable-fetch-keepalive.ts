/**
 * Disables HTTP keep-alive for this test worker's `fetch`.
 *
 * The dataplane object suites drive a real MinIO over `globalThis.fetch` — the
 * grant redemptions in `object-suite.test.ts`, the conformance composition's
 * `landBlobBytes`, the R2 maintenance calls in `cleanup.test.ts`, and every
 * signed request the R2 stores make through their default `#fetch`. Node's
 * built-in `fetch` is undici, and undici keeps a POOL of idle keep-alive sockets
 * on a process-wide global dispatcher between requests.
 *
 * Those idle sockets are the CI flake. After the suites pass, an idle keep-alive
 * socket to MinIO sits in the pool until the job's `docker compose down -v` (or
 * MinIO's own idle timeout) resets it. undici raises `'error'` on that socket
 * with no in-flight request to attach it to, and it surfaces as a post-pass
 * `socket hang up` — undici's ECONNRESET-on-keep-alive signature, not pg's
 * `Connection terminated unexpectedly`. (The pg pools are already drained by
 * `dispose()` → `pool.end()`, which is why the flake is HTTP, not database.)
 *
 * Installing a dispatcher whose idle keep-alive timeout is effectively zero
 * closes each socket ~immediately after its response, so no idle socket ever
 * survives to be reset. This is process-wide, so it covers EVERY MinIO fetch —
 * including the conformance path through `createPostgresCloudStores`, which
 * exposes no per-client `fetch` seam — without touching product code.
 *
 * This is a vitest `setupFiles` module: it runs once in each test worker before
 * that worker's test files import, so the keep-alive-off dispatcher is in place
 * before the first request. A once-per-worker `afterAll` close was the other
 * option, but vitest has no clean once-per-worker teardown hook here (a setup
 * file's `afterAll` runs per file, and `globalSetup` runs in the MAIN process,
 * not the worker that owns the sockets) — so the setup-time swap is chosen
 * instead, and it needs no teardown timing to be correct.
 */
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }));
