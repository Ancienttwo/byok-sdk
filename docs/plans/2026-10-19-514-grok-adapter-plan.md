# #514 GrokAdapter: architecture plan (Bot first)

Status: plan only. No adapter code. Revision 2, 2026-10-19.
Issue: [#514](https://github.com/Ancienttwo/byok-sdk/issues/514). PR: [#536](https://github.com/Ancienttwo/byok-sdk/pull/536).
Baseline: byok-sdk `main@a6bb9d55`. OAR pin: `botiverse/oar` 0.67.0, commit `c264f17040dd9513b43300886a80f3f6eddde7b1` (the pin of the existing vendored fork).

## Product ruling (Q1, answered)

Aimpact, 2026-10-19, about 13:45 HKT: 「可以顺手接入 grok cli，但 grok bot 才是重点」.

- The ruling overturns PRD §7 and §12 Q4 ("不做 grok ACP adapter"). #514 and #536 continue. The PRD records the ruling in §7, §8 and the Q4 row.
- Priority: **Grok Bot** is the main goal. In this plan, Grok Bot means a Bot in Bot mode whose executions run on Grok. The Grok Build CLI adapter is the means, not the goal. The capability matrix, the slice order and the acceptance below put the Bot scenario first. The CLI is only the runtime under the Bot.
- The Pi + xAI model path stays for model-only use. It does not replace the Bot-first adapter work.
- Not approved: Hermes #519. Not rewritten: PRD Q8 for other runtimes.

Second ruling, Aimpact, 2026-10-19, about 13:53 HKT: after the Grok Bot S0 isolation proof passes, PRD Q8 becomes "Pi + Grok". Claude and Codex stay excluded. Status: decided, not yet in effect (gated on S0). The PRD Q8 row stays "只 Pi" until the S0 pass is recorded (§12 Q2).
- The xAI Grok app is a separate product. It is not a runtime and is out of scope.

Revision 1 of this plan (commit `0ebfe78e`) was CLI-first. This revision changes §4, §5, §7, §10, §12 and the Task Breakdown. The inventory (§1) is unchanged.

## Conclusion

OAR already ships a usable Grok Build runtime. It drives `grok agent --always-approve --no-leader stdio` over ACP JSON-RPC, and its docs and tests record live evidence up to Grok 1.0.52. The SDK must not build a second ACP stack.

The plan: extend the existing private OAR fork at `vendor/oar/c264f17` with the Grok runtime and its `shared/acp` closure. Apply BYOK deltas only at the seams that the Codex fork already maintains: process ownership, explicit environment, deadlines, record budget and interaction policy. The official `@agentclientprotocol/sdk` (exact pin `1.4.0`, the version in OAR's lockfile) owns the ACP wire. A new SDK `GrokAdapter` implements `RuntimeAdapter` around that runtime.

The adapter is cut for a Bot execution first: one fresh session per wake, the three SDK exits (`messageEgress`, `submit_result`, `memory_save`) through the reserved MCP helpers, and streaming reply drafts. Two Bot invariants need native Grok controls that OAR does not use: no side-effect tools (A1) and one memory writer (M1). Slice S0 proves those controls before code.

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
| Instructions | `grokInitializeMeta` | `systemPrompt` → `_meta.systemPromptOverride`; `appendSystemPrompt` → `_meta.rules`. Append-only resume is refused. |
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

| Need | Present today | Gap |
| --- | --- | --- |
| ACP wire, handshake, turns, MCP, records for Grok | OAR upstream only | Vendor selection does not include it |
| SDK-owned Grok process with timeout and tree cleanup | Codex path only (`owned-line-process.ts`) | ACP transport is not wired to the owned process; OAR terminal host spawns outside it |
| Explicit filtered env, no ambient merge | Codex fork deltas | `shared/acp/session.ts` calls `sessionEnvironment(options.env)` (ambient merge) |
| `RuntimeAdapter` with descriptor, `detect`, `prepare` for `grok` | None | New `adapters/grok/` |
| Bot exits: closing reply, `submit_result`, `memory_save`, reply draft | Daemon injects the reserved helpers for any ordinary-lane adapter (`task-runner.ts:3466-3499`); Pi declares `messageDraft` | `GrokProjection` and a Bot-lane proof on Grok |
| Bot invariants A1 and M1 on a coding harness | None for Grok; PRD Q8 kept Bot executions on Pi | Native Grok tool and memory controls (§7.4) |
| Qualification per `docs/adapter-capabilities.md` | Claude, Codex | Grok column, conformance runner entry, fake runtime |

### 1.6 Decision record

PRD §7 / Q4 said "不做" on 2026-10-18. #514 asked for the adapter on the same date. Aimpact settled it on 2026-10-19 (see "Product ruling" above). The PRD now records the ruling.

## 2. P2 trace: one Grok Bot turn (target path)

1. The Host (K4) submits a Bot execution for `AgentRef` with `executions.submit`. The offer carries the ContextPack inside the instruction, a `messageEgress` requirement and, for an outcome turn, `terminalProjection.mode: 'result-document'` with the frozen schema.
2. The daemon picks `GrokAdapter` (`dispatchSelection.runtimeId: 'grok'`, ordinary lane). Downstream must construct the adapter explicitly.
3. Admission adds the reserved stdio MCP servers to `input.mcpServers`: `byokagentmessage`, `byokagentresult` and `byokagentmemory` (`read-write`, when the memory filesystem gate passes), plus the Host's read-only toolsets. The daemon preflights the message and result helpers.
4. `GrokAdapter.prepare` checks the selection and `detect()`. `start` opens one fresh ACP session (no `sessionRef`) through the vendored `grokSession` with an injected owned spawn. All MCP servers go into ACP `mcpServers`.
5. `GrokSession.prompt(instruction)` sends `session/prompt`. Grok calls MCP tools through `use_tool`. Each frame becomes a kernel record. `GrokProjection` emits `progress` deltas, `tool_use`, `tool_result`, `usage` and `turn_end`.
6. The daemon streams the reply into the draft lane (`AgentMessageDraftPublisher`, when `messageDraft` is declared and the server advertises `agent-message-draft`). It keeps the closing reply in `finalTextParts`.
7. On `turn_end`, the daemon publishes the accepted message (`agent.message.publish`), unless Grok already called `send_agent_message`. For a result-document offer, the staged `submit_result` outcome closes the task. A success without an outcome fails closed (K7).
8. `close()` disposes the session, the owned process tree and the scratch. The next wake is a new fresh execution (ADR-036 D1).

## 3. P3 decision

- Why the current design exists: the Codex fork follows upstream and keeps a delta only where the SDK must own the process, environment, deadlines, record budget or interaction policy (`PROVENANCE.md`). ADR-037 sets YOLO defaults and defers guardrails to the local agent. PRD Q8 kept Bot executions on Pi because Pi's prepared lane fixes the tool and memory surface.
- Core invariants to keep: the SDK owns every process it starts, passes an explicit env, bounds every wait and every retained byte, and never invents a permissive answer. For a Bot execution, also A1 (no side-effect tools) and M1 (one memory writer, through device CAS).
- Smallest coherent change: one more selection in the same fork at the same pin, plus one adapter. No new protocol code. No new SDK abstraction. A1 and M1 use Grok's own controls (agent profile, deny rules), not a second SDK permission layer.
- Rejected: (1) a hand-written ACP client in the SDK; (2) OAR as an npm dependency (brings the executable manager, ambient env merge and Pi/Cursor deps that the fork removed); (3) a separate pin for the Grok selection; (4) the Pi + xAI path as the Bot runtime for this ruling (it stays for model-only use).

## 4. Goals and non-goals

Goals, Bot first (B = Bot acceptance, C = CLI baseline):

- B1. A Grok Bot turn ends in exactly one accepted message through `messageEgress`, also when Grok never calls `send_agent_message`.
- B2. The reply streams through the draft lane (`messageDraft: true`) for PRD S1.
- B3. An outcome turn stages `submit_result` through `byokagentresult`. The success rate is measured on Grok, as PRD §9 requires for Pi.
- B4. `memory_recall` and `memory_save` work through `byokagentmemory`. Over three turns, `MEMORY.md` and `notes/` change only through `memory_save` (M1).
- B5. A Bot execution has no side-effect tool except the Host's read-only or draft-only toolsets (A1). Grok's native shell, file-write and web tools are off or denied for Bot executions.
- B6. A Bot execution is isolated from the user's Grok coding setup: user rules, Claude-compat files, user MCP servers in `config.toml`, and Grok native memory.
- C1. Export `GrokAdapter` from `@byok-sdk/client`. `detect` finds `grok`, its ACP mode and an auth signal, without touching the Agent home or writing Grok's home.
- C2. The SDK owns the Grok process, its timeouts and tree cleanup, as for Codex.
- C3. Qualification per `docs/adapter-capabilities.md`, with an offline fake runtime.

Non-goals:

- The xAI Grok app. Grok as a model through Pi BYOK (#512, #513); that path stays for model-only use.
- Hermes (#519) and other ACP runtimes. Claude and Codex as Bot runtimes (PRD Q8 unchanged for them).
- Native resume in v1. Bot executions are fresh by design. CLI resume is deferred (§12 Q5).
- Native interactions, steer, fork, rollback, compaction control.
- Installing or updating Grok. OAR `install.ts`, `update.ts`, `list-models.ts`, `account-usage.ts`, `inventory.ts` are not selected.
- Live-provider certification in CI.

## 5. Adapter interface mapping

### 5.1 Descriptor (v1, Bot first)

```ts
freezeRuntimeAdapterDescriptor({
  id: 'grok',
  supportsDispatchSelection: true,      // subscription lane, runtimeId 'grok', modelId -> session/set_model
  progressEventsAreMessages: true,      // with progressStartsMessage(): deltas stream, messages still split (§7.2)
  capabilities: {
    messageDraft: true,                 // B2; qualified in S3
    mcpToolsets: true,                  // B3, B4 reserved helpers and Host toolsets
    steer: false,                       // sendNow is cancel-and-rerun; Bots do not steer
    resume: false,                      // Bot executions are fresh; CLI resume deferred (Q5)
    approvalInteractive: false,
    // nativeInteractions, durablePi: omitted (unsupported)
  },
});
```

| Capability | Bot need | v1 |
| --- | --- | --- |
| `messageEgress` closing reply | Required (S1, L1) | Yes, from `progress` |
| `messageDraft` | Required for S1 streaming | `true` |
| `submit_result` via `byokagentresult` | Required for S4–S9 outcomes | Yes, via `mcpToolsets` |
| `memory_*` via `byokagentmemory` | Required for S2 | Yes, via `mcpToolsets` |
| Host read-only toolsets | Required | `mcpToolsets: true` |
| `resume` | Not used (fresh executions) | `false` |
| `steer` | Not used | `false` |
| `nativeInteractions` | Not used (Bots do not prompt; `confirmable_action` is the path) | omitted |

### 5.2 Members

| `RuntimeAdapter` / `Session` member | GrokAdapter behavior | OAR / ACP mapping |
| --- | --- | --- |
| `detect()` | `resolveGrokBin()` (`BYOK_GROK_BIN`, else `grok` on PATH, as `resolveCodexBin`). `probeRuntimeVersion(command)`. Then `grok agent stdio --help` with a 5 s deadline; failure is `refused: 'acp_unavailable'`. `authPresent` from the signal in Q9. A version other than the qualified one is an advisory, never a gate. | OAR `installation.ts` probes `grok agent stdio --help`. Not vendored; reimplemented in the SDK detect style. |
| `prepare(input)` | Pure. Rejects a selection for another runtime or lane. Rejects a `sessionRef` (resume unsupported). Rejects when `detect` is not `available`. | none |
| `start(input)` | Requires a string instruction and a sealed cwd. Builds `SessionOptions`: `cwd`, `env = { ...input.env, ...input.scratch.env }` plus the Bot env of §7.4, `model`, `mcpServers` from `input.mcpServers` (stdio `{ name, command, args, env }`, reserved helpers included). For an Agent execution (`manifest.agentRef` present), adds the Bot profile of §7.4. Sends the first prompt. | `grokSession(installation, options)` |
| `Session.sessionRef` | Native ACP session id (recorded, not resumed). | `session/new` answer `sessionId` |
| `Session.events` | Async queue from `GrokProjection`. Ends after disposal drains stdout. | kernel `onRecord` |
| `Session.progressStartsMessage(event)` | `false` for a delta that continues the current message; `true` after a message boundary. | §7.2 |
| `Session.followUp(task)` | Same model only; else `PolicyUnsupportedError`. | `session/prompt` on the same session |
| `Session.steer(text)` | Throws `SteerUnsupportedError`, as Claude. | not called |
| `Session.interrupt()` | `raw.abort()`, then waits for the cancelled prompt answer, bounded by `interruptTimeoutMs`. | `session/cancel`; OAR 10 s abort fallback kills the process |
| `Session.close()` | Idempotent. `raw.dispose()`, owned tree `dispose()`, `scratch.release()`, end the queue. | cancel, `session/close` (2 s), kill, terminal host dispose |
| `Session.resolveApproval()` | `PolicyUnsupportedError`. | none |

## 6. ACP stdio protocol handling

The official ACP SDK keeps framing above the line level, JSON-RPC ids, request routing and schema validation. BYOK changes only what the SDK must own. Each change follows the fork's rules: Apache-2.0 change notice at the top, `BYOK change` comments at each seam, original and maintained SHA-256 in `source-manifest.json`.

| File | BYOK delta | Invariant |
| --- | --- | --- |
| `shared/acp/process.ts` | Replace `spawnLineProcess(…, { killTree: true })` and `ndJsonStream` with an injected owned line process. Build the ACP `Stream<AnyMessage>` from it: each `onLine` is one `JSON.parse`d message into a `ReadableStream`; each written message is `JSON.stringify` plus `\n` through `write`. A parse failure fails and kills the process. `resources` is omitted, as in the Codex fork. | Caller owns the process. Line and buffer bytes stay bounded by `owned-line-process.ts`. |
| `shared/acp/session.ts` | Remove `withSessionCredentials`, `credentials.seal` and `sessionEnvironment`. Take an explicit string env. Build one `sessionCredentialRedactor` per open as the kernel `redact` hook (Codex `session.ts` pattern). Return the raw `AdapterSession`. Add `onReady(id)`, `onRecord`, `maxBytes`, `onLimit` hooks. | Explicit env; bounded records; required consumer sees every record. |
| `shared/acp/terminal.ts` | Replace `cross-spawn` and `trackOwnedProcess` with an injected terminal spawn from the SDK (`withOwnedProcessTree`, adoption, disposal, same explicit env). | Every process the SDK starts is in its process-tree authority. |
| `shared/acp/client-app.ts` | `allowPermission` answers `{ outcome: 'cancelled' }` for every permission request (Q7). The request and answer stay recorded. | No server request gets a permissive fallback. |
| `runtimes/grok/session.ts` | Export a `grokSession(spawn, terminalSpawn, installation, options, hooks)` entry for the bridge. Pass the Bot profile through `sessionMeta` when the caller supplies it (§7.4). Keep `grokAcpProfile` bytes otherwise. | Same profile as upstream for non-Bot sessions. |

Not changed: handshake order, `initialize` `_meta` (`clientIdentifier: "oar"` stays upstream bytes), 15 s opening deadlines, `GROK_EXTENSION_NOTIFICATIONS`, MCP credential redaction, prompt and abort machinery, refused options.

Known protocol gaps carried from OAR: `_x.ai/session/setup` is not registered, so the ACP SDK drops it. The unsolicited `skills-reload` response is ignored. Neither reaches records.

Bridge: `packages/client/src/runtime/grok-session-runtime.{js,d.ts}`, same shape as the Codex bridge. `scripts/api-surface/oar-bridge-types.ts` gains a Grok section that checks the declaration against the vendored source and names intentional omissions (`resources`, `queue`, `withdraw`, `steer`).

## 7. Session and transcript

### 7.1 Identity and storage

- Each Bot wake opens a new ACP session. The native id is recorded as `sessionRef` for audit only. No handoff resume.
- Grok persists its own session under `~/.grok/sessions`. The SDK keeps no transcript copy. Conversation history reaches the Bot only through the Host's ContextPack, as for every Bot runtime.
- The kernel record stream lives in the process only. The SDK releases it at completion (16 MiB default budget, as Codex).

### 7.2 Projection (`adapters/grok/projection.ts`, SDK-owned)

ACP frames carry OAR's derived `events` beside `native` in the same record, so a fold failure cannot lose the native frame. `GrokProjection` reads the OAR `events` of root-session frames. It reads `native` only for message boundaries.

| Record | `AgentEvent` |
| --- | --- |
| root `text_delta` | One `progress` per delta (streams the draft) |
| root `tool_call_started` | Message boundary; `tool_use` |
| root `tool_call_ended` | `tool_result` (`ok` / `failed`) |
| root `_x.ai/session_notification` with `response_completed` | Message boundary |
| root `session/prompt` frame with `turn_ended` and `usage` | `usage`; `turn_end` |
| `session/prompt/error` frame (failed `turn_ended`) | `RuntimeExecutionFailure` (`semantic`, non-retryable; `rate_limited` retryable) |
| `exited` response without our dispose | `infrastructure` failure |
| `reasoning`, `model`, `effort`, vendor housekeeping | none |
| child-session frames (foreign `sessionId`) | none for progress and usage; child tools are not parent tools |

`progressStartsMessage` returns `true` for the first delta after a boundary and `false` otherwise. With `progressEventsAreMessages: true`, the daemon then streams every delta into the draft and starts a new closing reply at each message, as for Claude's text blocks (`task-runner.ts:4074-4078`). `usage` takes OAR's per-prompt ledger. The documented child-accounting gap stays an open limit.

### 7.3 Instructions and context

The Bot path does not depend on Grok reading files in the Agent home. The Host puts the persona, the resident `MEMORY.md` projection and the conversation into the ContextPack inside the instruction. Prepared Pi already works this way (PRD §3, "两层记忆"). This removes the CLI-path questions about Grok's `AGENTS.md` discovery (git root, folder trust) from the Bot critical path.

If the Host wants persona text as system instructions, `appendSystemPrompt` (`_meta.rules`) works on a fresh session. Grok refuses append-only resume, but Bot executions do not resume.

The CLI-only path (a non-Agent task in a workspace) keeps Grok's native `AGENTS.md` discovery. That path needs no Bot isolation.

### 7.4 Bot isolation: A1, M1, B6

OAR runs Grok with `--always-approve` and the user's whole harness: built-in shell, file edit and web tools, user rules (`$GROK_HOME/rules`, `~/.claude/` compatibility), user MCP servers from `config.toml`, and Grok native memory (this machine has `~/.grok/memory-v2`). For a coding task this is correct (ADR-037). For a Bot execution it breaks A1, M1 and B6: Grok could edit `MEMORY.md` without CAS, run side-effect commands, or write Bot conversations into the user's Grok memory.

Candidate native controls, all per session and without writing the user's config:

| Control | Grok channel | Covers | Evidence |
| --- | --- | --- | --- |
| Bot agent profile | `session/new` `_meta.agentProfile` (name or JSON object); `--agent-profile <PATH>` | Built-in tool set (A1, M1), maybe rules | Documented in `15-agent-mode.md`; not probed |
| Deny rules | `--deny` / `permission.deny` | Shell and file paths (A1, M1) | Documented for `grok -p`; not shown as a `grok agent` option |
| Native memory off | `GROK_MEMORY=0` in the child env | Grok native memory (M1, B6) | Documented process-wide force-disable; v2 coverage not probed |
| Sandbox profile | `[sandbox]` custom profile with `deny` | Kernel write-deny on home files (M1) | Documented; needs config or flag; not probed |

Recommendation (§12 Q6): for an Agent execution only, the adapter passes an SDK-owned Bot agent profile in `_meta.agentProfile` that allows MCP tools only, and sets `GROK_MEMORY=0`. Non-Agent CLI tasks keep the user's harness unchanged. S0 must prove each control on Grok 1.0.62 before S2 uses it. If no control removes the native shell and file-write tools, the Bot lane on Grok does not ship, and the Q8 change to "Pi + Grok" does not take effect.

## 8. Cancellation

- `interrupt()`: `abort` sends `session/cancel` and answers `accepted`. Grok answers the prompt `cancelled` in about 1 s (OAR live evidence). `GrokSession` waits for that answer, bounded by `interruptTimeoutMs` (default 1000 ms and configurable, as Codex). On timeout the session fails and closes.
- OAR's 10 s abort fallback still kills the process if Grok never answers.
- `close()` mid-turn: OAR cancels first, then `session/close`, then kill. The owned tree disposal then ends descendants, including hosted terminals and MCP helpers that Grok started.
- Admission cancellation: `start` checks `input.signal` after open and before the first prompt, as Codex.
- Host `tasks.cancel` of a Bot execution follows the same path. A cancelled Bot execution publishes no message.
- Known limit (OAR `grok.md` "Interrupted input"): background child effects after cancel are unverified.

## 9. Errors

| Source | SDK result |
| --- | --- |
| `detect`: ENOENT / EACCES / timeout | `not-found` / `not-executable` / `timeout` (`classifyDetectError`) |
| `detect`: ACP mode absent | `refused: 'acp_unavailable'` |
| Wrong runtime or lane in selection, or a `sessionRef` | `prepare` reject, non-retryable |
| Bot profile refused by Grok at `session/new` | `start`, `authority`, non-retryable (never fall back to the full harness) |
| Spawn, `initialize`, `authenticate`, `session/new` failure | `start`, `infrastructure`, retryable; message redacted |
| Auth refused (OAR `RuntimeFailureError` auth class) | `start`, `authority`, non-retryable |
| Unknown model (`Invalid params` on `set_model`) | `start`, `authority`, non-retryable |
| Prompt error answer | `run`, `semantic`, non-retryable; `rate_limited` retryable |
| Result-document success without a staged outcome | daemon K7 rule: non-retryable failure |
| Process exit not caused by us | `run`, `infrastructure` |
| Record byte budget exceeded | `run`, `infrastructure`, non-retryable; process killed |
| Disposal failure during start | `RuntimeStartupDisposalFailure` |

Error text passes through the per-open credential redactor before it leaves the fork.

## 10. Testing and acceptance

### 10.1 Bot acceptance (gates the release)

| # | Acceptance | Evidence level |
| --- | --- | --- |
| BA1 | One Bot turn on the fake runtime: `executions.submit` → accepted `messageEgress` message; no `send_agent_message` call needed | SDK synthetic E2E (PRD §5.8 style) |
| BA2 | Draft frames stream during the turn and end at the accepted message | SDK synthetic E2E |
| BA3 | Result-document turn: the fake calls `submit_result` through `use_tool` → outcome staged; a success without outcome fails closed | SDK synthetic E2E |
| BA4 | `memory_save` through `byokagentmemory` applies by CAS; three turns change `MEMORY.md` and `notes/` only through it (hash check) | SDK integration, Linux runner |
| BA5 | Agent execution sends the Bot profile and `GROK_MEMORY=0`; non-Agent task sends neither | adapter unit test |
| BA6 | Live: three Grok Bot turns on a scratch Agent home with real `grok`; native shell and file write are unavailable; home memory hashes change only through `memory_save`; no new entry in `~/.grok/memory*` | native, local, needs approval |
| BA7 | Live: `submit_result` success rate on Grok measured and recorded (PRD §9 K8a analog) | native, paid calls need approval |

### 10.2 CLI baseline

- Fake runtime `packages/client/src/__tests__/fixtures/fake-grok.mjs`. Derive it from OAR `tests/fixtures/fake-acp-agent.mjs` and `fake-acp-grok.mjs` (Apache-2.0; record source and commit in a header). It speaks ACP over stdio, emits recorded Grok 1.0.25 frame shapes, and supports modes: basic turn, streamed text, tool turn with `terminal/*` reverse requests, MCP `use_tool` call (reserved helpers and Host toolset), cancel, prompt error, crash, permission request, oversize line, child session, Bot profile echo.
- Vendor checks: manifest hashes for the 26 new files and the changed ones; bridge type check (`check:api-surface`).
- Adapter tests (`grok-adapter.test.ts`): detect outcomes; prepare rejections (incl. `sessionRef`); explicit env reaches the child and nothing ambient; MCP servers reach `session/new`; interrupt bounded; close idempotent while a turn is active; process tree, hosted terminal and MCP helpers reaped; credential values and helper context tokens absent from records and errors; permission request answered `cancelled`.
- Projection tests: replay OAR `tests/replay/fixtures/grok-acp-v1.*`; assert delta streaming, message boundaries, child frames excluded, `usage` then `turn_end`.
- Conformance: add `GrokAdapter` to `adapter-capability-conformance.test.ts` with `resume: false` (typed refusal), steer refusal, no fork or rollback, `confirm` rejected before spawn, idempotent disposal.

## 11. Packaging and dependencies

- `@byok-sdk/client` gains one runtime dependency: `@agentclientprotocol/sdk` exact `1.4.0`, Apache-2.0. Its peer `zod` resolves to the workspace `^4.4.3` (already in `protocol`, `core`, `keys`, `cloud`). Add `zod` to `packages/client` dependencies if the peer check needs it.
- `cross-spawn` does not enter: the terminal delta removes it.
- The Bot agent profile is an SDK-owned JSON constant in `adapters/grok/`. It is not a file in the user's Grok home.
- `third-party-manifest.json` and `build-todo-assets.mjs` provenance copy: update for the new vendored files and the new dependency.
- The Grok binary stays a user install (xAI script; macOS and Linux). The SDK does not install or update it.
- Required checks per slice: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`.

## 12. Open questions for Aimpact

| # | Question | Recommended answer |
| --- | --- | --- |
| Q1 | PRD Q4 vs #514 | **Answered** (Aimpact, 2026-10-19 about 13:45 HKT): build the adapter; Grok Bot first; CLI as the runtime under it; Pi + xAI stays for model-only use. |
| Q2 | PRD Q8 says v1 Bot executions run on Pi only. Amend it for Grok? | **Decided, not yet in effect** (Aimpact, 2026-10-19 about 13:53 HKT): Q8 becomes "Pi + Grok" after the S0 isolation proof passes. Claude and Codex stay excluded. Until then the PRD Q8 row stays "只 Pi". The PR that records the S0 pass edits the row. |
| Q3 | Does the OAR Grok runtime fit the vendor policy? | Yes. Same pin, upstream bytes except the five deltas in §6, each at a seam the policy already names. |
| Q4 | ACP SDK: npm dependency or vendored source? | Exact-pinned npm dependency (official library, Apache-2.0, about 5 MB unpacked). |
| Q5 | v1 capability matrix | §5.1: `messageDraft`, `mcpToolsets` on; `resume`, `steer`, `approvalInteractive` off; `nativeInteractions` omitted. Resume returns later only if a non-Bot CLI user needs it. |
| Q6 | How to keep A1, M1 and B6 for a Grok Bot? | SDK-owned Bot agent profile via `_meta.agentProfile` (MCP tools only) and `GROK_MEMORY=0`, for Agent executions only. Use Grok's native controls, not an SDK filter. No fallback to the full harness. |
| Q7 | A permission request reaches the client despite `--always-approve`. OAR answers allow. | Answer `cancelled` and record it ("no permissive fallback", as the Codex fork). |
| Q8 | Keep OAR's client-side terminal host? | Yes, with the owned-spawn delta. A Bot profile without shell should make it idle for Bots. |
| Q9 | Auth signal for `detect`? | `authPresent` when `$GROK_HOME/auth.json` (default `~/.grok/auth.json`) exists or `XAI_API_KEY` is in the runtime env. Check existence only; never read the file. No ACP spawn in detect. |
| Q10 | Platforms for v1? | macOS and Linux qualified. PRD Q14 rejects Linux-only for Bot mode, and most Bot users run Windows. Grok's installer is macOS and Linux only, so a Windows Grok Bot is out of v1. Record this as a limit, not a pass. |
| Q11 | Auto-update | Do not set `GROK_DISABLE_AUTOUPDATER`. The version stays an advisory, as Codex. |

## Task Breakdown

Execution by Codex after plan review. Each slice is one PR, draft until Aimpact undrafts. Bot-critical work comes first; CLI-only polish comes last.

| Slice | Scope | Files | Done when |
| --- | --- | --- | --- |
| S0 | Bot probes on Grok 1.0.62. No product code. Record in `docs/researches/2026-10-xx-grok-bot-probes.md`. Probes, Bot first: (1) `_meta.agentProfile` JSON with MCP tools only removes native shell, file edit and web tools; (2) `GROK_MEMORY=0` stops memory v1 and v2 writes; (3) user rules, Claude-compat files and `config.toml` MCP servers under that profile; (4) reserved stdio helpers through `use_tool`: `submit_result`, `memory_save`, `send_agent_message`; (5) streamed `agent_message_chunk` timing for drafts; (6) permission requests under `--always-approve`; (7) auth signal; (8) cancel timing. Model calls need Aimpact approval. | docs only, scripts in `/tmp`; on pass, the PRD Q8 row | Q6 and Q9 have evidence. On pass: PRD Q8 row → "Pi + Grok" (Q2). On a failed (1): the Bot lane stops, Q8 stays "只 Pi", and the result is reported |
| S1 | Vendor selection. Copy 26 files from `c264f17`. Apply the §6 deltas. Update `source-manifest.json` and `PROVENANCE.md`. Add the ACP SDK dependency, the bridge and its type check. | `vendor/oar/c264f17/**`, `src/runtime/grok-session-runtime.*`, `scripts/api-surface/oar-bridge-types.ts`, `package.json`, lockfile | Manifest and bridge checks pass; no new export yet |
| S2 | Bot-lane adapter: descriptor, `detect`, `prepare`, `start`, `GrokSession`, `GrokProjection` with delta streaming and `progressStartsMessage`, Bot profile and env for Agent executions, fake runtime. | `src/adapters/grok/*`, `__tests__/fixtures/fake-grok.mjs`, adapter tests | §10.2 adapter and projection tests pass; BA5 passes |
| S3 | Bot acceptance on the fake runtime: BA1–BA4 in the synthetic E2E harness (embedded server, daemon, fake grok). | tests, fixtures | BA1–BA4 pass on Linux CI |
| S4 | Export, conformance, docs: `adapters/index.ts`; conformance runner; `docs/adapter-capabilities.md` Grok column; README runtime list. | index, tests, docs | All five required checks pass |
| S5 | Live Grok Bot run (BA6, BA7) on the developer machine. | script only | Results recorded; needs approval |
| S6 | Optional CLI-only follow-ups: native resume, non-Agent `AGENTS.md` discovery notes. Only on a new request. | — | — |

## Rollback

This PR changes two documents. Later slices are additive. The adapter does nothing until a Host constructs it. Reverting S4 removes the export; reverting S1 restores the Codex-only selection.

## Residual risk

- The Bot lane depends on S0 probe (1). If Grok cannot remove its native tools per session, a Grok Bot breaks A1 and M1, and only the CLI baseline can ship.
- Grok exposes MCP tools only through `use_tool`. That indirection can lower the `submit_result` call rate. BA7 measures it.
- No OAR evidence covers Grok 1.0.62. Grok updates itself, so the qualified version will drift.
- Windows has no Grok installer, while most Bot users run Windows (PRD Q14).
- Child spend can be missing from `usage` (OAR documented gap).
- A new runtime npm dependency enters `@byok-sdk/client`.
- `PROVENANCE.md` states "No … ACP … included". S1 must rewrite that sentence and the history.
- The PRD records the ruling in §1, §7, §8, §10 M0.7, §11 and the Q4 row. The Q8 row still says "只 Pi". Aimpact has decided "Pi + Grok", but the change waits for the S0 pass (§12 Q2).

## Verification of this plan

- `gh issue view 514 --repo Ancienttwo/byok-sdk` (body and comment read).
- `/tmp/oar514`: `git log -1` → `c264f17 … chore: release v0.67.0 (#425)`; `ls packages/oar/src/runtimes/grok` (11 files); `ls packages/oar/src/shared/acp` (19 files); `docs/runtimes/grok.md` read in full.
- Closure script: 88 files full; 66 after the four exclusions; 40 in the fork; 26 new; external `@agentclientprotocol/sdk`, `cross-spawn`.
- `vendor/oar/c264f17/PROVENANCE.md` and `source-manifest.json` (`packageVersion 0.67.0`, commit `c264f17…`).
- `npm pack @agentclientprotocol/sdk@1.4.0`: `Stream<AnyMessage> = { writable, readable }` in `dist/stream.d.ts`; peer `zod`.
- SDK Bot lanes: `packages/client/src/sdk-reserved-mcp.ts`; `daemon/task-runner.ts:3413-3499` (reserved helper injection on the ordinary lane), `:3034-3043` (draft gate), `:4074-4078` (`progressStartsMessage`).
- Grok docs via `gh api repos/xai-org/grok-build/contents/crates/codegen/xai-grok-pager/docs/user-guide/…`: `12-project-rules.md`, `13-memory.md`, `15-agent-mode.md` (`--agent-profile`, `_meta.agentProfile`, `_meta.rules`), `18-sandbox.md`, `22-permissions-and-safety.md`, `26-config-reference.md`.
