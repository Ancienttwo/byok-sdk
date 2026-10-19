# #514 GrokAdapter: architecture plan (optional, under the external Bot beta)

Status: plan only. No adapter code. Revision 3, 2026-10-19. Optional work.
Parent: [byok MCP server for external Bots (beta)](2026-10-19-byok-mcp-server-external-bot-beta.md).
Issue: [#514](https://github.com/Ancienttwo/byok-sdk/issues/514).
Baseline: byok-sdk `main@a6bb9d55`. OAR pin: `botiverse/oar` 0.67.0, commit `c264f17040dd9513b43300886a80f3f6eddde7b1` (the pin of the existing vendored fork).

## Product ruling and place of this plan

Aimpact, 2026-10-19, about 14:00 HKT. This ruling replaces all earlier Grok and Hermes instructions:

- The external Bot beta line is a byok MCP server. External Bots (Grok Bot, Hermes) connect to it as MCP clients. The MCP server exposes the existing byok Bot infrastructure as tools. Coding agents (Pi, Codex, Claude) do the work.
- Grok and Hermes are not made into `RuntimeAdapter`s as the main form. The main design is the parent beta document.
- The Grok CLI can still be connected as a side item. This plan describes that side item: `GrokAdapter` as one more coding-agent runtime, like Codex. It is optional and has no product priority.
- The Bot mode PRD (`docs/plans/2026-10-18-bot-mode-product-prd.md`) does not change. PRD §7 / Q4 and Q8 stay as they are. Earlier commits on this branch changed the PRD. Those changes are reverted.

Revision 2 of this plan (Grok as a Bot-mode runtime) is withdrawn. This revision returns to the revision 1 design (a coding-agent runtime) and drops the Q4 gate.

## Conclusion

OAR already ships a usable Grok Build runtime. It drives `grok agent --always-approve --no-leader stdio` over ACP JSON-RPC, and its docs and tests record live evidence up to Grok 1.0.52. The SDK must not build a second ACP stack.

The plan: extend the existing private OAR fork at `vendor/oar/c264f17` with the Grok runtime and its `shared/acp` closure. Apply BYOK deltas only at the seams that the Codex fork already maintains: process ownership, explicit environment, deadlines, record budget and interaction policy. The official `@agentclientprotocol/sdk` (exact pin `1.4.0`, the version in OAR's lockfile) owns the ACP wire. A new SDK `GrokAdapter` implements `RuntimeAdapter` around that runtime, as `CodexAdapter` wraps the vendored Codex session.

If the work goes ahead, a Grok CLI task reaches the adapter like any other coding-agent task, for example through the beta MCP server's dispatch tool. Grok is then one more worker runtime beside Pi, Codex and Claude.

## 1. Inventory (P1)

### 1.1 Method

- The local OAR checkout `/Users/chris/Projects/oar` is at `v0.29.0` (`f1a2b88e`, 2026-10-07). It does not contain `c264f17`. It is too old to be evidence for the vendored pin. This plan did not change that checkout.
- The pinned commit was read from a shallow clone in `/tmp/oar514` (`git fetch --depth 1 origin c264f17…`; `packages/oar/package.json` version `0.67.0`).
- The import closure was measured with a small script that follows relative imports from `runtimes/grok/session.ts` (`/tmp/oar514-scripts/closure-skip.mjs`).
- The ACP SDK type surface was read from the `@agentclientprotocol/sdk@1.4.0` tarball in `/tmp/acp-sdk-pkg`. Nothing from it was executed.
- Grok Build facts come from OAR `docs/runtimes/grok.md` at the pin and from the public `xai-org/grok-build` user guide (`HEAD 2bdd1d6a`, read through `gh api`).

### 1.2 (a) What OAR already supports for Grok

| Item | Location at `c264f17` | Fact |
| --- | --- | --- |
| Runtime profile | `packages/oar/src/runtimes/grok/` (11 files) | `session.ts` defines `grokAcpProfile` and `grokSession = acpSession(grokAcpProfile)`. Other files: `failure`, `options`, `spontaneous-usage`, `installation`, `install`, `update`, `list-models`, `account-usage`, `inventory`, `index`. |
| Shared ACP stack | `packages/oar/src/shared/acp/` (19 files, about 2,300 lines) | Opening, process, session controller, record placement, turn machinery, projection, terminal host, client app, MCP servers, model/effort, failure, usage. Runtime-neutral; Kimi, OpenCode and Antigravity use it too. |
| Launch | `grokAcpProfile.args` | `grok agent --always-approve --no-leader stdio`. `launchArgs` go before `stdio`. |
| Handshake | `shared/acp/profile.ts` | `initialize` (terminal client capability on, fs methods off, 15 s deadline), `authenticate` (`_meta.defaultAuthMethodId` or `cached_token`), `session/new` with `_meta.yoloMode: true`, optional `session/set_model` and `reasoning_effort`. |
| Resume | `profile.ts`, `runtimes/grok/session.ts` | `session/resume` by exact native id, no replay. `data.code === "FS_NOT_FOUND"` becomes `SessionNotFoundError`. Grok refuses a resume from another cwd. |
| Prompt, abort | `shared/acp/turns.ts` | One `session/prompt` RPC per turn. Its answer ends the turn (`turn_ended`, `usage`). `abort` sends `session/cancel`. After 10 s with no answer, OAR kills the process. |
| Steer | `grokAcpProfile.steerParams` | `_meta.sendNow`. Natively this cancels the running prompt and starts a new model turn. Interrupted tool calls run again under new ids. |
| Session MCP servers | `shared/acp/mcp-servers.ts` | ACP `mcpServers` on new and resume. Grok exposes them through its `use_tool` meta-tool. Credentials are redacted from records. |
| Reverse requests | `shared/acp/client-app.ts`, `terminal.ts` | OAR hosts `terminal/*` itself (spawns the shell line). Permission requests get `allow_always`, else `allow_once`, else `cancelled`. |
| Records | `shared/acp/records.ts` | Each ACP message is one kernel frame `{ type, native, events }`. Child sessions are recorded under their own id. |
| Refused options | `runtimes/grok/options.ts` | `additionalDirectories`, `serviceTier`, `name`, `disallowedTools`. |
| Docs | `docs/runtimes/grok.md` | Evidence baseline `grok-build bc7f02e` (1.0.12); wire snapshot 1.0.5; live battery 1.0.25; daily check 1.0.50 (2026-10-09); prompt-option probe 1.0.52 (2026-10-13). |
| Tests and fixtures | `tests/acp/*.test.ts`, `tests/fixtures/fake-acp-agent.mjs`, `fake-acp-grok.mjs`, `tests/replay/fixtures/grok-acp-v1.*` | A dependency-free fake ACP agent with recorded Grok 1.0.25 frames. |
| npm dependencies | `packages/oar/package.json` | `@agentclientprotocol/sdk ^1.4.0` (lock `1.4.0`, peer `zod ^3.25 || ^4`), `cross-spawn` (terminal host). |

Issue #514 claims are confirmed, with two corrections. The vendored fork is now `vendor/oar/c264f17` (0.67.0, re-vendored in `fef2939f`), not `beea52c` (0.66.0). The newest OAR evidence is Grok 1.0.52, not 1.0.50. The local machine has Grok 1.0.62 (`~/.grok/bin/grok -> grok-1.0.62`, read with `ls`, binary not run). No OAR evidence covers 1.0.62.

### 1.3 (b) What the SDK has already vendored

- `packages/client/vendor/oar/c264f17/`: 55 source files and LICENSE. 50 files keep upstream bytes. The current inventory lists five maintained files: `runtimes/codex/app-server-client.ts`, `runtimes/codex/open.ts`, `runtimes/codex/rpc-control.ts`, `runtimes/codex/session.ts`, `shared/session-kernel.ts` (`PROVENANCE.md`, "Maintained deltas").
- Selection: the Codex session closure plus `shared/executable/process-tree.ts`. "No Cursor, ACP, CLI, arena, executable manager, other runtime or branded resources are included."
- Not vendored on purpose: `shared/session-credentials.ts`, `shared/seal-session.ts`, `shared/environment.ts`, `shared/home-initialization.ts`, the executable manager.
- Bridge: `packages/client/src/runtime/codex-session-runtime.{js,d.ts}` exposes `codexSession(spawn, installation, options, timeout, hooks)`. `scripts/api-surface/oar-bridge-types.ts` checks the declaration against the vendored source.
- Process owner: `packages/client/src/runtime/owned-line-process.ts` (`createOwnedLineProcessSpawn`). It requires an explicit filtered env, bounds a line to 1 MiB and the registration buffer to 4 MiB, and adopts and disposes the process tree through `adapters/process-tree.ts`.
- Adapter: `packages/client/src/adapters/codex/codex-adapter.ts` (`CodexAdapter`, `CodexSession`) and `projection.ts` (`CodexProjection`, native frames to `AgentEvent`).
- Build: `packages/client/scripts/build-todo-assets.mjs` copies `oar/c264f17` provenance assets.

### 1.4 Closure measurement

| Closure from `runtimes/grok/session.ts` | Files | Notes |
| --- | --- | --- |
| Full upstream closure | 88 | Pulls in `seal-session`, `session-credentials`, `environment`, the executable manager and `observe/*`. |
| After removing the four modules the Codex fork already refuses (`session-credentials`, `environment`, `executable/index`, and through them `seal-session`) | 66 | 40 are already in `vendor/oar/c264f17`. 26 are new. |

The 26 new files: `contracts/runtime-failure-error.ts`; `runtimes/grok/{failure,options,session,spontaneous-usage}.ts`; `shared/acp/` (all 19 files); `shared/credential-redaction.ts`; `shared/held-input.ts`. The new external imports are `@agentclientprotocol/sdk` and `cross-spawn`. The BYOK deltas in §6 remove `cross-spawn`.

### 1.5 (c) The gap this plan fills

| Need from #514 | Present today | Gap |
| --- | --- | --- |
| ACP wire, handshake, turns, resume, MCP, records for Grok | OAR upstream only | Vendor selection does not include it |
| SDK-owned Grok process with timeout and tree cleanup | Codex path only (`owned-line-process.ts`) | ACP transport is not wired to the owned process; OAR terminal host spawns outside it |
| Explicit filtered env, no ambient merge | Codex fork deltas | `shared/acp/session.ts` calls `sessionEnvironment(options.env)` (ambient merge) |
| `RuntimeAdapter` with descriptor, `detect`, `prepare` for `grok` | None | New `adapters/grok/` |
| ACP frames to `AgentEvent` and the daemon closing reply | None | New `GrokProjection` |
| Qualification per `docs/adapter-capabilities.md` | Claude, Codex | Grok column, conformance runner entry, fake runtime |
| Memory-reader instruction loading | Codex uses `project_root_markers` | Grok loading rules differ (§7.3); unverified |

### 1.6 Decision record

- 2026-10-18: PRD §7 / Q4 "不做 grok ACP adapter". Issue #514 asks for the adapter.
- 2026-10-19, about 14:00 HKT: Aimpact's final ruling (above). The PRD keeps Q4 and Q8. This adapter is an optional coding-agent runtime under the external Bot beta line. It is not a Bot-mode runtime.

## 2. P2 trace: one chat turn on Grok (target path)

1. Downstream constructs `new GrokAdapter()` in its explicit adapter list. A dependency update alone enables nothing.
2. `task.offer` (or `task.offer_for_agent`) arrives with `dispatchSelection { lane: 'subscription', runtimeId: 'grok', modelId? }`. The daemon calls `GrokAdapter.prepare(input)`.
3. `prepare` checks the selection and `detect()`. It returns a prepared operation. It spawns nothing long-lived.
4. The daemon seals the manifest (`cwd`, `homeAccess`, `sessionRef`, toolsets) and calls `operation.start(input)`.
5. `start` builds `SessionOptions` and calls the vendored `grokSession` through the bridge with an injected owned spawn.
6. The fork spawns `grok agent --always-approve --no-leader stdio` through `createOwnedLineProcessSpawn`. The ACP SDK client connects over a message stream built on that line process.
7. Handshake: `initialize`, `authenticate`, `session/new` or `session/resume`, optional `session/set_model`. The native session id becomes `Session.sessionRef`.
8. `GrokSession.prompt(instruction)` sends `session/prompt`. Grok streams `session/update` and `_x.ai/*` frames. Each becomes a kernel record. `onRecord` hands it to `GrokProjection`.
9. The projection emits `progress`, `tool_use`, `tool_result`, `usage` and `turn_end`. The daemon accumulates `progress` into the closing reply (`task-runner.ts:4076` resets it per message when `progressEventsAreMessages` is true).
10. On `turn_end`, the daemon authors the reply and sends `agent.message.publish` for a `messageEgress` task. Grok does not need to call `send_agent_message`.
11. `close()` disposes the raw session (cancel if active, `session/close` with 2 s deadline, kill), then the owned process tree, then the scratch.

## 3. P3 decision

- Why the current design exists: the Codex fork follows upstream and keeps a delta only where the SDK must own the process, environment, deadlines, record budget or interaction policy (`PROVENANCE.md`). ADR-037 sets YOLO defaults and defers guardrails to the local agent.
- Core invariant to keep: the SDK owns every process it starts, passes an explicit env, bounds every wait and every retained byte, and never invents a permissive answer.
- Smallest coherent change: one more selection in the same fork at the same pin, plus one adapter. No new protocol code. No new abstraction in the SDK. `shared/acp` stays runtime-neutral upstream code, so a later ACP adapter (for example #519 Hermes) can add a profile. This plan does not design that adapter.
- Rejected: (1) a hand-written ACP client in the SDK (duplicates upstream and the official ACP SDK); (2) OAR as an npm dependency (brings the executable manager, ambient env merge and Pi/Cursor deps that the fork removed); (3) a separate pin for the Grok selection (two OAR bases for one shared kernel).

## 4. Goals and non-goals

Goals:

- Export `GrokAdapter` from `@byok-sdk/client` (`adapters/index.ts`).
- `detect` finds the `grok` binary, its ACP mode and an auth signal. It does not touch the Agent home and does not write Grok's home.
- `prepare`/`start` run one ACP session per operation. The SDK owns the process, its timeouts and tree cleanup, as for Codex.
- The daemon authors the closing reply from `progress` events, so `messageEgress` works when Grok never calls `send_agent_message`.
- Task-scoped local stdio MCP toolsets attach to the Grok session (`mcpToolsets: true`).
- The read-only memory rule holds for a `memory-reader` Attempt: three turns do not change `MEMORY.md` or `notes/` (downstream acceptance).
- Qualification per `docs/adapter-capabilities.md`, with an offline fake runtime.

Non-goals:

- The external Bot layer and the byok MCP server (parent beta document).
- Grok as a Bot-mode runtime. The Bot mode PRD and its Q8 stay unchanged.
- Grok as a model through Pi BYOK (#512, #513). That path stays independent.
- Native interactions (approval UI, structured questions), steer, `messageDraft`, fork, rollback, compaction control.
- Installing or updating Grok. OAR `install.ts`, `update.ts`, `list-models.ts`, `account-usage.ts`, `inventory.ts` are not selected.
- Hermes (#519) and other ACP runtimes.
- Live-provider certification in CI.

## 5. Adapter interface mapping

### 5.1 Descriptor (v1)

```ts
freezeRuntimeAdapterDescriptor({
  id: 'grok',
  supportsDispatchSelection: true,      // subscription lane, runtimeId 'grok', modelId -> session/set_model
  progressEventsAreMessages: true,      // GrokProjection emits one progress per complete message (§7.2)
  capabilities: {
    steer: false,                       // sendNow is cancel-and-rerun; see Q4
    resume: true,                       // session/resume by exact id, same cwd
    approvalInteractive: false,
    mcpToolsets: true,                  // ACP mcpServers on new and resume
    // nativeInteractions, messageDraft, durablePi: omitted (unsupported)
  },
});
```

### 5.2 Members

| `RuntimeAdapter` / `Session` member | GrokAdapter behavior | OAR / ACP mapping |
| --- | --- | --- |
| `detect()` | `resolveGrokBin()` (`BYOK_GROK_BIN`, else `grok` on PATH, as `resolveCodexBin`). `probeRuntimeVersion(command)`. Then `grok agent stdio --help` with a 5 s deadline; failure is `refused: 'acp_unavailable'`. `authPresent` from the signal chosen in Q9. Version other than the qualified one is an advisory, never a gate (Codex policy). | OAR `installation.ts` probes `grok agent stdio --help`. Not vendored; reimplemented in the SDK's detect style. |
| `prepare(input)` | Pure. Rejects a selection for another runtime or lane. Rejects when `detect` is not `available`. Returns `{ kind: 'prepared', operation: { start } }`. | none |
| `start(input)` | Requires a string instruction and a sealed cwd. Builds `SessionOptions`: `cwd`, `env = { ...input.env, ...input.scratch.env }`, `model`, `resume = manifest.sessionRef`, `mcpServers` from `input.mcpServers` (stdio `{ name, command, args, env }`). Memory-reader options per Q7. Calls the bridge, checks the returned id against `sessionRef`, then sends the first prompt. | `grokSession(installation, options)` |
| `Session.sessionRef` | Native ACP session id. | `Session.id` = `session/new` answer `sessionId` |
| `Session.events` | Async queue from `GrokProjection`. Ends after disposal drains stdout. | kernel `onRecord` |
| `Session.followUp(task)` | Same model only; else `PolicyUnsupportedError`. Sends `prompt`. | `session/prompt` on the same session |
| `Session.steer(text)` | Throws `SteerUnsupportedError`, as Claude. | not called |
| `Session.interrupt()` | `raw.abort()`, then waits for the cancelled prompt answer, bounded by `interruptTimeoutMs`. Timeout fails the session. | `session/cancel`; OAR 10 s abort fallback kills the process |
| `Session.close()` | Idempotent. `raw.dispose()`, then owned tree `dispose()`, then `scratch.release()`, then end the queue. | dispose: cancel, `session/close` (2 s), kill, terminal host dispose |
| `Session.resolveApproval()` | `PolicyUnsupportedError`. | none |

## 6. ACP stdio protocol handling

The official ACP SDK keeps framing above the line level, JSON-RPC ids, request routing and schema validation. BYOK changes only what the SDK must own. Each change follows the fork's rules: Apache-2.0 change notice at the top, `BYOK change` comments at each seam, original and maintained SHA-256 in `source-manifest.json`.

| File | BYOK delta | Invariant |
| --- | --- | --- |
| `shared/acp/process.ts` | Replace `spawnLineProcess(…, { killTree: true })` and `ndJsonStream` with an injected owned line process. Build the ACP `Stream<AnyMessage>` from it: each `onLine` is one `JSON.parse`d message into a `ReadableStream`; each written message is `JSON.stringify` plus `\n` through `write`. A parse failure fails and kills the process. `resources` is omitted, as in the Codex fork. | Caller owns the process. Line bytes and buffer bytes stay bounded by `owned-line-process.ts`. |
| `shared/acp/session.ts` | Remove `withSessionCredentials`, `credentials.seal` and `sessionEnvironment`. Take an explicit string env. Build one `sessionCredentialRedactor` per open as the kernel `redact` hook (Codex `session.ts` pattern). Return the raw `AdapterSession`. Add `onReady(id)`, `onRecord`, `maxBytes`, `onLimit` hooks. | Explicit env; bounded records; required consumer sees every record. |
| `shared/acp/terminal.ts` | Replace `cross-spawn` and `trackOwnedProcess` with an injected terminal spawn from the SDK. The SDK spawn uses `withOwnedProcessTree`, adoption and disposal, and the same explicit env. Terminal env entries from Grok overlay that env only. | Every process the SDK starts is in its process-tree authority, including Windows Job Objects. |
| `shared/acp/client-app.ts` | `allowPermission` answers `{ outcome: 'cancelled' }` for every permission request (Q5). The request and answer stay recorded. | No server request gets a permissive fallback. |
| `runtimes/grok/session.ts` | Export a `grokSession(spawn, terminalSpawn, installation, options, hooks)` entry for the bridge. Keep `grokAcpProfile` bytes otherwise. | Same profile as upstream. |

Not changed: handshake order, `initialize` `_meta` (`clientIdentifier: "oar"` stays upstream bytes), 15 s opening deadlines, `GROK_EXTENSION_NOTIFICATIONS`, MCP credential redaction, resume selection, prompt and abort machinery, refused options.

Known protocol gaps carried from OAR: `_x.ai/session/setup` is not registered, so the ACP SDK drops it. The unsolicited `skills-reload` response is ignored. Neither reaches records.

Bridge: `packages/client/src/runtime/grok-session-runtime.{js,d.ts}`, same shape as the Codex bridge. `scripts/api-surface/oar-bridge-types.ts` gains a Grok section that checks the declaration against the vendored source and names intentional omissions (`resources`, `queue`, `withdraw`, `steer`).

## 7. Session and transcript

### 7.1 Identity and storage

- The session id is the native ACP id. The SDK stores it as `sessionRef` in the handoff store. Resume uses the same handoff `cwd`, which matches Grok's same-directory rule (`agent-session-handoff-store.ts:13-19`).
- Grok persists its own session under `~/.grok/sessions`. The SDK keeps no transcript copy. `session/resume` restores model context, not a replay. The kernel record stream lives in the process only. The SDK releases it at completion (16 MiB default budget, as Codex).
- A missing session (`SessionNotFoundError`) on resume is a non-retryable `authority` failure, as Codex.

### 7.2 Projection (`adapters/grok/projection.ts`, SDK-owned)

ACP frames already carry OAR's derived `events` beside `native` in the same record, so a fold failure cannot lose the native frame. `GrokProjection` therefore reads the OAR `events` of root-session frames. It reads `native` only for message boundaries.

| Record | `AgentEvent` |
| --- | --- |
| root `text_delta` | Append to the current message buffer |
| root `tool_call_started` | Flush buffer as one `progress`; then `tool_use` |
| root `tool_call_ended` | `tool_result` (`ok` / `failed`) |
| root `_x.ai/session_notification` with `response_completed` | Flush buffer as one `progress` |
| root `session/prompt` frame with `turn_ended` and `usage` | Flush buffer; `usage`; `turn_end` |
| `session/prompt/error` frame (failed `turn_ended`) | `RuntimeExecutionFailure` (`semantic`, non-retryable; `rate_limited` maps to retryable) |
| `exited` response without our dispose | `infrastructure` failure |
| `reasoning`, `model`, `effort`, vendor housekeeping | none |
| child-session frames (foreign `sessionId`) | none for progress and usage; child tools are not parent tools |

`usage` takes OAR's per-prompt ledger. The documented child-accounting gap (late background child spend) stays an open limit; the SDK does not correct it.

### 7.3 Memory-reader instructions

A memory-reader Attempt runs in `<home>/.byok/runs/<taskId>/` (`types.ts:315-325`). Grok's rules (grok-build user guide `12-project-rules.md`): it loads `AGENTS.md`, `CLAUDE.md` and related names from the repo root down to cwd inside a git repo, and from cwd only outside a git repo. "Startup loading requires folder trust (`--trust` or an interactive grant)" (`22-permissions-and-safety.md:559`). OAR does not pass `--trust`. So the persona and the read-only rule in the home may not load. This is unverified for `agent stdio`. Q7 and slice S0 decide the mapping.

## 8. Cancellation

- `interrupt()`: `abort` sends `session/cancel` and answers `accepted`. Grok answers the prompt `cancelled` in about 1 s (OAR live evidence). `GrokSession` waits for that answer, bounded by `interruptTimeoutMs` (default 1000 ms and configurable, as Codex). On timeout the session fails and closes.
- OAR's 10 s abort fallback still kills the process if Grok never answers.
- `close()` mid-turn: OAR cancels first, then `session/close`, then kill. The owned tree disposal then ends descendants, including hosted terminals.
- Admission cancellation: `start` checks `input.signal` after open and before the first prompt, as Codex.
- Known limit (OAR `grok.md` "Interrupted input"): a cancel that races a new prompt can drop or keep its input. Background child effects after cancel are unverified.

## 9. Errors

| Source | SDK result |
| --- | --- |
| `detect`: ENOENT / EACCES / timeout | `not-found` / `not-executable` / `timeout` (`classifyDetectError`) |
| `detect`: ACP mode absent | `refused: 'acp_unavailable'` |
| Wrong runtime or lane in selection | `prepare` reject, non-retryable |
| Spawn, `initialize`, `authenticate`, `session/new` failure | `RuntimeExecutionFailure` `start`, `infrastructure`, retryable; message redacted |
| Auth refused (OAR `RuntimeFailureError` auth class) | `start`, `authority`, non-retryable |
| Unknown model (`Invalid params` on `set_model`) | `start`, `authority`, non-retryable |
| `SessionNotFoundError` on resume, or id mismatch | `start`, `authority`, non-retryable |
| Prompt error answer | `run`, `semantic`, non-retryable; `rate_limited` retryable |
| Process exit not caused by us | `run`, `infrastructure` |
| Record byte budget exceeded | `run`, `infrastructure`, non-retryable; process killed |
| Disposal failure during start | `RuntimeStartupDisposalFailure` |

Error text passes through the per-open credential redactor before it leaves the fork.

## 10. Testing strategy

Offline (CI):

- Fake runtime `packages/client/src/__tests__/fixtures/fake-grok.mjs`. Derive it from OAR `tests/fixtures/fake-acp-agent.mjs` and `fake-acp-grok.mjs` (Apache-2.0; record source and commit in a header). It speaks ACP over stdio, emits recorded Grok 1.0.25 frame shapes, and supports modes: basic turn, tool turn with `terminal/*` reverse requests, MCP `use_tool` call, cancel, resume hit and miss (`FS_NOT_FOUND`), prompt error, crash, permission request, oversize line, child session.
- Vendor checks: manifest hashes for the 26 new files and the changed ones; bridge type check (`check:api-surface`).
- Adapter tests (`grok-adapter.test.ts`): detect outcomes; prepare rejections; explicit env reaches the child and nothing ambient; MCP servers reach `session/new` and `session/resume`; resume identity and mismatch; interrupt bounded; close idempotent while a turn is active; process tree and hosted terminal reaped (reuse `runtime-process-tree.test.ts` helpers); credential values absent from records and errors; permission request answered `cancelled`.
- Projection tests: replay OAR `tests/replay/fixtures/grok-acp-v1.*` through `GrokProjection`; assert one `progress` per message, child frames excluded, `usage` then `turn_end`.
- Daemon test: a `messageEgress` task on the fake runtime publishes the closing reply without `send_agent_message`.
- Conformance: add `GrokAdapter` to `adapter-capability-conformance.test.ts`: resume through `session/resume` with the exact id, typed steer rejection, no fork or rollback, `confirm` rejected before spawn, idempotent disposal.

Live (local, opt-in, not CI): a script like `packages/client/scripts/codex-app-server-real.mjs` that runs three turns on a scratch Agent home with the real `grok`, checks the home's `MEMORY.md` and `notes/` hashes, and attaches one stdio MCP server. It uses the user's Grok login and can spend quota, so each run needs Aimpact's approval.

## 11. Packaging and dependencies

- `@byok-sdk/client` gains one runtime dependency: `@agentclientprotocol/sdk` exact `1.4.0`, Apache-2.0. Its peer `zod` resolves to the workspace `^4.4.3` (already in `protocol`, `core`, `keys`, `cloud`). Add `zod` to `packages/client` dependencies if the peer check needs it.
- `cross-spawn` does not enter: the terminal delta removes it.
- `third-party-manifest.json` and `build-todo-assets.mjs` provenance copy: update for the new vendored files and the new dependency.
- The Grok binary stays a user install (xAI script; macOS and Linux). The SDK does not install or update it.
- Required checks per slice: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`.

## 12. Open questions for Aimpact

| # | Question | Recommended answer |
| --- | --- | --- |
| Q1 | Do we build this adapter now? | **Answered** (Aimpact, 2026-10-19 about 14:00 HKT): optional side item under the external Bot beta. The main form is the byok MCP server. The PRD does not change. |
| Q2 | Does the OAR Grok runtime fit the vendor policy (#514 question 1)? | Yes. Same pin, upstream bytes except the five deltas in §6, each at a seam the policy already names (process, environment, deadline, record budget, interaction). |
| Q3 | ACP SDK: npm dependency or vendored source? | Exact-pinned npm dependency. It is the protocol's official library, Apache-2.0, about 5 MB unpacked. Vendoring it adds upkeep with no ownership gain. |
| Q4 | v1 capability matrix (#514 question 2)? | `resume: true`, `mcpToolsets: true`, `steer: false`, `approvalInteractive: false`, `nativeInteractions` and `messageDraft` omitted. Steer is cancel-and-rerun natively and re-runs tool calls; downstream needs only egress and toolsets. |
| Q5 | A permission request reaches the client despite `--always-approve` (user deny/ask rules, hooks). OAR answers allow. | Answer `cancelled` and record it. This matches the Codex fork's "no permissive fallback" and leaves the user's own Grok rules in charge (ADR-037). |
| Q6 | Keep OAR's client-side terminal host? | Yes, with the owned-spawn delta. OAR's live evidence covers it. Advertising `terminal: false` has no evidence for sessions. |
| Q7 | How does a memory-reader Attempt load the home persona and read-only rule? | Decide after S0. Preferred order: (1) native discovery works from the run directory (for example the home is a git repo, or a `--trust` agent option before `stdio`); (2) a Grok agent option that adds a rule root; (3) `appendSystemPrompt` through `_meta.rules` for fresh sessions only, because Grok refuses append-only resume. Never write the user's `config.toml`. |
| Q8 | Set `GROK_DISABLE_AUTOUPDATER=1` or `GROK_MEMORY=0` in the child env? | No. Follow OAR: the user's settings decide. Version stays an advisory. Document that Grok native memory (`~/.grok/memory*`) is outside the Agent home and outside the SDK memory authority. |
| Q9 | Auth signal for `detect`? | `authPresent` is true when `$GROK_HOME/auth.json` (default `~/.grok/auth.json`) exists or `XAI_API_KEY` is in the runtime env. Check existence only; never read the file. No ACP spawn in detect. |
| Q10 | Platforms for v1? | macOS and Linux qualified. Windows keeps the shared process-tree path but has no Grok evidence; detect reports normally and docs say "unqualified". |

## Task Breakdown

Optional. Execution by Codex only after the beta MCP server plan is reviewed and Aimpact asks for the Grok CLI runtime. Each slice is one PR, draft until Aimpact undrafts.

| Slice | Scope | Files | Done when |
| --- | --- | --- | --- |
| S0 | Qualification probes. No product code. Record results in `docs/researches/2026-10-xx-grok-acp-probes.md`. Probes: instruction loading from a memory-reader run directory with and without git and `--trust`; permission requests under `--always-approve`; auth signal; MCP stdio attach via ACP on 1.0.62; cancel timing on 1.0.62. Probes that call the model need Aimpact approval. | docs only, scripts in `/tmp` | Q7 and Q9 have evidence; any 1.0.62 change against OAR evidence is listed |
| S1 | Vendor selection. Copy 26 files from `c264f17`. Apply the §6 deltas. Update `source-manifest.json` and `PROVENANCE.md`. Add the ACP SDK dependency. Add the bridge and its type check. | `vendor/oar/c264f17/**`, `src/runtime/grok-session-runtime.*`, `scripts/api-surface/oar-bridge-types.ts`, `package.json`, lockfile | Manifest and bridge checks pass; no new export yet |
| S2 | `GrokAdapter` descriptor, `detect`, `prepare`; `resolve-bin.ts`; `grok-version.ts` (qualified version from S0). | `src/adapters/grok/*` | Detect and prepare tests pass with a fake binary |
| S3 | `GrokSession`, `GrokProjection`, fake runtime, adapter and daemon egress tests. Memory-reader mapping from S0. | `src/adapters/grok/*`, `__tests__/fixtures/fake-grok.mjs`, tests | §10 offline tests pass |
| S4 | Export, conformance, docs. Add to `adapters/index.ts`; conformance runner; `docs/adapter-capabilities.md` Grok column; README runtime list. | index, tests, docs | All five required checks pass |
| S5 | Optional live run (§10) on the developer machine. | script only | Three-turn read-only check and one MCP call recorded; needs approval |

## Rollback

This PR adds two plan documents and leaves the Bot mode PRD unchanged. Later slices are additive. The adapter does nothing until a Host constructs it. Reverting S4 removes the export; reverting S1 restores the Codex-only selection.

## Residual risk

- No OAR evidence covers Grok 1.0.62. Grok updates itself, so the qualified version will drift.
- Memory-reader instruction loading is unverified (§7.3). If no native path works, fresh sessions can carry the rule through `_meta.rules`, but resumed reader sessions cannot. That would block resume for readers.
- Child spend can be missing from `usage` (OAR documented gap).
- A new runtime npm dependency enters `@byok-sdk/client`.
- `PROVENANCE.md` states "No … ACP … included". S1 must rewrite that sentence and the history, or the record lies.

## Verification of this plan

- `gh issue view 514 --repo Ancienttwo/byok-sdk` (body and comment read).
- `/tmp/oar514`: `git log -1` → `c264f17 … chore: release v0.67.0 (#425)`; `ls packages/oar/src/runtimes/grok` (11 files); `ls packages/oar/src/shared/acp` (19 files); `docs/runtimes/grok.md` read in full.
- Closure script: 88 files full; 66 after the four exclusions; 40 in the fork; 26 new; external `@agentclientprotocol/sdk`, `cross-spawn`.
- `vendor/oar/c264f17/PROVENANCE.md` and `source-manifest.json` (`packageVersion 0.67.0`, commit `c264f17…`).
- `npm pack @agentclientprotocol/sdk@1.4.0`: `Stream<AnyMessage> = { writable, readable }` in `dist/stream.d.ts`; peer `zod`.
- `gh api repos/xai-org/grok-build/contents/…/12-project-rules.md`, `22-permissions-and-safety.md`, `15-agent-mode.md`, `02-authentication.md`, `26-config-reference.md`.
