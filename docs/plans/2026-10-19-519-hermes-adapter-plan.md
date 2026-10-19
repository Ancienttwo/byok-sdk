# #519 HermesAdapter: architecture plan

Baseline: byok-sdk `main@a6bb9d55` (2026-10-19). Vendored OAR `c264f17` (0.67.0). Upstream OAR `main@5296675b` (0.68.1, 2026-10-19). Local Hermes Agent `354ad3d4` (2026-10-18, `Hermes Agent v0.22.2+1687.g354ad3d (2026.9.24) · stable`).

Status: plan only. This document does not authorize implementation, release, issue edits or downstream changes. It answers [#519](https://github.com/Ancienttwo/byok-sdk/issues/519).

Authority: [docs/spec.md](../spec.md) is product truth. [docs/adapter-capabilities.md](../adapter-capabilities.md) owns qualification. The [Bot mode PRD](2026-10-18-bot-mode-product-prd.md) records owner decisions Q4 and Q8, which this plan does not override (see §12 Q0).

Evidence labels: `(verified: <source>)` means a command ran or source was read on 2026-10-19. `[UNVERIFIED]` means the fact came from docs or inference and needs proof in slice S0.

## Conclusion

1. The issue claim is correct. Upstream OAR has no Hermes runtime. It does ship a generic ACP client layer (`packages/oar/src/shared/acp/`, 19 files). Grok, Kimi, OpenCode and Antigravity are thin profiles on that layer.
2. Recommended route: extend the existing SDK-owned OAR fork with the `shared/acp` closure at the same pin `c264f17`. Write a thin Hermes profile and a `HermesAdapter` in the SDK. Do not write a second ACP client. Do not wait for an upstream OAR Hermes runtime. Offer the profile upstream later, without a dependency on it.
3. One Hermes fact changes the design. `hermes acp` is only a viewer. On the first session call it starts a detached per-profile gateway daemon that runs the agent, MCP, cron and kanban. That daemon outlives the viewer for up to 600 s. It escapes the SDK process tree. The adapter must therefore start its own foreground gateway (`hermes gateway run --quiet --external-supervisor`) as an SDK-owned process tree, in a per-execution isolated `HERMES_HOME`. The viewer then attaches to that gateway. This topology is the main unknown. Slice S0 must prove it before any product code.
4. No protocol change is needed. The adapter id `hermes` uses the existing custom-harness contract (#167): `task.offer.harnessId`, `conn.hello.harnesses`. The frozen built-in `RuntimeIdSchema` stays `['pi','claude','codex']`.
5. First-version capabilities: `mcpToolsets: true`. `steer`, `resume`, `approvalInteractive`, `nativeInteractions` and `messageDraft` are false or absent. The daemon's adapter-agnostic `messageEgress` closing reply works without adapter changes.

## 1. Inventory (before design)

### 1.1 Verification of the issue claim "OAR upstream has no Hermes runtime"

| Check | Result | Evidence |
| --- | --- | --- |
| Upstream runtime source directories | `antigravity claude codex cursor grok kimi opencode pi-durable pi`. No `hermes`. | (verified: `gh api repos/botiverse/oar/contents/packages/oar/src/runtimes?ref=main`, commit `5296675b`) |
| Upstream `docs/runtimes/` | 21 pages. Runtime pages: antigravity, claude, codex, cursor, grok, kimi, opencode, pi, pi-durable. No Hermes page. | (verified: `gh api .../contents/docs/runtimes?ref=main`) |
| Upstream README "Supported runtimes" | Antigravity, Claude Code, Codex, Cursor, Grok Build, Kimi Code, OpenCode, Pi. | (verified: README table in shallow clone `/tmp/plan519/oar-main`) |
| Full-text search, whole upstream tree | "hermes": 1 hit, `docs/prior-arts/multica-findings.md:33`. It says Multica's `kimi.go` reuses Multica's own `hermesClient` ACP transport. It is not OAR support. "nous" as a word: 0 hits. | (verified: `grep -rniI hermes` in the clone; `gh search code hermes --repo botiverse/oar`) |
| Upstream issues, PRs, branches | No issue or PR mentions Hermes. Branch `docs/acp-agent-design` (PR #145, open) proposes `oar acp`, where OAR serves its runtimes *as* an ACP agent. That is the opposite direction and has no Hermes content. | (verified: `gh search issues/prs hermes`; `gh api .../compare/main...docs/acp-agent-design`) |
| Local checkout `/Users/chris/Projects/oar` | Stale: `f1a2b88`, v0.29.0, 2026-10-07. It also has no Hermes runtime. This plan uses upstream `main` as the current source. | (verified: `git log -1`, `packages/oar/package.json`) |
| Vendored fork `packages/client/vendor/oar/c264f17` | Codex closure only. No ACP, no Hermes. | (verified: `PROVENANCE.md`, `source-manifest.json`) |

Result: the claim holds. One correction to the issue text: "there is no upstream runtime to vendor" is true for a Hermes runtime. It is false for the ACP client machinery. OAR ships a tested, runtime-neutral ACP layer, and Hermes speaks standard ACP v1.

### 1.2 (a) What OAR already supports that Hermes can reuse

`packages/oar/src/shared/acp/` (2,250 lines, 19 files) drives any ACP agent over stdio:

- `session.ts` `acpSession(profile): StartSession`. It returns the same `StartSession` contract as `codexSession`. The SDK already bridges that contract.
- `profile.ts` `AcpSessionProfile`. A runtime supplies launch args, auth method selection, option validation, `configureSession`, capabilities, timeouts, extension notifications, resume rules, steer params, usage readers and outcome readers. Open handshake: `initialize`, optional `authenticate`, `session/new` or `session/resume`/`session/load`, model and effort.
- `turns.ts`: one active turn, `session/prompt` with no deadline, abort as `session/cancel` with a kill fallback after `abortTimeoutMs` (default 10 s).
- `client-app.ts`: permission requests auto-answered `allow_always`, else `allow_once`, else `cancelled`. `fs` is advertised false. `terminal` is advertised true and implemented in `terminal.ts`.
- `mcp-servers.ts`: maps `SessionOptions.mcpServers` into every open request. It refuses http servers unless the agent advertises `mcpCapabilities.http`.
- `records.ts`, `projection.ts`: every `session/update` becomes one verbatim record. The projection reads `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`.
- `failure.ts`, `errors.ts`: JSON-RPC -32000 is auth. The rest goes through a profile reader, then generic classification.
- Library: `@agentclientprotocol/sdk ^1.4.0`, lock `1.4.0`, Apache-2.0, peer `zod ^3.25 || ^4`. `PROTOCOL_VERSION` comes from that library (v1).
- Test fixtures: `tests/fixtures/fake-acp-agent.mjs` (300 lines, mode by argv) and `tests/fixtures/acp-session-support.ts`. Twenty-four `tests/acp/*` files.
- Concrete profiles are thin: Kimi `session.ts` 62 + `profile.ts` 71 lines, OpenCode `session.ts` 116, Grok `session.ts` 185. Most of each runtime directory is install, update, usage and model-list code.

(verified: research pass over `/tmp/plan519/oar-main`, file and line counts; `npm view @agentclientprotocol/sdk@1.4.0`; the same 19 files and the same `^1.4.0` dependency exist at `c264f17`.)

### 1.3 (b) What the SDK has already vendored

- `packages/client/vendor/oar/c264f17/`: OAR 0.67.0, 55 source files plus LICENSE. Fifty keep upstream bytes. Five carry `BYOK change` deltas: `runtimes/codex/{app-server-client,open,rpc-control,session}.ts` and `shared/session-kernel.ts`. Policy: follow upstream; change a file only where the SDK must own the process, environment, deadlines, record budget or interaction policy (`PROVENANCE.md`).
- The Codex session delta pattern: injected `SpawnLineProcess`, caller-supplied complete env, no `sealSession`, required `onRecord` consumer and `maxBytes` budget, caller-owned server-request handling (`vendor/oar/c264f17/runtimes/codex/session.ts:1-77`).
- Bridge: hand-written `packages/client/src/runtime/codex-session-runtime.{js,d.ts}`, checked against vendor types by `scripts/api-surface/oar-bridge-types.ts` and `check-oar-bridge.test.mjs`. Process tree bridge: `src/runtime/oar-process-tree.{js,d.ts}`.
- Manifest enforcement: `src/__tests__/oar-app-server-client.test.ts:311-316` requires the directory file list to equal `manifest.files` plus the two provenance files.
- Re-vendor procedure: rename the pin directory, re-apply upstream bytes, keep deltas, update hashes, bridges, `THIRD-PARTY.md`, spec and an upgrade note (`docs/notes/2026-10-18-pi-1.3-oar-0.67-upgrade.md`, PR #518).

ACP closure measured against the fork (upstream `main@5296675b`, relative imports from `shared/acp/session.ts`): 74 files. 32 are already vendored. 42 are new (about 4,600 lines): 19 `shared/acp`, 10 `shared/executable`, 7 `observe`, 5 `shared/*`, 1 `contracts`. Only `contracts/session.ts` and `contracts/session-options.ts` differ between `c264f17` and `main`. With Codex-style deltas (injected spawn, no seal, no client terminal host), the `shared/executable` set, `seal-session`, `session-credentials`, `environment` and `terminal.ts` (and its `cross-spawn` dependency) can stay out. S1 re-measures the exact set at `c264f17`. (verified: `/tmp/plan519/scripts/closure.mjs` and a manifest comparison script.)

### 1.4 Hermes ACP surface (local install, source read only)

Nothing was installed or modified. Only `hermes --version` and `--help` commands ran.

| Fact | Evidence |
| --- | --- |
| `hermes acp` and `hermes-acp` both run `acp_adapter.entry:main`. Python `agent-client-protocol==0.9.0`. `acp.PROTOCOL_VERSION = 1`. Runs with `use_unstable_protocol=True`. | `pyproject.toml:418,562`; venv `acp/meta.py:29`; `acp_adapter/entry.py:208` |
| **The entry builds a gateway viewer, not an agent.** `HermesACPAgent()` with no session manager returns `GatewayACPAgent`. Comment: "MCP discovery and execution belong to the gateway daemon; this process is a viewer." | `entry.py:201-202`; `server.py:254-258` |
| First session call runs `ensure_gateway_runtime(home, idle_exit=True)`. It spawns `python -m hermes_cli.main [--profile default] gateway run --quiet --idle-exit` with detached Popen, `stdin=DEVNULL`, Windows breakaway. The daemon ends itself after `gateway.unmanaged_idle_exit_seconds` (default 600). | `hermes_cli/gateway_client.py:215`; `gateway_runtime_start.py:31-71`; `gateway/run_idle_exit.py:1-20` |
| If the home already has an installed gateway service (launchd/systemd), `ensure_gateway_runtime` attaches to it. With the default `~/.hermes` home, an SDK turn would run inside the user's own long-lived gateway, with its messaging platforms, cron and kanban. | `gateway_runtime.py:390-430` |
| `gateway run --external-supervisor`: "an external process manager owns this foreground gateway". This is the hook for SDK ownership. | (verified: `hermes gateway run --help`) |
| `HERMES_HOME` relocates the whole home: config, `.env`, `state.db`, gateway. `hermes -p <name>` sets it. The viewer refuses a gateway whose `profile_id` differs (`profile_mismatch`). | `hermes_constants.py:97`; `gateway_server.py:155-157` |
| `initialize`: `loadSession: true`, `promptCapabilities.image: true`, session `fork`/`list`/`resume`. No `mcpCapabilities` (so stdio MCP only). `authMethods` lists the resolved provider only when credentials resolve. `initialize` does not contact the gateway. | `gateway_server.py:129-138`; `auth.py:14-51` |
| `session/new` forwards `mcpServers` to the gateway as editor MCP. It requires gateway capability `acp-editor-policy-v1`. Docs say MCP needs `acp-session-mcp-v1`. Edit approval policy is forced to `ask`. | `gateway_server.py:245-268`; `website/docs/user-guide/features/acp.md:64-77` |
| Updates: `agent_message_chunk` (from `message.delta` and `message.interim`), `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `available_commands_update`, `session_info_update`. | `gateway_server.py:785-799`; `gateway_reply.py` |
| No `fs/*` or `terminal/*` client calls. Tools run inside the gateway. It does call `session/request_permission` (approvals, edits, clarify) and `elicitation/create` when the client advertises form elicitation. | `gateway_server.py:884-947` |
| Cancel: `session/cancel` sends `prompt.cancel`, else `session.interrupt`. The prompt answers `stopReason: "cancelled"`. A failed turn raises `admitted_turn_failed`. | `gateway_server.py:383-418,572-642` |
| Errors: every non-`RequestError` exception becomes JSON-RPC -32603 with `data.details`. Provider and rate-limit errors have no distinct code at the ACP layer. | venv `acp/connection.py:228-237` |
| `hermes acp --check` imports `acp` and the agent and prints "Hermes ACP check OK". The import path runs `_early_recovery.restore_interrupted_pull()`, which is a stat-only no-op unless a killed `hermes update` left a marker. Every `hermes` command runs it. | `entry.py:25-28,113-117`; `_early_recovery.py:934-955` |
| Memory: `memory.memory_enabled`, `memory.user_profile_enabled` in `config.yaml`. `--ignore-rules` skips AGENTS.md, SOUL.md, memory and preloaded skills. | `cli-config.yaml.example:1021-1026`; `hermes --help` |
| `--safe-mode`/`--ignore-user-config` require `HERMES_MODEL` and `HERMES_INFERENCE_PROVIDER`. The launch flags reach the gateway through `session.create` client env. `-t`, `--skills`, `--in`, `--worktree`, `--pass-session-id` have no effect path under `acp` [UNVERIFIED]. | `gateway_server.py:43-55,254`; `gateway_chat.py:40-47` |
| `hermes chat -q --oneshot` also goes through the gateway. The idle-exit docstring names "one-shot `chat -q`" as a daemon source. A headless fallback does not avoid the gateway. | `gateway/run_idle_exit.py:4-6` |

### 1.5 (c) The gap this plan fills

| Need | OAR upstream | SDK today | This plan |
| --- | --- | --- | --- |
| ACP stdio client | Yes, `shared/acp` | No | Vendor it into the existing fork with Codex-style deltas |
| Hermes profile | No | No | New, about 100-200 lines, SDK-owned |
| Ownership of a detached agent daemon | No. OAR kills the viewer tree; Hermes's detached gateway would leak. | No | SDK starts and owns the gateway |
| Per-execution Hermes isolation | No | No | SDK-written `HERMES_HOME` in execution scratch |
| `RuntimeAdapter` wrapper, detect, egress, MCP, memory reader | n/a | Codex pattern exists | `HermesAdapter`, reuses daemon code |

### 1.6 Route decision (issue question 4)

| Option | Cost | Risk | Verdict |
| --- | --- | --- | --- |
| A. SDK writes its own ACP client from scratch | About 2,000 lines that duplicate `shared/acp` | Second ACP client to maintain. Grok (#514) would need a third or a later merge. | Rejected. Violates one source of truth. |
| B. Contribute `runtimes/hermes` to botiverse/oar first, then re-vendor | Upstream bar: experiment probe, `defineRuntime`, brand SVG, `OAR_TEST=hermes pnpm sea-trial`, aimock backend, runtime page of 500-800 lines (`docs/development.md` "How to add a new runtime") | Blocks on an external maintainer. Upstream would also have to solve the detached gateway. The gateway ownership policy is exactly the "process and environment" category that the SDK keeps as a delta anyway. | Not first. |
| C. Vendor OAR `shared/acp` at `c264f17`; SDK-owned Hermes profile and adapter | 42 new vendored files minus the excluded set; 3-5 deltas; about 200 lines of profile; adapter about 500 lines like Codex | Larger fork. The fork scope statement ("No ... ACP") changes. | **Recommended.** |

Under C, the profile is written in OAR's `AcpSessionProfile` shape, so it can go upstream later as `runtimes/hermes/session.ts` with no rewrite. Upstreaming stays optional and off the critical path.

## 2. Goals and non-goals

Goals:

- `HermesAdapter` implements `RuntimeAdapter` (`descriptor`, `detect`, `prepare`) with honest, self-declared capabilities. It qualifies through the shared conformance suite (`docs/adapter-capabilities.md`).
- The SDK owns every process the turn creates, including the Hermes gateway. Dispose leaves no Hermes process and no lock behind, on macOS, Linux and Windows.
- `detect` never writes to the Agent home or to `~/.hermes`.
- `messageEgress` consume works through the existing daemon closing reply.
- Task MCP toolsets (`byokagentmessage`, `byokagentmemory`, `byokagentresult`, host stdio toolsets) reach the Hermes session through ACP `session/new.mcpServers`. Nothing is written to `~/.hermes/config.yaml`.
- `memory-reader` executions leave `MEMORY.md` and `notes/` unchanged, measured by the existing reader digest. Hermes's own memory is off and lives in an isolated home.
- Gateway messaging platforms, cron and kanban do not run user work during a turn.

Non-goals:

- Hermes install, update, login, `hermes --setup`, model listing, account usage.
- `steer`, `resume`, fork, native interactions, interactive approvals, message drafts in v1.
- Reuse of the user's `~/.hermes` gateway, profiles, sessions, skills or memory.
- A built-in runtime id `hermes` in `@byok-sdk/protocol`.
- An upstream OAR contribution as a dependency.
- Grok (#514). This plan only keeps the vendored ACP layer reusable for it.

## 3. Process topology

```
SDK daemon (task-runner)
 └─ HermesSession (adapter)
     ├─ owned tree 1: hermes gateway run --quiet --external-supervisor
     │     env HERMES_HOME=<scratch>/hermes-home, cwd=<install root>
     │     └─ tool processes, stdio MCP servers (task toolsets)
     └─ owned tree 2: hermes acp           (ACP JSON-RPC over stdio)
           env HERMES_HOME=<same>, attaches to tree 1 via loopback WebSocket
```

Rules:

1. One isolated `HERMES_HOME` per execution, under `ExecutionScratch.runtimeDir`. `scratch.release()` deletes it in `close()`. The short scratch root (`validateScratchRoot`) keeps the gateway control socket path short.
2. The adapter writes `config.yaml` into that home before launch. It sets memory off, no messaging platforms, no cron jobs, and the toolset policy from §6. Credentials are not copied.
3. The gateway starts first, as an owned process tree (`withOwnedProcessTree`, Job Object on win32). The adapter waits for a readiness signal. Then it starts the viewer. The viewer finds a ready owner for the home and must not spawn a second daemon. [UNVERIFIED: the readiness signal and the no-spawn path. S0.]
4. A guard proves rule 3: after `session/new`, the adapter checks that the gateway the viewer reports is the owned PID [UNVERIFIED: how to read it. S0]. A mismatch is a fatal start failure.
5. Dispose closes the viewer, then terminates the gateway tree, then releases scratch.

If S0 shows that rule 3 cannot hold, stop. Do not ship a version that leaves a detached gateway. Report back to Aimpact with the measured behavior.

## 4. Adapter interface mapping

| SDK surface | HermesAdapter behavior |
| --- | --- |
| `descriptor.id` | `'hermes'`. A custom harness id: it passes `HarnessIdSchema` and is outside `RuntimeIdSchema`. The daemon puts it in `conn.hello.harnesses` and adds `custom-harness` (`create-daemon.ts:~963-991,~2247`). |
| `descriptor.supportsDispatchSelection` | `false`. Hermes resolves its own provider. The custom-harness contract makes `harnessId` exclusive with `dispatchSelection`. |
| `descriptor.progressEventsAreMessages` | `false`. Hermes streams `agent_message_chunk` deltas, like Pi. |
| `capabilities` | `steer: false`, `resume: false`, `approvalInteractive: false`, `mcpToolsets: true`. `nativeInteractions`, `messageDraft`, `durablePi` absent. |
| `detect(signal)` | §4.1 |
| `prepare(input)` | Reject `dispatchSelection` (`PolicyUnsupportedError`). Reject `sessionRef` resume (resume false). Re-run `detect`; reject non-retryably if not `available`. Return `{kind:'prepared', operation:{start}}`. Same shape as Codex (`codex-adapter.ts:~148-176`). |
| `operation.start(input)` | Preconditions as Codex: instruction kind, sealed `cwd`. Build the isolated home, start the gateway, then `acpSession(hermesProfile)` through the bridge with injected spawn, `cwd`, explicit env, `mcpServers`, record hooks. |
| `Session.prompt` / events | ACP `session/prompt` with the SDK instruction as one text block. Projection in §5.4. |
| `Session.interrupt` | §8 |
| `Session.steer` | Absent. Callers get the typed `SteerUnsupportedError` path that the conformance suite checks. |
| `Session.close` | Idempotent. Order in §3 rule 5. |
| Exports | `HermesAdapter`, `HermesAdapterOptions` from `src/adapters/index.ts` and `src/index.ts`. Not added to the daemon's built-in `buildAdapter` switch; hosts add it to their explicit adapter list, as #519 says aiphabee does (`packages/byok-host/src/runtime.ts:61-70`). |

`HermesAdapterOptions` (v1): `resolveBin?`, `spawnFn?` (tests), `model?`, `provider?`, `requestTimeoutMs?`, `interruptTimeoutMs?`, `gatewayReadyTimeoutMs?`. `model` and `provider` become `HERMES_MODEL` and `HERMES_INFERENCE_PROVIDER` in the child env.

### 4.1 detect

1. Resolve the binary: `BYOK_HERMES_BIN`, else `hermes` on PATH. Same pattern as `resolveCodexBin`.
2. `hermes --version` with the 5 s `probeRuntimeVersion` deadline. Parse `Hermes Agent v<semver>[+<build>]`. Compare with `QUALIFIED_HERMES_VERSION`. A mismatch is `advisory: runtime_version_unqualified`, not a refusal (Codex policy, `codex-version.ts`).
3. `hermes acp --check`. Expect exit 0 and "Hermes ACP check OK". Failure maps to `probe-failed`. Failure variants carry no diagnostics (`types.ts` `RuntimeDetectResult`). This plan does not add a new refusal reason, because `REFUSAL_REASONS` is a validated closed set (`runtime-detection.ts`).
4. Auth: start `hermes acp` once with `HERMES_HOME` set to a fresh `os.tmpdir()` directory and the same env a turn gets. Send `initialize`. `authPresent` is true when `authMethods` contains a provider method (`auth.py:23-51`). Kill the process tree and delete the directory. `initialize` does not start the gateway (`gateway_server.py:129-138`). This proves what a turn will see. It does not read `~/.hermes`.

Detect writes only to its own temp directory. The `_early_recovery` stat path in step 3 is shared by every `hermes` command and acts only on a broken update marker in the Hermes install tree.

## 5. ACP stdio protocol handling

### 5.1 Version

The ACP wire version is `1` on both sides: OAR's TypeScript `@agentclientprotocol/sdk` 1.4.0 and Hermes's Python `agent-client-protocol` 0.9.0 (`PROTOCOL_VERSION = 1`, schema ref v0.11.2). The two library version numbers are independent. Hermes uses unstable methods only for `session/resume`, `fork` and `list`. The v1 adapter uses `session/new` only, so it does not depend on them.

Issue question 1 answer: yes, one SDK ACP client can serve Grok and Hermes. Grok differs in profile data only (15 `_x.ai/*` extension notifications, auth selection, steer), which OAR already keeps in `runtimes/grok/session.ts`.

### 5.2 Handshake

- Client capabilities: `fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false`. Hermes never calls fs or terminal methods. The `terminal: false` value is a BYOK delta in `profile.ts` (upstream hard-codes `true`). It lets the fork drop `terminal.ts` and `cross-spawn`.
- `clientInfo`: keep upstream `{name:"oar"}` unless a delta is needed. Do not advertise `elicitation`, so Hermes clarify falls back to `request_permission`.
- `selectAuthMethod`: return the provider method if present. Never select `hermes-setup` (it launches an interactive setup that writes config). No provider method means a non-retryable `authority` failure with reason "Hermes provider credentials are not available".
- `session/new`: `cwd` is the manifest cwd (Agent home for writers, `<home>/.byok/runs/<taskId>/` for readers). `mcpServers` is the task map converted to ACP stdio entries `{name, command, args, env:[{name,value}]}` by OAR `mcp-servers.ts`.
- `validateOptions`: refuse `resume`, effort and model switches through `UnsupportedOptionError`.

### 5.3 Permissions

Hermes forces edit approval policy `ask`, so file edits arrive as `session/request_permission`. OAR answers `allow_always`, else `allow_once`. This matches ADR-037 (follow the local agent; Codex runs `danger-full-access` with approval `never`) and the rule not to add a second permission layer. Every request and answer is a verbatim record. Clarify questions get the same auto-answer; the descriptor keeps `approvalInteractive: false`.

The adapter also passes `--yolo` before `acp` [UNVERIFIED: whether `HERMES_YOLO_MODE` removes the edit round-trips in the gateway. S0 records both behaviors].

### 5.4 Projection to SDK events

| ACP update | SDK `AgentEvent` |
| --- | --- |
| `agent_message_chunk` | `progress` text delta. The daemon appends it to `finalTextParts`. |
| `tool_call`, `tool_call_update` | tool events. They reset the closing-reply window, as in Pi. |
| `agent_thought_chunk` | not projected (record only). |
| `plan`, `usage_update`, `available_commands_update`, `session_info_update` | record only. `usage_update` may feed usage later. |
| `session/prompt` answer `end_turn` | `turn_end` |
| `session/prompt` answer `cancelled` | interrupted turn |
| JSON-RPC error | failure, §9 |

Hermes maps both `message.delta` and `message.interim` to `agent_message_chunk`. If an interim message is a full restatement, the closing reply could contain duplicated text [UNVERIFIED]. S0 records a real turn. If duplication is real, the profile uses `attributeUpdate` or the `_meta` field to drop interim chunks.

## 6. Isolation, Hermes home, memory and subsystems

Issue question 2 answer: yes, `HERMES_HOME` relocates the whole home (`hermes_constants.py:97`). The `--ignore-user-config` + `--in DIR` alternative is not enough. It still uses `~/.hermes`, so the viewer attaches to the user's own gateway, including any installed service with live messaging platforms.

SDK-written `<scratch>/hermes-home/config.yaml` (exact keys confirmed in S0):

- `memory.memory_enabled: false`, `memory.user_profile_enabled: false`.
- No platform sections. No cron jobs. Kanban dispatch off (`HERMES_KANBAN_DISPATCH_IN_GATEWAY=0` if S0 confirms the switch).
- Toolsets: exclude cron, kanban, messaging send, memory, delegation and peer tools [UNVERIFIED: toolset names]. Keep terminal, file, web and MCP.
- No credentials in the file.

Credentials: the child env inherits the ambient env (ADR-037 D2, `buildRuntimeEnv`). Hermes resolves provider keys from env in the isolated home. Keys that a user keeps only in `~/.hermes/.env` or OAuth state in `~/.hermes/auth.json` are not visible. `detect` then reports unauthenticated. This is deliberate in v1 (§12 Q3).

Instruction files: do not pass `--ignore-rules`. It also drops AGENTS.md in the Agent home, which Codex reads for parity. The SDK memory guidance is in the instruction (`daemon/memory-guidance.ts`). Hermes memory is off by config, not by `--ignore-rules`.

Read-only memory: the daemon already measures reader executions with `readerMemoryBaseline` and `digestAgentHomeMemory` (`task-runner.ts:5275-5290`). Hermes's own memory files live in the isolated home, never in the Agent home. Qualification adds a three-turn reader test (§10).

Gateway subsystems: issue item "gateway, cron, kanban, peer must not start" cannot hold literally. The gateway is Hermes's execution engine. The enforceable form: the only gateway is the SDK-owned one, in an empty home, with no platforms, no cron jobs, no kanban work, and it dies with the execution (§12 Q2).

## 7. Session and transcript

- `Session.id` is the native ACP `sessionId`. The SDK records each wire frame through the `onRecord` hook, within the `maxBytes` budget (shared `session-kernel.ts` delta).
- Product transcript authority stays the accepted Agent message, as for every runtime. The Hermes `state.db` lives in scratch and is deleted at `close()`. Nothing in it is a product record.
- `resume: false` in v1. Bot mode runs a fresh execution per wake (ADR-036 D1), so egress and MCP do not need resume. A later version can keep a per-Agent-home Hermes home and use `session/load`. It must then handle Hermes load replay (`user_message_chunk` before the response) and `isResumeNotFound`.

## 8. Cancellation and process ownership

- `interrupt()`: OAR `abort()` sends `session/cancel`. The adapter waits for the prompt answer `cancelled` up to `interruptTimeoutMs` (default 1000 ms, like Codex). On timeout it calls `fail()`. OAR's own fallback kill stays at `abortTimeoutMs`.
- Tool processes run under the gateway. Whether Hermes kills them on cancel is [UNVERIFIED]. The SDK does not depend on it: the gateway tree is owned, so `close()` reaps them.
- `close()`: idempotent `closeAttempt`. Order: `raw.dispose()` (OAR sends `session/close` only if advertised; Hermes does not advertise it), viewer tree disposal, gateway tree disposal (`disposeOwnedProcessTree`: SIGTERM, 750 ms, SIGKILL, 2000 ms; win32 `taskkill /T /F` and Job Object), then `scratch.release()`.
- Gateway self-detach: on win32, Hermes's own spawn uses breakaway. The owned foreground `gateway run` does not spawn itself. With `--external-supervisor`, in-chat restart or update exits to the supervisor instead of spawning a replacement (verified: help text). S0 checks that no grandchild escapes the Job Object.
- Startup timeout: the daemon `startupTimeoutMs` (default 30 s) covers gateway readiness plus `session/new`. S0 measures cold start. If it exceeds 30 s, the adapter needs its own `gatewayReadyTimeoutMs` and Aimpact decides the default.

## 9. Errors

| Source | Signal | SDK result |
| --- | --- | --- |
| Binary missing / not executable | ENOENT, EACCES | detect `not-found` / `not-executable` |
| `acp --check` fails | non-zero exit | detect `probe-failed` |
| No provider auth method | `initialize.authMethods` | detect `available` with `authPresent: false`; start: non-retryable `authority` |
| Gateway not ready in time | readiness timeout | retryable `infrastructure` |
| Viewer attached to a foreign gateway | §3 rule 4 guard | non-retryable `infrastructure`, process trees disposed |
| `acp_policy_unavailable`, `profile_mismatch`, `acp_edit_policy_mutation_unavailable` | -32603 `data.details` | non-retryable `infrastructure` with the code in the message |
| `admitted_turn_failed` (provider, rate limit, model error) | -32603 | retryable `infrastructure`. Hermes gives no finer class at ACP [UNVERIFIED: S0 checks for detail in `data` or in the preceding updates]. |
| "Gateway disconnected; turn outcome is unknown" | -32603 | non-retryable. The outcome is unknown, so a retry could repeat side effects. |
| Process exit during a turn | OAR `exited` response | retryable `infrastructure` with the stderr tail |
| Empty reply with required egress | daemon | existing failure "runtime produced no reply text for the required Agent message" |

The profile `failureOutcome` reads `data.details` codes. It never matches on free English text beyond the gateway's fixed code strings.

## 10. Testing strategy

Fake runtime (no Python, no model):

- `src/__tests__/fixtures/fake-hermes.mjs`. One Node script. Mode by argv:
  - `--version`, `acp --check`: fixed outputs, env-controlled failures.
  - `acp`: an ACP v1 agent built from OAR `fake-acp-agent.mjs` behavior. Controls: `FAKE_HERMES_AUTH` (authMethods present or not), `FAKE_HERMES_INTERIM_DUP`, `FAKE_HERMES_HANG`, `FAKE_HERMES_FAIL_CODE`, `FAKE_HERMES_PERMISSION` (sends `request_permission`), `FAKE_HERMES_MCP_RECEIPT` (writes the received `mcpServers`, then spawns them and calls one tool), `FAKE_HERMES_ENV_RECEIPT`.
  - `gateway run`: a long-lived child that writes a readiness file in `HERMES_HOME`, spawns a grandchild, and optionally ignores SIGTERM (`FAKE_HERMES_GATEWAY_IGNORE_SIGTERM`). The viewer mode refuses to start if no ready gateway exists for its `HERMES_HOME`, and records a "spawned own daemon" marker if told to (`FAKE_HERMES_SELF_SPAWN`) so the §3 guard is testable.
- Tests:
  - `hermes-adapter.test.ts`: descriptor, prepare rejections, start preconditions, MCP map shape, env receipt (`HERMES_HOME` under scratch, `HERMES_MODEL`), config.yaml content, closing reply from chunks, interim duplication handling.
  - `hermes-detection-contract.test.ts`: every detect outcome; detect writes nothing outside its temp directory (snapshot a fake `HOME` and the Agent home before and after).
  - `adapter-capability-conformance.test.ts`: widen `QualifiedRuntime` to `'claude' | 'codex' | 'hermes'`. Hermes passes the shared contract: descriptor facts, resume rejected, follow-up, typed steer unsupported, no fork or rollback, `confirm` rejected before spawn, idempotent dispose while active.
  - Process tree: dispose with a SIGTERM-ignoring gateway and a grandchild; no PID survives (reuse `runtime-process-tree.test.ts` helpers; win32 in `win32-process-tree-quiescence.test.ts`).
  - Memory reader: three `memory-reader` turns against one Agent home; `agentHomeMemoryChange` stays unchanged for `MEMORY.md` and `notes/`.
  - Vendor: the existing manifest test covers the new files. Add an ACP bridge type check beside `check-oar-bridge.test.mjs`.
  - Vendored OAR ACP behavior: port the relevant upstream `tests/acp/*` cases (open errors, MCP servers, cancel) against the fork with the injected spawn.
- Live qualification (local only, not CI): `packages/client/scripts/hermes-acp-real.mjs`, like `codex-app-server-real.mjs`. It runs against the installed Hermes with a real provider. Paid calls need Aimpact approval per run. Results go to `tasks/runs/` (git-ignored) and the qualification row in `docs/adapter-capabilities.md` cites the record.

## 11. Packaging and dependencies

- New exact-pinned dependency in `packages/client`: `@agentclientprotocol/sdk` `1.4.0` (Apache-2.0, 5.6 MB unpacked, peer `zod`). Precedent: `@modelcontextprotocol/client` `2.0.0` is already an exact pin. `zod` must resolve for the client package; S1 adds it as a direct dependency if the peer is not satisfied by the workspace.
- Vendored fork: the ACP closure joins `packages/client/vendor/oar/c264f17/` at the same commit. One pin directory, one manifest. Rewrite the `PROVENANCE.md` scope statement and list each new delta. Update `THIRD-PARTY.md` (OAR row; new ACP SDK row).
- Expected deltas (S1 confirms): `shared/acp/session.ts` (injected spawn, explicit env, no seal, required `onRecord`), `shared/acp/process.ts` (injected `SpawnLineProcess`), `shared/acp/profile.ts` (`terminal: false`), `shared/acp/client-app.ts` (no terminal handlers). Everything else keeps upstream bytes.
- Bridge: `src/runtime/acp-session-runtime.{js,d.ts}` plus a type check in `scripts/api-surface/`.
- No Python dependency. Hermes is a user-installed CLI, like `codex` and `claude`.
- `api-surface/client.d.ts` golden and the `budgetBytes` entry change with the new exports. The ACP SDK types must not leak into the public `.d.ts`.
- Sealed host build (`packages/client/scripts/build-sealed-host.mjs`) and the `dist/assets/provenance/oar/<hash>/` copy must include the larger fork [UNVERIFIED: path names].
- Docs in the same slice as behavior: `docs/spec.md` (adapter list, vendoring paragraph), `docs/adapter-capabilities.md` (matrix row), `docs/architecture/sdk-architecture.md` §4.4.

## 12. Open questions for Aimpact

| # | Question | Recommended answer | Reason |
| --- | --- | --- | --- |
| Q0 | Does #519 (and #514) supersede Bot mode PRD Q4 ("no grok ACP adapter; vendor policy excludes ACP") and Q8 ("v1 Bot execution runtime is Pi only")? PRD v3 (#524) keeps both. | Yes for #519: record a PRD amendment that the SDK vendors OAR `shared/acp` and ships `HermesAdapter` as a custom harness. Keep Q8 for the Bot v1 launch gate; Hermes is an extra runtime choice, not a launch dependency. | Without this ruling, the plan contradicts a recorded owner decision. |
| Q1 | Route: SDK-first or OAR-upstream-first? | SDK-first with vendored `shared/acp` (option C). Upstream later, optional. | §1.6 |
| Q2 | Accept the reframed isolation rule: one SDK-owned gateway per execution, empty isolated home, no platforms, cron or kanban, killed at close? | Yes. | A literal "no gateway" is impossible; the gateway is the engine. |
| Q3 | Credentials in the isolated home: env only, or also read the user's `~/.hermes/.env` / `auth.json`? | Env only in v1. Document it. Reconsider an explicit opt-in later. | Symlinked `auth.json` would let OAuth refresh write into `~/.hermes`. Copying secrets creates a second credential store. |
| Q4 | Capability matrix v1 (issue question 3)? | `mcpToolsets: true`. `steer`, `resume`, `approvalInteractive` false. `nativeInteractions`, `messageDraft` absent. | Downstream needs egress and MCP only. Each extra capability needs its own qualification. |
| Q5 | Identity: custom harness `hermes`, or a built-in runtime id? | Custom harness. Downstream sends `harnessId: 'hermes'`. aiphabee#244 maps its runtime choice to `harnessId`. | No protocol version bump or gated wire addition. The built-in enum is frozen. |
| Q6 | Platform scope for qualification. PRD Q14 requires macOS and Windows for Bot v1. | macOS + Linux in the first release; Windows qualified in a follow-up slice before Hermes is offered on Windows devices. | Hermes's Windows gateway path (breakaway, windowless spawn) needs its own proof. |
| Q7 | Gateway cold start per execution (Python start, about 270 MB per the Hermes docstring). Acceptable? | Yes for v1 if S0 measures under 30 s. A per-Agent-home long-lived owned gateway is a later optimization. | Per-execution keeps isolation simple and matches fresh Bot executions. |
| Q8 | Pin a qualified Hermes version? | Yes, advisory only, like Codex: `QUALIFIED_HERMES_VERSION` from the S0 record. | Hermes moves fast (git install, `+1687` builds). |

## 13. Slice breakdown (for later Codex execution)

Each slice is one PR. Each runs the root checks: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`.

**S0. Evidence spike (no product code).** Gate for all later slices.
- Probe script in `/tmp`. Git-ignored record in `tasks/runs/`.
- Prove: (1) owned `gateway run --external-supervisor` in an isolated home; (2) readiness signal; (3) `hermes acp` attaches without spawning; how to read the attached gateway identity; (4) `session/new` with one stdio MCP server; the server is a gateway descendant; (5) one real turn: update sequence, interim duplication, `--yolo` effect on permissions; (6) cancel; (7) dispose leaves no process and no lock; (8) config keys for memory, toolsets, kanban; (9) cold start time; (10) `acp --check` and the detect `initialize` probe write nothing outside their homes.
- One paid model turn needs Aimpact approval.
- Output: a note under `docs/notes/` and updates to the [UNVERIFIED] items here. Stop and report if (3) or (7) fails.

**S1. Vendor the OAR ACP closure.** Depends on Q0, Q1.
- Add the measured closure at `c264f17` to the fork with the deltas in §11. Manifest, `PROVENANCE.md`, `THIRD-PARTY.md`, exact pin `@agentclientprotocol/sdk@1.4.0`.
- Bridge `src/runtime/acp-session-runtime.{js,d.ts}` and its type check.
- Port upstream ACP tests that cover open, MCP mapping, cancel and errors onto the fork with an injected spawn and the OAR fake agent.
- No adapter, no export.

**S2. Fake runtime and detect.**
- `fake-hermes.mjs`, `resolve-bin.ts`, `hermes-version.ts`, `detect()` and `hermes-detection-contract.test.ts`.

**S3. Session start, turn and egress.**
- Isolated home writer, gateway owner, viewer start, `hermes` profile, projection, `HermesAdapter` descriptor, prepare, start, close.
- Tests: adapter, conformance (`QualifiedRuntime` + `'hermes'`), closing reply through daemon egress.

**S4. MCP toolsets and memory reader.**
- `mcpServers` mapping with reserved SDK servers; MCP receipt test; three-turn reader digest test.

**S5. Cancellation and process trees.**
- `interrupt`, failure mapping table (§9), dispose ordering, SIGTERM-ignoring gateway, grandchild reap, win32 Job Object test.

**S6. Exports, docs and qualification.**
- Exports, api-surface goldens, `docs/spec.md`, `docs/adapter-capabilities.md` row, `sdk-architecture.md` §4.4, CHANGELOG.
- Live run with `hermes-acp-real.mjs` (approved paid calls) and the qualification record.

**S7 (deferred).** Windows qualification (Q6). Upstream OAR Hermes profile offer (Q1). Resume with a persistent per-Agent-home Hermes home. Message drafts from `agent_message_chunk`.

## 14. Risks

- The gateway topology fails S0. Then no safe adapter exists without an upstream Hermes change (for example an in-process ACP mode or a no-autostart switch). That would be a Hermes upstream request, not OAR.
- Hermes changes fast. The gateway viewer design is recent, and the in-repo developer doc (`website/docs/developer-guide/acp-internals.md`) already disagrees with the code. The advisory version pin and the live script are the guards.
- The fork grows by about 25-40 files. Each OAR re-vendor now also covers `shared/acp`. Grok (#514) would share the cost if Q0 also covers it.
- Env-only credentials (Q3) may mean many Hermes users see "unauthenticated" at first. Detect can only report `authPresent: false`, so the adapter docs must name the cause.
- Per-execution gateway start adds latency and memory to every turn.
