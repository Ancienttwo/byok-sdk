# Implementation Notes: pi-087-official-migration

> **Status**: Active
> **Plan**: plans/plan-20260925-0331-pi-087-official-migration.md
> **Contract**: tasks/contracts/20260925-0331-pi-087-official-migration.contract.md
> **Review**: tasks/reviews/20260925-0331-pi-087-official-migration.review.md
> **Last Updated**: 2026-09-25 03:31
> **Lifecycle**: notes

## Design Decisions

- ...

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## WP6 — U1 upstream candidate (done 2026-09-25)

- Pi repo worktree `/Users/kito/Projects/pi-wt-087-u1`, branch `claude/u1-export-build-request-payload`, one commit `bd6e562b6` on top of `v0.87.1` (f07218c4d); 2 files, +587/−32; no attribution trailers; not pushed. Opening the upstream PR is an Owner action.
- Export: `buildRequestPayload(model, context: TranscriptContext, options?: SimpleStreamOptions)` at `packages/ai/src/api/openai-completions.ts:355`; `stream()`/`streamSimple()` consume the same helpers (single construction path). Generic naming; no BYOK vocabulary.
- Verification (orchestrator, logs under `/private/tmp/h5-salesko-prep-20260923/pi087-logs/u1-*.log`): focused test 26/26; after `npm run hydrate:model-data` (exit 0, public catalog download), full `packages/ai` suite 1132 passed / 1 failed / 859 skipped, `tsgo --noEmit` exit 0 with zero errors. The one failure (`test/github-copilot-anthropic.test.ts` › Copilot adaptive thinking effort overrides) reproduces on stock `v0.87.1` with the same hydrated catalog — catalog drift upstream, unrelated to U1, report-only.
- Pre-commit hook was bypassed by the worker (`--no-verify`) because `npm run check` fails on stock v0.87.1 without the catalog; every other hook step passed individually. With the catalog hydrated the hook's `tsgo` step now passes.

## WP0 breakage map

Subject: worktree `claude/pi-087-migration` on 18d897ce (base origin/main 3dd7ba6f), uncommitted. bun 1.4.2.

Dependency switch (`packages/client/package.json`): `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` aliases `npm:@byok-sdk/pi-*@0.86.1001` → exact `0.87.1`; `byok.piRuntimePin` → `0.87.1` (it must exactly project the coding-agent dependency, `check-adapters-entry.mjs:46`); `@earendil-works/pi-agent-core: "0.87.1"` added as an exact direct dependency. Reason for the last one: after the first `bun install` the lockfile still resolved top-level `@earendil-works/pi-agent-core` to `@byok-sdk/pi-agent-core@0.86.1001` (plus its nested fork `pi-ai`), because `pi-subagents@0.60.0` declares an optional `*` peer on it and bun kept the stale locked entry. With the exact pin, `grep -c byok-sdk/pi- bun.lock` = 0.

### (a) Installed `@earendil-works/*` set

| Package | Version | How pinned | Lockfile integrity | gitHead (registry packument) | npm attestation |
|---|---|---|---|---|---|
| pi-coding-agent | 0.87.1 | exact direct | sha512-m8ArJUtVcQMSe1lLE/Ei7vX/JV7O39sWmWBsXV2NOU70F0qCp8GubA24pT3LnwTmM6LL2xV80/h6sQg85n69ew== | f07218c4d4bbc12bef056a7058c3dd49dfe41abe | yes |
| pi-ai | 0.87.1 | exact direct (coding-agent/agent-core ask `^0.87.1`) | sha512-X/3PfQBnnoeVdO9Cv8zHghUMglzlgNZYGNzoPnbRoGnHl3Rw3TlA2UKSUB7BRHUOxMryHXYa8dnjWZlbRheDZA== | f07218c4… | yes |
| pi-agent-core | 0.87.1 | exact direct (coding-agent asks `^0.87.1`) | sha512-Zev3B0HK7YS5A4EZQ2XnEqiJuirx6QBiltJ+LpmjV5a/+2IU0cfKtIfnkNkORK707XOvKBY2WRtk7cAwHpbh2Q== | f07218c4… | yes |
| chord | 0.87.1 | `^0.87.1` range (coding-agent, agent-core) | sha512-bg7IkJGFcEaMqqYgOGUiq5Ky9RghpRfrlZ8I/v/1b4bBZ02A7t3E+6uhPRbadwWb/kWsnVFbZsqOKRN4a3LLCg== | f07218c4… | yes |
| pi-telemetry | 0.87.1 | `^0.87.1` range (pi-ai, agent-core) | sha512-MC6TRQH5lgMXpcN+Vku2WMI2T8BsiUPzMQHGo81uqFZD3/9O79WWJAysEDGuzduP6R4tvtgwMLwmqIxynM10JQ== | f07218c4… | yes |
| pi-tui (nested under coding-agent) | 0.87.1 | `^0.87.1` range (coding-agent) | sha512-YEH2vRyOeiO7hhN6j6AE6YwKSq2Kz2f3XR8bj1TbR+aGE/JsnY1hLPMI2pvaZfRM1n9Y00tejxFQ4zbzvF7nkQ== | f07218c4… | yes |
| pi-tui (top level) | 0.85.1 | pre-existing lock entry; optional `*` peer of pi-web-access / pi-subagents / rpiv-i18n; not in the coding-agent closure; unchanged by WP0 | sha512-OIzw9efInmO4WOBnD4TxcTdBjmzvYJpzslkgoUro946nEGoYWg5rwv1p4fDt3/JvMx9QybryUCUwlm7j8Dreig== | not checked | not checked |

- Installed `package.json` files carry no `gitHead` field. The gitHead and attestation columns come from the npm registry packuments cached by OP0 (`/private/tmp/h5-salesko-prep-20260923/op0-codex/npm-cache`), read offline; the version integrity in those packuments equals the bun.lock integrity for every 0.87.1 row.
- `pi-coding-agent/npm-shrinkwrap.json` lists all five siblings (`chord`, `pi-agent-core`, `pi-ai`, `pi-telemetry`, `pi-tui`, each 0.87.1) with no `integrity` field. bun ignores the shrinkwrap; only bun.lock carries their integrity. Pinning the three range-resolved siblings (`chord`, `pi-telemetry`, nested `pi-tui`) is WP4.
- `node_modules/.bun` still holds orphaned store directories `chord@0.86.1` and `pi-telemetry@0.86.1`. They are not in bun.lock.

### (b) `bun run typecheck` (exit 1). Every package except `@byok-sdk/client` and `@byok-sdk/example-packaging` passes. 28 errors, all in client:

Fork-only subpath imports (TS2307), which are the WP2/WP3 surface:

| File:line | Subpath | Symbols |
|---|---|---|
| src/adapters/pi/input-preparation.ts:5 | prepared-session-input | `PreparedSessionInputV3` (type) |
| src/adapters/pi/input-preparation.ts:9 | input-preparation | `CodingAgentInputSnapshot`, `HostCanonicalAssistantMessage` (types) |
| src/adapters/pi/input-preparation.ts:77, :85 | prepared-session-input | `prepareCodingAgentSessionInput`, `preparedToolProjection` (lazy dynamic import) |
| src/adapters/pi/input-preparation.ts:697, :703 | prepared-session-input | `canonicalPreparedValue` (lazy dynamic import) |
| src/daemon/input-preparation-service.ts:45 | rpc-types | `fitsRpcFrame`, `rpcFrameByteLength`, `RPC_MAX_FRAME_BYTES` |
| src/__tests__/input-preparation-message-support-set.test.ts:3 | input-preparation | `HostCanonicalAssistantMessage` |
| src/__tests__/input-preparation-model-parity.test.ts:727 | prepared-session-input | `verifyPreparedSessionInput`, `PreparedSessionError` |
| src/__tests__/input-preparation-model-parity.test.ts:757 | prepared-session-input | `canonicalPreparedValue` |
| src/__tests__/input-preparation.test.ts:42 | rpc-types | `rpcFrameByteLength`, `RPC_MAX_FRAME_BYTES` |
| src/__tests__/mcp-projection.test.ts:6 | prepared-session-input | `canonicalPreparedValue` |
| src/__tests__/pi-prepared-launcher.test.ts:56 | prepared-session-input | `canonicalPreparedValue` |
| src/__tests__/prepared-prompt-frame.test.ts:10 | rpc-types | `fitsRpcFrame`, `rpcFrameByteLength`, `RPC_MAX_FRAME_BYTES` |

tsc does not check these, but they break at runtime: `src/__tests__/fixtures/pi-compile-purity-probe.mjs:774` (`prepared-session-input`), `scripts/check-adapters-entry.mjs:141` (`prepared-session-input`) and `src/__tests__/dist-subpath-closure.test.ts:294` (expects the `rpc-types` specifier in dist).

Root-export break: `src/bin/pi-prepared-host.ts:10` imports `createPreparedAgentSession`, which the official root does not export (TS2724).

Build cascade (not a Pi API break): client `dist/*.d.ts` was never emitted because `bun run build` stops before `tsc -p tsconfig.build.json`. That leaves TS7016 at `src/bin/byok-agent.ts:177`, `src/bin/byok-pi-prepared.ts:13`, `src/bin/byok-pi-rpc.ts:13`, `src/bin/pi-rpc-host.ts:151`, `src/bin/sdk-reserved-helper-runners.ts:131,134`, `src/custody/pi-subagent-print-payload.ts:17` and `src/custody/pi-subagent-runner-payload.ts:29` (`#byok-pi-runtime-host` / `#byok-pi-todo-runtime`), plus `src/__tests__/sdk-reserved-helper-host.test.ts:2,3` and `src/__tests__/recurring-integration.test.ts:8,90`, and `examples/packaging/launcher.ts:51` (`@byok-sdk/client`). `tsc -p tsconfig.vendor.json` passes on its own (exit 0).

### (c) Official root-export symbols the SDK uses

From the `@earendil-works/pi-coding-agent` root the SDK uses 24 symbols. 23 are present in 0.87.1 and typecheck against 0.87.1 types: createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ToolDefinition, getDocsPath, getExamplesPath, getReadmePath, ModelRuntime, ExtensionAPI, ExtensionFactory, ExtensionUIContext, createAgentSessionRuntime, createAgentSessionServices, getAgentDir, resolveCliModel, runPrintMode, AgentSessionRuntime, runRpcMode, AgentSessionServices, CreateAgentSessionOptions, CreateAgentSessionRuntimeFactory, VERSION. The one that vanished is `createPreparedAgentSession` (fork only). From the `@earendil-works/pi-ai` root the SDK uses only `StringEnum`, which is present. No SDK source assigns `agent.state.messages`; OP0 flagged the 0.87 change there.

The official root exports are `.`, `./rpc-entry`, `./client` and `./experimental/plugin` for coding-agent, and `.`, `./compat`, `./providers/*`, `./api/*`, `./utils/*`, `./oauth`, `./bedrock-provider` and `./bun-oauth` for pi-ai. `InMemoryCredentialStore`, `normalizeContext` and `Type` are pi-ai root exports, not coding-agent root exports.

Other fork-identity consumers that will fail or need rework, left to WP2/WP4 and not touched here: `packages/client/scripts/check-adapters-entry.mjs:55-60,78-81` (asserts the installed manifest name is `@byok-sdk/pi-coding-agent`, requires `byokFork`, and requires the pi-ai pin to equal the fork's declared pi-ai edge, which is now `^0.87.1`); `packages/client/scripts/build-pi-export-assets.mjs:12-14`; `src/adapters/pi/pi-export-assets.source.json` (`@byok-sdk/pi-coding-agent@0.86.1001`; `template.js` drifted from 76742 to 77102 bytes, the other 4 of 5 assets match); `src/adapters/pi/native-installation.ts`; `scripts/release/pi-runtime-identity.mjs`; the release tests `scripts/release/pack-and-smoke.test.mjs`, `scripts/release/beta-release.test.mjs` and `scripts/api-surface/check-version-authority.test.mjs`; and 19 client test files that name the fork.

### (d) `bun run build` (exit 1)

Every package builds except `@byok-sdk/client`. In the client, tsup and `check-adapters-entry.mjs --build-todo` pass. It then stops at `scripts/build-todo-assets.mjs:38` with `third-party build input drift`: the pinned input path `@byok-sdk/pi-ai@0.86.1001/dist/utils/typebox-helpers.js` is now `@earendil-works/pi-ai@0.87.1/dist/utils/typebox-helpers.js`, with the same sha256 f423ce8a…. The steps after it never ran. Run standalone, `build-pi-export-assets.mjs` fails at :12 (`piRuntimePin` must equal `npm:@byok-sdk/pi-coding-agent@0.86.1001`). `build-sealed-host.mjs` and the final `check-adapters-entry.mjs` cannot be judged standalone, because they fail on the partially built dist.

## WP1 — official 0.87.1 conformance suite

Files: `packages/client/src/adapters/pi/__tests__/official-pi-fixture.ts` (shared fixture), `official-pi-conformance-compile.test.ts` covering (a) and (b), `official-pi-conformance-enforcement.test.ts` covering (c) through (f), and `packages/client/src/adapters/pi/host-history-admission.ts` (pure admission helper). They import only from the `@earendil-works/pi-coding-agent` root, the `@earendil-works/pi-ai` root and `@earendil-works/pi-ai/api/openai-completions`. Every test replaces `globalThis.fetch` with a spy that fails on any call. (d) is the only exception: its spy forwards calls to the sink host 127.0.0.1:9 and nothing else.

Official session discipline: `SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: 'off' })`. The key is `cacheWarming` (modes `off|streaming|idle`, default `streaming`). OP0 used `cacheWarmup`, which is not a settings key and was silently ignored. The resource loader turns off every discovery flag and sets an explicit `systemPrompt`. The `context_with_system` handler returns T plus the tail of the native messages after `[system, trigger]`.

Observed provider options handed to the registered `streamSimple`: `reasoning: "medium"`, `sessionId`, `maxRetries: 0`, `timeoutMs: 300000`, `transport: "auto"` and `apiKey`. There is no `cacheRetention` and no `maxTokens`. The gate wrapper therefore pins `cacheRetention: "none"`, so the live body cannot depend on `PI_CACHE_RETENTION`.

| Case | Status | Evidence |
|---|---|---|
| (a) | pass | D1 = 700 B, sha256 5703c2a7e70a57a7219d68ded009e727898e9c07d405687e67e8226e8ebe8384. Two compiles are identical, and the first gated body equals D1. The second gated body equals the A1' compile of T + the session's `message_end` assistant(toolCall) + toolResult: D2 = 959 B, sha256 aa1512a296a29bf0286afd13715db15c394c7db8898146be834ee25f7f55b614. The handler's second tail equals those same two messages. The tool ran once. |
| (b) | pass | Sentinel and same-model provenance give identical D (700 B, 5703c2a7…), and no sentinel string appears on the wire. `admitHostAssistantContent` refuses a `thinking` block as `host_assistant_block_not_text`, refuses a `toolCall` the same way, refuses a text block with an extra `textSignature` as `host_assistant_text_block_malformed` and refuses empty content. Text-only content passes. |
| (c) | pass | Drifted transcript: 1 gate call and 0 sends. `prompt()` resolves. The run-scoped `prepared_request_bytes_mismatch` reason (sequence, expected and observed sha, bytes) is present. After `waitForIdle()` plus 250 ms the gate count is still 1 and `maxRetries: 0` was passed. The last assistant has `stopReason: "error"`. |
| (d) | pass | Compile without `fetch`: the terminal error is `Connection error.`, there is no D, and the global spy saw only `http://127.0.0.1:9/v1/chat/completions`. |
| (e) | pass | Without an explicit `cacheRetention`, `PI_CACHE_RETENTION=long` gives 777 B (afa9b1ad…, adds `prompt_cache_key` = sessionId and `prompt_cache_retention: "24h"`) and `short` gives 700 B (5703c2a7…). With `cacheRetention: "none"` both give 700 B (5703c2a7…). |
| (f) | pass, with one caveat | With usage-absent SSE, the `message_end` assistant has all-zero usage and `stopReason: "stop"`. `mapPiMessageToAgentEvent` (`adapters/pi/events.ts`) maps it to `{ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }`. The classifier `observePreparedCall` (`daemon/task-runner.ts:332`) is module-private, so the test does not call it. Its rule is `prompt <= 0` → `usage_unavailable`, and `prepared-offer-lane.test.ts:726` already covers `inputTokens: 0` → `usage_unavailable` end to end. |

WP2 risk found while writing (a): `getCompat()` (`pi-ai/dist/api/openai-completions.js`, roughly :1225–1340) detects compat from `provider` and `baseUrl`. Examples are chutes.ai → `max_tokens`, deepseek.com, openrouter.ai, api.openai.com → `prompt_cache_key`, and Together → `supportsLongCacheRetention`. When A1' compiles against the sink baseUrl while the live model carries the real baseUrl, D matches only if every compat field that affects the body is pinned explicitly on the model (explicit `model.compat.X` overrides detection). The suite uses the sink on both sides, so it does not exercise this.

## WP3

### RPC frame bound

The service only SENDS frames. `daemon/input-preparation-service.ts:780-812` builds the `prompt_prepared` command with the launcher's own builder (`buildPreparedPromptCommand`) and refuses `rpc_frame_too_large` when `fitsRpcFrame(command)` is false. Nothing in the service reads peer JSONL, so no bounded reader was added. The constant and helpers now live in `packages/client/src/util/rpc-frame.ts`: `RPC_MAX_FRAME_BYTES = 8 MiB` (the fork's value), `rpcFrameByteLength` = UTF-8 bytes of `JSON.stringify(frame) + "\n"`, and `fitsRpcFrame`. The test is `src/util/__tests__/rpc-frame.test.ts`.

The SDK keeps refusing oversized frames. Official 0.87.1 `modes/rpc/jsonl.ts` reads stdin with no upper bound, so the host no longer refuses them. The limit protects the peer, and after the switch this send-side check is the only one. Nothing the SDK admitted before is refused now.

Consequences outside WP3 ownership:
- `src/__tests__/input-preparation.test.ts:42` and `src/__tests__/prepared-prompt-frame.test.ts:7-10` still import from `@earendil-works/pi-coding-agent/rpc-types`. Change both to `../util/rpc-frame`; the names are unchanged.
- The `rpc_frame_too_large` doc at `src/input-preparation.ts:1284-1287` still says the bound is the RUNTIME's. It is now the SDK's send-side bound.
- `adapters/pi/rpc-client.ts:240` reads the Pi process's stdout without a bound. That is the same choice the fork's reader made (session-bounded, not peer-controlled). WP2 owns it; unchanged.

### Build/pin scripts

- The script `build-todo-assets.mjs` was already correct; its frozen inventory was stale. `vendor/third-party-manifest.json` row `@byok-sdk/pi-ai@0.86.1001` → `@earendil-works/pi-ai@0.87.1`, with the same file and sha256 `f423ce8a…`. `licenseSource` is now "upstream repository LICENSE at v0.87.1 (f07218c4…); package declares MIT but omits license file". The official tarball ships no LICENSE, and the `licenseText` is byte-equal to `git show v0.87.1:LICENSE`. `vendor/THIRD-PARTY.md` has the matching heading rename. Sizes: manifest 114661 → 114765 B, THIRD-PARTY.md 8303 → 8306 B. The build then prints `sealed todo assets: 9 exact upstream files`.
- `build-pi-export-assets.mjs`: `piRuntimePin` must equal `source.packageVersion` (exact semver). The `byokFork` assertion is removed because identity is WP4's gate. **Blocked on a WP2-owned file**: `src/adapters/pi/pi-export-assets.source.json` needs `packageName` `@earendil-works/pi-coding-agent`, `packageVersion` `0.87.1`, `byokFork` removed, and `template.js` bytes 76742 → 77102 with sha256 `1893cdb7…` → `56270347d35faac17e3b79b16ac5d8dbab664e9c83cfbc05437a3f5976074d76`. The other four assets are unchanged. With exactly that JSON in a scratch root, the script passes (`5 pinned native assets verified`). `src/__tests__/pi-export-assets.test.ts:42` also needs `piRuntimePin: source.packageVersion`. Whether the orchestrator accepts the new golden is its call.
- `check-adapters-entry.mjs`: the fork identity asserts are replaced. The installed manifest name must be `@earendil-works/pi-coding-agent`, the pin must be an exact semver equal to the installed version, and `pi-ai` and `pi-agent-core` must be pinned and installed at that same version (upstream lockstep). The lazy-load probe now watches `@earendil-works/pi-ai/dist/api/openai-completions.js`, which is the A1' compile entry and statically loads `openai`. The pi-ai root and the coding-agent root load only `openai-completions.lazy.js`. Standalone it exits 0 with the new probe.
- Build progress: tsup ✓, `check-adapters-entry --build-todo` ✓, `build-todo-assets` ✓. It stops at `build-pi-export-assets.mjs:15` (the source JSON above). Run standalone after that: `build-sealed-host` exits 0; `tsc -p tsconfig.build.json` fails with 6 errors in `adapters/pi/input-preparation.ts` and 1 in `bin/pi-prepared-host.ts` (WP2); `check-adapters-entry` exits 0.

### Tests referencing fork subpaths

- `dist-subpath-closure.test.ts`: the root's static `@earendil-works/*` edge list is now `[]`, because the frame bound is SDK-owned. The pin-occurrence check now expects an exact-semver `piRuntimePin` line plus the single `PI_PACKAGE_NAME` line. It passes with 23 tests.
- `fixtures/pi-compile-purity-probe.mjs:774`: marked `TODO(WP2-entry)`. WP2 has not landed a compile entry; `input-preparation.ts` still imports `prepared-session-input`. Changing the path alone is not enough, because the probe calls `prepareCodingAgentSessionInput` with fork-shaped input and attributes origins to the coding-agent root. The load, the two compile calls, `nativeCompileInput` and `forkRoots` must move to WP2's entry (the pi-ai root) together.

### Fork mechanical audit

| Commit | What | Status | Evidence |
|---|---|---|---|
| `62cbbd87c` | bound the fork host's stdin JSONL reader; `RPC_MAX_FRAME_BYTES` plus the helpers | replaced-by-SDK (send side); reader bound needs-upstream if it is ever wanted | official `pi-coding-agent/dist/modes/rpc/jsonl.ts` has no bound; SDK `util/rpc-frame.ts` plus `input-preparation-service.ts:806` |
| `511995810` | recover the id of an oversized frame; RPC ids serialized first | moot-in-0.87.1 | the official host never emits `frame_too_large`, so there is no id to recover; the SDK refuses before sending |
| `e05af044f` | export the helpers via `./rpc-types` and the root | replaced-by-SDK | official exports are `.`, `./rpc-entry`, `./client`, `./experimental/plugin`; no SDK import of `rpc-types` remains in WP3 files |
| `365711677` | `@modelcontextprotocol/sdk` as a pi-ai prod dependency | moot-in-0.87.1 (for the SDK) | official pi-ai deps have no MCP SDK; `grep -rl modelcontextprotocol pi-ai/dist` = 0; `@google/genai@2.21.0` still has an optional peer `^1.25.2` and 1 hit in `genai.d.ts`, but root `tsconfig.json:13` has `skipLibCheck: true` and WP0 typecheck showed no TS2307 for it |
| `57128006e` | type-only JSON catalog imports in model shards | moot for the SDK; needs-upstream for strict consumers | official `providers/deepseek.models.d.ts` still has `import values from "./data/deepseek.json"`; the SDK uses `moduleResolution: Bundler` plus `skipLibCheck` |
| `97cbd5e2f` | narrow the `find` path module parameter | moot for the SDK; needs-upstream for strict consumers | official `core/tools/find.d.ts:7` still has `pathModule?: path.PlatformPath`; covered by `skipLibCheck` |
| `cd8e99782` | `@byok-sdk` publish projection tooling | moot | fork retired; no republish (plan Invariants) |
| `edfa2216b` | `docsPaths` required on the system-prompt builder (purity) | moot | plan invariant "No U2": the Host owns the whole system message, and the adapter never calls Pi's prompt builder |
| `8792344cf` | `HostCanonicalAssistantMessage` reader half | replaced-by-SDK (A2') | official types have no `host_canonical`; A2' sentinel `AssistantMessage` plus `adapters/pi/host-history-admission.ts` (WP1) |
