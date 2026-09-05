# Cross-harness Team MCP probe — 2026-09-05

## Conclusion

PASS for the bounded native-protocol probe: Claude, Codex and Pi each used the existing Team MCP interface in one persistent native session for two externally triggered turns. Six exact replies were persisted, with twelve reads and six covering acknowledgements. This supports integration work, not a rewrite of the communication layer.

This does not establish autonomous wakeup, interactive TUI notification, process restart/resume, private-message isolation, or full daemon/TaskRunner integration. Each process had a distinct membership lease and native session, but used existing local provider authentication; this is not an OS credential-isolation test.

## P1: Observed boundaries

- `packages/client/src/daemon/team-workspace.ts`: authoritative local membership, lease, durable messages and delivered/ack cursors.
- `packages/client/src/bin/team-mcp-server.ts`: post/read/ack tools.
- `packages/client/src/bin/sdk-reserved-helper-runners.ts`: real helper, authenticated local control connection and original tool handlers.
- `packages/client/src/adapters/pi/mcp-extension.ts`: existing Pi MCP bridge, explicitly loaded with a probe-only config.
- Probe-only `team-fixture.ts` composes the actual store, control server, production parameter parsers and helper. It does not start an enrolled daemon or acquire a managed AgentHome lease.
- `native-probe.py` owns disposable native processes and externally requests each turn. No tmux or screen-derived control is involved.

Baseline: `12278dc429bd15660190e237e0f6c97d654d5643`. Platform: local macOS. Fixture runtime Bun 1.4.0; Pi runtime Node 24.18.0. These results are not Node 22 source acceptance.

## P2: Real traced path and results

Operator seed → authenticated control → TeamWorkspace commit → native user-input protocol → model calls MCP read → native tool result enters context → model posts exact synthetic reply → read → ack → native turn completion. The driver then posts a second challenge and sends input to the same still-running process/session.

| Harness | Tested version / entry | Completion authority | Same-session two turns | MCP read/post/ack |
|---|---|---|---|---|
| Claude | 2.1.261, print stream-json input/output | `result`, subtype `success` | PASS | PASS |
| Codex | 0.153.4, app-server stdio, thread/start + turn/start | `turn/completed` | PASS | PASS |
| Pi | package-local 0.84.2, RPC + existing MCP extension | `agent_settled`, get_state sessionId | PASS | PASS |

Global Pi 0.84.4 was not the model-probe subject. The SDK's package-local dependency is authoritative. Pi used existing configured zai/glm-5.3. Claude/Codex used their existing model selection; no global model configuration was changed.

Exact native session IDs, synthetic messages, seq values and timestamped control receipts are in [results.json](evidence/2026-09-05-cross-harness/results.json). The verifier requires two identical session identities per harness, exactly two expected durable replies per member, four reads and two acknowledgements per member, and twelve total messages (six challenges plus six replies). It does not infer business completion from ack.

## P3: Decision

Retain TeamWorkspace and Team MCP. The missing observed behavior is the connection from committed peer messages to a controlled native turn, plus ownership and lifecycle around that connection. Implementing a second message store or replacing TaskRunner would not resolve a demonstrated failure here.

Keep collaboration semantics independent of tmux. tmux remains a candidate terminal host for visible native CLI processes; it does not own context sharing or delivery. The successful headless protocols cannot be assumed to attach to an already-running interactive TUI. Native queue/extension capabilities must be tested against the actual desired terminal shape before committing to that host.

At 10x room/message activity, current whole-state read/write and repeated notifications/model turns are the first identified pressure points. Bounded reads, publish idempotency, notification budgets and lease renewal remain candidate follow-up contracts, not changes authorized by this probe.

## Reproduction and evidence boundary

Create a private `/tmp/byok-harness-probe-*` directory. Start `bun team-fixture.ts start <scratch>` from the evidence directory, then use Python 3.11+ to run `native-probe.py <scratch> claude`, `... codex`, `... pi`. Finally run `verify-probe.py <scratch>` while the fixture is alive. Provider authentication must already be configured locally. No credential values are needed in prompts or command arguments.

The driver limits individual event waits (100 seconds for a model completion), terminates its process group in finally, and keeps raw native streams private in scratch. Only allowlisted result metadata and synthetic messages are exported. The original fixture must be stopped by its owner after verification; disposable member contexts should then be removed.

Initial Codex driver invocation used the system Python without tomllib and failed before process launch. It was rerun with `/Users/kito/.local/bin/python3.11`; no product fix was involved. Probe processes were deliberately terminated after both turns, so SIGTERM exit codes in results are cleanup, not model failure.

Claude used strict MCP config, no builtin tools and disabled hooks. Pi explicitly disabled ambient extensions/context/skills and exposed only direct team tools. Codex disabled configured ambient MCP servers and shell/multi-agent/apps features, but its native hook events were still observed: this is not proof of a fully isolated Codex configuration or hook-free launch. No raw hook output is exported.

## Verification and unproven surfaces

- `verify-probe.py`: PASS; 3 sessions / 6 replies / 12 reads / 6 acknowledgements.
- `git diff --check`: PASS.
- `repo-harness run check-task-workflow --strict`: PASS on final live retry. Earlier CLI export mismatch is historical; no toolchain repair was performed by this task.
- Production build/typecheck/full suite not run: this slice adds research/probe artifacts only, no production code. Existing unrelated checks are not reused as probe acceptance.
- Not tested: Codex `queue`, Pi busy steer/follow_up, Claude busy delivery, approval or human input races, autonomous peer loop, tmux ownership, process resume, lease expiry/renewal, cloud/local home contention, Linux, native Windows or WSL.
- One shared room was tested. It is not six-direction private-room or membership-rejection acceptance.

## Approved native notify slice — 2026-09-05/06

The user approved the idle/busy/approval/human-draft probe after the initial MCP integration result. Scope remained disposable native sessions and research artifacts. This section supersedes the earlier “not tested” entries only for the exact cases below.

### P1: Additional native surfaces

- Codex 0.153.4: `codex queue --remote <owned endpoint> --thread <exact UUID>` invokes `thread/queue/add`. A dedicated loopback app-server was used, with ambient MCP servers and hooks disabled. Queue requires a non-ephemeral thread. Local source explains enqueue/idle dispatch in `codex-rs/tui/src/session_queue_commands.rs:86`, `app-server/src/request_processors/thread_queue_processor.rs:78`, and `ext/queue/src/service.rs:264` under `/Users/kito/Projects/codex` at `9ab176f488f5da100984a005688f041d49e06bdb`. That checkout is explanatory source, not proof of the installed binary's build commit.
- Pi package-local 0.84.2: the actual interactive TUI loaded one disposable extension. `pi.sendUserMessage(..., {deliverAs:'followUp'})`, `ctx.ui.getEditorText`, `ctx.ui.confirm`, `ctx.isIdle` and `agent_settled` were used directly. Public local API evidence: `dist/core/extensions/types.d.ts:924`, `dist/core/agent-session.js:1107`, and `dist/modes/interactive/interactive-mode.js:1870` in the package-local dependency.
- Claude 2.1.261: ongoing print `stream-json` input and the `can_use_tool`/`control_response` host contract were inspected. Installed embedded source also exposes hidden `--messaging-socket-path` and authenticated UDS user frames (byte offsets around 177009500–177030000 in the installed binary). This is an internal candidate, not a publicly promised compatibility surface. Its runtime delivery was not established.
- `notify-mcp.py` supplies synthetic record tools and an externally released tool gate. These are instrumentation, not new TeamWorkspace tools. The first slice already proved real Team MCP interoperability; repeating that evidence was unnecessary here.

### P2: Actual state matrix

| Harness / actual entry | idle | busy | approval | human draft |
|---|---|---|---|---|
| Codex queue → dedicated app-server | PASS: automatic turn starts after enqueue | PASS: queued behind held tool, executes after release | PASS: remains queued while MCP approval pending; explicit decline precedes queued execution | PASS in attached real TUI: queue does not submit draft; explicit Enter yields exactly the original userMessage |
| Pi sendUserMessage → actual TUI extension | PASS | PASS with followUp behind held tool | PASS for confirmation inside an executing tool; **idle UI confirmation is not a gate** | PASS: exact getEditorText sentinel retained through notification, tool completion and confirmation |
| Claude print stream-json | PASS | BLOCKED before tool entry by provider refusal | UNVERIFIED after refusal | UNVERIFIED: print has no editor; separate hidden TUI attempt stopped at workspace trust before MCP startup |

Codex trace: native queue receipt → queue/list confirms one pending input while tool/approval is blocked → controlled release or matching explicit decline → synthetic tool receipt. Draft trace: type without Enter in owned TUI → native queue processes notification → explicit Enter → app-server userMessage exactly matches original draft. Terminal capture was diagnostic only; the userMessage is the draft readback oracle. Busy and approval were tested via app-server, not by observing TUI widgets.

Pi trace: extension receives a synthetic file trigger → sendUserMessage followUp → native model loop → instrumented tool → agent_settled. Editor state is read directly through the TUI API. For in-turn approval, a notification did not resolve `confirm`; explicit Escape returned false, and only then did the follow-up tool run.

Pi counterexample: open extension `ctx.ui.confirm` while no model turn is active → `ctx.isIdle()` remains true → sendUserMessage starts a model turn while that dialog is still unresolved. The tool receipt records `pendingConfirm:true`; explicit Escape occurs later. Therefore “agent idle” does not imply “no pending UI interaction.” Pi has extension-owned confirmations, not a built-in permission policy equivalent to Codex/Claude. A future binding must define which interactions it owns and blocks; a private Boolean cannot prove absence of dialogs owned by other extensions.

Claude provider result: busy setup returned `reasoning_extraction` refusal before the controlled tool was entered. The result simultaneously reported `subtype:'success'`, `is_error:true`, `stop_reason:'refusal'`, and `terminal_reason:'api_error'`. No queue failure can be inferred. The driver was tightened to fail promptly on error/refusal; this was a probe-only error-reporting correction, not a model retry. No alternative model or rewritten request was used. TUI startup independently timed out at the disposable directory's workspace-trust prompt before the MCP child/socket oracle; no UDS notification was sent, and that lane was not retried.

### P3: Narrow implementation ruling

No communication-core refactor is warranted. Codex queue is a verified candidate for a thin exact-session binding. Pi followUp is a verified TUI entry, but integration requires an explicit pending-interaction contract beyond isIdle. Claude remains a capability acceptance gap: print support does not prove external control of an existing TUI, and the hidden UDS route is neither runtime-accepted nor a stable public API.

Keep tmux as optional terminal hosting; it cannot solve the Pi interaction gate or establish Claude input semantics. No native notification failure falls back to terminal keystrokes. Synthetic typing/Escape in these owned tests represents the human side of the experiment, not a proposed notification mechanism.

### Evidence, verification and cleanup

- `codex-notify-results.json`: idle/busy/approval observations and synthetic tool receipts.
- `codex-draft-results.json`: actual TUI exact submitted text, native item metadata and receipts.
- `pi-notify-results.json`: single session ID, editor/idle/modal states and tool timestamps, including the counterexample.
- `claude-notify-results.json`: provider error flags and deliberately blocked cells.
- `claude-tui-notify-results.json`: startup precondition failure; no UDS send receipt.
- `verify-notify.py`: PASS offline assertions for ordering, draft readback, same Pi session and modal counterexample, and preservation of Claude's blocked outcome. This PASS means evidence consistency, not all harness capabilities passing.
- Python syntax, new-artifact whitespace, `git diff --check`, strict workflow: PASS. No production code/build/full suite changes or claims.
- Codex's first draft attempt tried to resume a thread with no first turn and failed because no rollout existed. One probe adjustment added an initial completed turn; the second draft attempt passed. This is not restart/resume reliability acceptance.
- Codex global `notify` is separate from hooks: the first protocol run invoked an existing turn-end notifier despite `features.hooks=false`. Later launches also set per-process `notify=[]`; no global settings were changed. The notifier exited, and no owned probe process remained.
- Owned probe process groups were stopped. The two Codex sessions with actual turns were deleted through exact-UUID native CLI. Deletion of the first no-rollout draft session returned an error; no active process or rollout was established for that failed bootstrap, and it was not repaired. Exact cleanup output is in `notify-cleanup.json`.
- Raw terminal/protocol streams and scratch directories are disposable; only synthetic/allowlisted evidence is retained. No provider credential or native messaging token is exported.

Remaining acceptance boundary: Claude busy/approval/TUI evidence requires a functioning authorized provider path and an explicit decision about the supported notification interface. Pi's pending-interaction semantics must be specified before automatic integration. No production binding, tmux management, cross-device communication, or full three-harness autonomous room has been delivered by this slice.

## Claude acceptance continuation — 2026-09-06

The user approved completing the remaining Claude cells. One fresh-session recheck used the same installed CLI 2.1.261, provider/model selection, system prompt and synthetic tool requests; no model substitution or request rewriting was used. The original refusal evidence remains intact.

- Idle succeeded again.
- Busy setup again returned provider `reasoning_extraction` before `probe_gate` entered. Exact request ID: `req_011CekazPpwHBRFuwz4bBuVA`. Native terminal flags again were `subtype:success`, `is_error:true`, `stop_reason:refusal`, `terminal_reason:api_error`.
- The corrected probe detected this terminal error promptly and stopped. Busy behavior is not measured; approval remains unverified. A second fresh model recheck was not attempted.
- Independent **no-model TUI startup** passed. The initial workspace-trust screen was observed, and the probe explicitly selected trust only for its owned temporary directory. With hidden `--messaging-socket-path`, the actual MCP child received both socket and token metadata. Only presence booleans were exported; the credential value remained inside the child. No user prompt, UDS notification, or model tool call was sent in this startup check.
- Consequently the workspace-trust/MCP-startup precondition is now established, while actual UDS delivery and TUI draft preservation remain unverified. This does not turn the hidden interface into a public stable contract.

P1 remains native Claude input/permission handling versus BYOK message authority. P2 ends at the provider refusal before the busy gate, while the independent TUI path reaches trusted startup → MCP child → native socket/auth metadata. P3 is to preserve the existing communication design and stop dependent model probes until the provider refusal is resolved; tmux or a new message layer would not resolve this observed blocker.

Evidence: `claude-notify-recheck-results.json` and `claude-tui-startup-results.json`. Offline validation requires refusal flags/category, absence of a busy tool entry, startup capability presence and absence of any UDS send/model tool event. No prior blocked evidence was overwritten. Native `claude project purge --dry-run` identified only the owned temporary project's trust entry; the exact-path purge removed that entry, without touching other projects. Probe processes and private scratch are cleaned after export. No production source or global model/auth settings changed.
