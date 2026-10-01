# WP3 — ordinary RPC FFF implementation

Status: source frozen; scoped implementation and targeted native verification PASS. Canonical whole-repository verification and release-pack belong to the parent / WP4 and have not been claimed here.

## P1: implementation boundary

- `packages/client/package.json` / `bun.lock`: exact `@ff-labs/pi-fff`, `@ff-labs/fff-node`, `@ff-labs/fff-bun` at 0.11.0 and `@sinclair/typebox` at 0.34.41. `pi-tui` stays transitive under the existing official Pi 0.99.1 closure / root override, not a new direct dependency.
- `pi-extension-factories.js/.d.ts`: static released TS export, visible to the bundler without dragging upstream's strict source-typecheck errors into SDK TypeScript.
- Both tsup configurations bundle `pi-fff` and leave the native SDK wrappers external. `tsup.config.ts` also builds a private `dist/adapters/pi/fff-extension.js` artifact; no new package export/public API is added.
- `fff-extension.ts`: public ExtensionAPI composition, SDK-owned mode/config/history view, per-instance ephemeral DBs and shutdown drain. `pi-rpc-host.ts:162` installs it only when a frozen FFF name survives the already-verified registry projection.
- Prepared tool registration, compiler, implementation-identity, permission mapping / readonly list, docs, release-pack script, shipping and workflow ownership remain untouched by this worker.

Why both native wrappers are direct dependencies: after bundling the extension, its literal dynamic imports resolve from client dist rather than pi-fff's package directory. Bun's isolated node_modules does not expose pi-fff's transitive wrappers there. Both packages are JavaScript/TypeScript FFI wrappers with no shipped `.node` or install script; native platform binaries and ffi-rs remain transitive runtime dependencies. This preserves the existing direct-dependency purity check and adds no identity attestation claim.

## P2: exercised path

Verified policy flags -> optional ordinary-host factory -> released synchronous TS factory under a briefly redirected documented config env -> fixed getFlag values -> per-FFF readonly history view -> actual Pi 0.99.1 registry -> actual native find/grep -> public AgentSessionRuntime.dispose -> await active FFF operations -> upstream teardown -> DB removal.

Real-fixture tests live in `packages/client/src/__tests__/pi-fff.test.ts`. Each child process executes the built SDK factory and real npm/native packages, avoiding source-only imports and environment contamination of the Vitest worker.

Coverage:

- Real filename fuzzy query and content token; ignored-file negative search; external absolute directory searched by both FFF and native Pi tools.
- Malformed user global JSON, poisoned env, multi-grep env and historical override cannot change fixed two-tool registration; real historical entry stays intact; explicit builtin grep/find schemas stay intact.
- Default admission, explicit FFF grants, deny wins, all-tools disabled, empty allowlist and unchanged readonly tool projection. Denied/empty/readonly do not even install the FFF factory or allocate DBs.
- Two actual native sessions with separate LMDB directories; parallel search, shutdown while an auxiliary search is pending, another session continues, post-shutdown search rejects.
- Before-bind registration removes config temp storage immediately and allocates no DB. Plain session.dispose on this unbound path matches initial-model admission failure's cleanup timing.
- Real incomplete install negative control: copy the released fff-node and fff-bun wrappers without their optional native platform packages; no finder stub or source patch. Binding reports `FFF init failed:` containing `fff native library not found`; tool execution rejects with the same missing-library reason; public runtime.dispose removes its owned DB directory.

## P3: chosen invariant and limitation

Keep Pi as the tool-authorization authority. The SDK facade only freezes upstream configuration and names and removes historical FFF mode entries from FFF's own readonly context. Only the synchronous pinned factory call temporarily redirects `PI_CODING_AGENT_DIR` / multi-grep env; exact prior values are restored in finally without any await. Every later config value comes from fixed public getFlag responses. User Pi files and stored session history are never rewritten.

Data directories are created lazily on startup and isolated per factory registration. Tracking awaits public event/tool promises before upstream shutdown, preventing an in-flight native finder from appearing after teardown. It does not create a shared indexing service or a new filesystem confinement policy. At 10x sessions, duplicated indexing and temporary DB usage remain the first cost; cross-session ranking persistence is intentionally absent.

## Commands and actual exit codes

Logs: `/tmp/byok-fff-wp3-logs/`.

| Command / cwd | Result |
| --- | --- |
| `bun install` / worktree root | exit 0; final install includes the four exact dependency additions |
| Workspace prerequisite builds for protocol/core/implementation-identity, then cloud, testkit, server | all final builds exit 0; ignored dist only |
| `bun run build` / packages/client | exit 0; sealed build preserved all 64 existing dist digests; user-schema compiler subgraph excluded; adapter / agent-memory entry gates passed |
| `bun run typecheck` / packages/client | exit 0; SDK source and vendor checks |
| fresh short TMPDIR + `bun run test -- src/__tests__/pi-fff.test.ts src/__tests__/pi-rpc-host.test.ts src/__tests__/pi-permission-mapping.test.ts` / packages/client | exit 0; 3 files, 29 tests passed; actual child interpreter Node 26.10.0 |
| `/tmp/byok-fff-node22/node_modules/node/bin/node --version` | exit 0; `v22.22.0` |
| fresh short TMPDIR + `/tmp/byok-fff-node22/node_modules/node/bin/node ../../node_modules/vitest/vitest.mjs run src/__tests__/pi-fff.test.ts` / packages/client | exit 0; all four native probes passed with child process.execPath inherited from actual Node 22.22.0 interpreter |
| same Node 22.22.0 command with `-t 'allocates no DB'`, after strengthening the missing-library assertion | exit 0; the exact `fff native library not found` negative control passed |
| `git diff --check` / worktree root | exit 0 |

Observed native targets: macOS / arm64 / Node 26.10.0 and Node 22.22.0. No Linux/Windows/native Bun claim is made by these Node-based probes.

Resolved development failures are retained as limits on earlier evidence: initial client typecheck was red because the fresh worktree lacked workspace dist declarations; a server prerequisite build first lacked testkit dist; an attempted direct pi-tui dependency violated the existing explicit gate and was removed; early failure-test UI was a Proxy with no own enumerable notify method, so Pi's UI object-spread dropped it (`ctx.ui.notify is not a function`). The fixture now owns notify/setStatus methods; no production behavior was changed to satisfy that assertion.

## Parent / acceptance handoff

Production source and tests are frozen. Parent should run canonical required build/typecheck/test/API/version/workflow and release-pack on a clean exact candidate with fresh short TMPDIR. The release-pack owner can import installed `dist/adapters/pi/fff-extension.js` and call `createByokFffExtension()`; public `AgentSessionRuntime.dispose()` must own shutdown. This worker has not committed, pushed, merged, published, edited the release-pack script, or asserted full acceptance.
