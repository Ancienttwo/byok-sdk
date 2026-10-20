# Adapter capability qualification

This matrix describes BYOK's exposed adapter contract, not everything an
upstream CLI might support. The production authority remains the immutable
`RuntimeAdapter.descriptor.capabilities` snapshot in `@byok-sdk/client`.
This document and the conformance expectations are evidence of that contract;
they are not a second runtime-selection registry.

## Current matrix

| Capability | Claude | Codex | Grok | Pi |
| --- | --- | --- | --- | --- |
| Resume a known native session | Supported; exact `--resume` identity | Supported; exact `thread/resume` identity | Supported; exact ACP `session/resume` identity | Not requalified in this slice |
| Redirect the active turn (`steer`) | Unsupported; typed rejection | Supported; exact active `expectedTurnId` | Unsupported; typed rejection | Not requalified in this slice |
| New instruction after an idle turn (`followUp`) | Supported, same native session | Supported, same native thread | Supported, same native session | Not requalified in this slice |
| Native session fork | Unsupported; no SDK `Session` operation | Unsupported; no SDK `Session` operation | Unsupported; no SDK `Session` operation | No new support introduced |
| Native session rollback | Unsupported; no SDK `Session` operation | Unsupported; no SDK `Session` operation | Unsupported; no SDK `Session` operation | No new support introduced |
| Legacy boolean interactive approval | Unsupported | Unsupported | Unsupported | No new support introduced |
| Native approval / structured question replies, default construction | Unsupported and omitted | Unsupported and omitted | Unsupported and omitted | No new support introduced |
| Local native interaction opt-in | allow-once / deny / cancel; structured AskUserQuestion | allow-once / allow-session / deny / cancel; structured question IDs | Unsupported; every permission request is answered `cancelled` | Unsupported |
| Recover pending native interactions after process restart | Unsupported | Unsupported | Unsupported | No new support introduced |
| Host browser/mobile reconnect | Host-owned; not native session resume | Host-owned; not native session resume | Host-owned; not native session resume | Host-owned |
| Trajectory evidence for the execution record (`trajectoryEvidence`) | Not declared; records are `unknown` | Not declared; records are `unknown` | Not declared; records are `unknown` | Declared (`event-stream`); not declared with `durablePi: true` |

By default Claude and Codex run YOLO
([ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md)): Claude with
`--dangerously-skip-permissions`, Codex with `approvalPolicy: never`. Native
interaction opt-in replaces those flags: Claude uses
`--permission-prompt-tool stdio --permission-mode acceptEdits`, Codex uses
`approvalPolicy: on-request`. Native request/reply support does not establish
an every-tool confirmation policy.

Pi is intentionally outside this qualification change. Existing Pi behavior
and its existing tests are unchanged; this matrix does not downgrade its
already implemented capabilities or certify them without evidence. Custom
adapters must qualify their own descriptor and behavior. Sharing an upstream
runtime name or using a custom harness does not inherit another adapter's pass.
The trajectory evidence row has its own Pi evidence; see
[Trajectory evidence](#trajectory-evidence).

## Grok

`GrokAdapter` runs Grok Build over ACP: `grok agent --always-approve
--no-leader stdio`, through the vendored OAR Grok profile
(`packages/client/vendor/oar/c264f17`). The ACP stack is a private entry that
loads at session start, so `@byok-sdk/client/adapters` carries no ACP
dependency.

- Identity: the descriptor id is `grok`. It is not a frozen wire runtime id,
  so a task selects it with the custom-harness identity (`harnessId: 'grok'`,
  server capability `custom-harness`). It takes no dispatch selection. The
  model is the `model` adapter option (`session/set_model`).
- Ownership: the SDK spawns, adopts and reaps the agent process and every
  `terminal/create` command Grok asks the client to run. Each gets the explicit
  task environment. The retained records have the same 16 MiB default budget
  as Codex.
- Permissions: Grok runs in its own approve-all mode. A permission request
  that still reaches the client (a user's own rule or hook) is answered
  `cancelled` and recorded. The SDK adds no second permission layer.
- MCP toolsets: task stdio servers go in the ACP `mcpServers` of
  `session/new` and `session/resume`.
- Closing reply: Grok streams text. The adapter emits one `progress` event per
  text run; a tool call or the turn end closes a run. The daemon publishes the
  last run as the closing reply when Grok does not call `send_agent_message`.
  Sub-agent sessions produce no events for the parent.
- Resume: ACP `session/resume` with the exact id. Its answer carries no id, so
  the resumed identity is the requested one by construction; the conformance
  identity-drift case does not apply. A missing session fails closed.
- Interrupt: `session/cancel`, then a wait for the cancelled prompt answer,
  bounded by `interruptTimeoutMs` (default 1000 ms). OAR still kills the
  process when Grok answers nothing for 10 s.
- Detection: `grok --version` (advisory when it is not the qualified 1.0.52,
  the newest OAR live evidence), `grok agent stdio --help` (else
  `refused: acp_unavailable`), and a login signal: `$GROK_HOME/auth.json`
  (default `~/.grok/auth.json`) exists, or `XAI_API_KEY` is set. The file is
  never read and no session opens.
- Agent memory: the daemon puts the memory guidance, including the
  memory-reader read-only rule, into the prompt text, so Grok receives it with
  each instruction. Grok loads `AGENTS.md` from the git root down to `cwd`, so
  a memory-reader run directory may not load the persona in the Agent home.
  That case has no live evidence.
- Platforms: macOS and Linux. Windows uses the shared process-tree path but has
  no Grok evidence.

The fixture suite proves the adapter contract against a fake ACP agent. It is
not live certification. No live Grok run is part of CI.

## Hermes adapter (custom harness)

`HermesAdapter` (id `hermes`, #519) is outside the matrix above and outside
the shared conformance runner, which assumes native resume. It runs on the
custom-harness path (`harnessId: 'hermes'`). Its descriptor declares:

| Capability | Hermes |
| --- | --- |
| Resume a known native session | Unsupported; each execution has a fresh Hermes profile, `prepare()` rejects `sessionRef` |
| Redirect the active turn (`steer`) | Unsupported; typed `SteerUnsupportedError` |
| New instruction after an idle turn (`followUp`) | Supported, same ACP session |
| Task MCP toolsets (`mcpToolsets`) | Supported; ACP `session/new.mcpServers` stdio entries |
| Legacy boolean interactive approval, native interactions, message drafts | Unsupported and omitted |
| Trajectory evidence | Not declared |

Hermes runs edits in ACP mode `dont_ask` and commands under `--yolo`. A
permission request that still arrives (Hermes's sensitive-path guard) is
answered `cancelled`. The adapter owns the Hermes gateway process tree and
checks the gateway identity before and after the viewer attaches.

Evidence: `hermes-adapter.test.ts` (synthetic `fake-hermes.mjs`, offline) and
the [S0 note](notes/2026-10-20-519-hermes-acp-s0.md), which records one real
Hermes `0.22.2+2364.g0b10b9f` turn with a fake model endpoint on macOS. No
live-provider run, Linux run or Windows run is part of this evidence.
`prepare()` refuses on Windows.

## What the qualification suite proves

`packages/client/src/__tests__/adapter-capability-conformance.test.ts` runs the
same assertions for the actual Claude, Codex and Grok adapters. Its test-only runner
lives in `fixtures/adapter-capability-conformance.ts`; it uses the established
prepared-operation path and existing synthetic CLI fixtures. It adds no
production transport, provider dependency, or package dependency cycle.

The shared default-construction assertions require:

- Immutable descriptor facts matching the adapter's behavior.
- Resume through the native operation, with the exact original session ID.
  Claude must emit the real `--resume` argument; Codex must emit
  `thread/resume` and must not silently use `thread/start`.
- Rejection of missing native sessions and mismatched returned identities.
- A separate idle follow-up that retains the native session identity.
- Positive steering evidence using the active Codex turn ID, or Claude's
  typed `SteerUnsupportedError`. Queuing a later turn is not steering.
- No advertised or callable SDK fork/rollback operation.
- Rejection of `confirm` before binary resolution or subprocess invocation.
- Explicit failure of both legacy approve and reject requests when the
  adapter cannot support the interactive product lane.
- Idempotent disposal while a synthetic turn is still active.

The fixtures use an isolated temporary HOME and an explicit environment.
They do not call a model provider or use a real login. A passing fixture
test establishes adapter-contract regression coverage, not live vendor
certification. Codex's existing version admission and the adapter-specific
fixture suites remain necessary evidence; this runner does not replace them.

From the repository root, after the normal frozen dependency install and build:

```sh
cd packages/client
bun run test src/__tests__/adapter-capability-conformance.test.ts
```

The root-required build, typecheck, test, API-surface and version-authority
checks remain release gates. Running only the command above is not a full
repository pass.

## Opt-in native interaction evidence

Constructing a Claude or Codex adapter with `nativeInteractions.onRequest`
enables a local Host callback and `Session.interactions`. The callback receives
its response channel directly, including a request arriving before session startup
returns; a Host must not wait for startup to finish before answering that request.
Neither the remote
boolean approval protocol nor a browser/mobile transport is added. Hosts use
the callback's exact request ID and channel to submit typed answers, and may
read a pending snapshot in that same live process. Restarted/resumed processes
receive a new generation and cannot answer the old process's requests.

- Claude uses the official stdio initialize/can_use_tool protocol. It never
  emits persistent permission updates. Questions preserve exact question text,
  selected labels, multiple selections and free text. Unknown native controls,
  reused IDs and malformed requests dispose the process.
- Codex 0.160.0 uses explicit `on-request` policy and verifies its readback;
  command/file decisions retain their native scope. Questions preserve native
  question IDs and answer arrays. Exact active-turn and resume-thread checks
  precede Host callbacks. Permissions profiles, dynamic tools and MCP
  elicitation remain unsupported.
- Native response writes have bounded acknowledged transport ownership.
  Duplicate equal answers join one result; conflicts/late answers cannot send
  another response. Native cancellation, timeouts, interrupts and process exit
  invalidate requests without converting them to steer text.

`structuredQuestions` describes the installed bridge capability. A task must
also expose the provider's question tool; the user's own agent configuration
can remove it. Native requests can also be bypassed by the provider's own allow rules, so an opted-in
Host must not infer that every tool call necessarily prompts.

The enabled-mode suites are `native-interactions.test.ts`,
`claude-native-interactions.test.ts`, `codex-native-interactions.test.ts`, and
`codex-native-write.test.ts`, with existing control/transport and OAR tests.
All are offline fixtures, not live-provider or desktop certification. Exact
inspected source revisions and hashes are in
[the native protocol inventory](researches/2026-10-06-native-interaction-sources.json).

## Native interaction qualification gate

The SDK interaction lifecycle may be tested independently of a provider
adapter. That does not qualify a provider wire mapping. Before an adapter can
advertise native approval or structured-question support, it needs verified
request and response schemas, exact native ID preservation, an explicit
supported decision set, and adapter tests showing a response reaches its
original native request. Unsupported request kinds must remain unsupported.

Qualification must also exercise cancellation, timeout, duplicate/late
responses, a closed or replaced session, and recovery of pending prompts
within a live session. A new process lifetime needs a new local generation
even if it resumes the same native session ID. A stored prompt or an old
browser form cannot authorize a reply in the replacement process.

Cross-process pending-interaction recovery and remote Host delivery are not
implemented by this matrix. Pending prompt display is not replay authority.
An approval answer is not a steer message. Follow-up text is not a structured
answer. Never substitute one operation to make an unsupported feature appear
to succeed.

## Trajectory evidence

`RuntimeAdapterDescriptor.trajectoryEvidence: 'event-stream'` declares
`Session.events` as the evidence source of the daemon's local execution record
(#553). The declaration states these facts:

- Every `tool_use` and `tool_result` carries its `toolCallId`.
- `turn_end` means that the runtime completed.
- `Session.evidence()` counts runtime output that the session could not turn
  into events: undecoded frames, unmapped frames, and tool results that the
  adapter made itself. The counts cover the whole session up to `close()`.
  A declaring adapter without `evidence()` states that nothing below its event
  stream can drop or invent a frame.

An adapter without the declaration gets `unknown` records
(`source_not_declared`). A declaration names the collection surface. It does
not prove that each run is complete. The record never changes the terminal or
a retry decision. Downstream read paths and display text are in section 7 of
the [downstream diagnostics guide](agent-diagnostics-integration.md).

- Pi: `PiAdapter` declares `event-stream`. With `durablePi: true` it does not
  declare it, because T0 did not verify the durable worker's own frames and
  respawn path. `PiSession.evidence()` counts stdout lines that are not a JSON
  object, an unterminated last line, and unmapped frame types. It reports no
  synthetic results. The evidence is the
  [Octop T0 note](notes/2026-10-20-octop-t0-pi-trajectory.md) and
  `pi-execution-record.test.ts`. T0 read the emit path of the pinned Pi 1.3.0,
  ran its core with a synthetic model stream, and replayed synthetic RPC
  records. No live Pi run or provider call is part of this evidence. A killed
  Pi process has no pairing guarantee. A run that a kill cuts short is
  `partial`.
- Claude and Codex: not declared. Slice T2 of #553 would add their counts.
  The owner decides on T2 after Pi verification.
- Custom adapters: declare only with your own evidence for the facts above.
  Treat the runtime's routine bookkeeping frames as expected, not unmapped.
  If you do not, every normal run is `partial`. A shared runtime name does not
  inherit the Pi declaration.

## References and ownership

- Source contract: `packages/client/src/types.ts`.
- Adapter evidence: `claude-adapter.test.ts` and `codex-adapter.test.ts`.
- Host recovery boundary: Host reconnect next step (`docs/researches/2026-10-06-host-reconnect-boundary.md`, untracked since #390).
- Architecture: [SDK architecture](architecture/sdk-architecture.md), especially
  the adapter and embedded server boundaries.
- Design reference: [T3 pinned revision](https://github.com/pingdotgg/t3code/tree/3e6b45028ceec5820dacb37dc3852470ebdc9411).
  The extraction adopts capability honesty and explicit lifecycle boundaries;
  it does not import a second agent runtime, WebSocket transport, or computer
  control surface.
