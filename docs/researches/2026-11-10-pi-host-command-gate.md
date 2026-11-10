# Pi Host command launch boundary (#1642)

Issue: [#1642](https://github.com/Ancienttwo/byok-sdk/issues/1642).
Decision: [narrow refusal](https://github.com/Ancienttwo/byok-sdk/issues/1642#issuecomment-6761211533).

## Finding and repair

With Pi 1.5.0 and pi-subagents 0.87.0, a Host instruction beginning with
`/run proof-child <task>` launched a native child without either a `subagent`
authorization or a `subagent_launch` authorization. The same held with `--bg`
in a real Bun-compiled product. Mid-text Host content, model text and tool
results containing the command did not expand.

Pi RPC `prompt` calls `AgentSession.prompt` with extension expansion enabled.
That method resolves leading extension commands before the input hooks and
model prompting. pi-subagents executes `/run` through its slash bridge using
a command context, which has no `executeTool`. Its workflow child approval
helper returns without a check for that context. The required child gate
protects the child's subsequent tools, not the launch.

Turning off `expandPromptTemplates` also disables `/skill:` and file prompt
templates. That would break the existing authorized-skill RPC regression in
`pi-rpc-host.test.ts`, so that path was rejected. The SDK instead rejects the
six commands below using Pi's actual resolved registry entry and source.
There is no SDK parser or text rewrite. Rejecting the registry lookup before
Pi's handler error catcher produces a failed RPC response with
`pi_host_command_denied`, rather than success with an extension notification.

The installed extension has a stable inline source name. Bundled hosts use
the shipped extension path. A different extension's colliding command remains
usable; the package command's resolved alias is refused. Each ordinary host
session installs the boundary, including replacement sessions. A prompt,
steer or follow-up after reload guards the new registry before dispatch.

## RPC ingress inventory

| RPC entry | Pi 1.5.0 path | Boundary and regression |
| --- | --- | --- |
| `prompt` | `rpc-mode.js:298` → `session.prompt` → command lookup | Refuse before handler; preserve skills/templates |
| `prompt` with `streamingBehavior: steer/followUp` | Same prompt method dispatches extension commands before queueing | Same boundary; rejected commands never enter a queue |
| `steer` | `rpc-mode.js:319` → `session.steer` → `_queueUserInput` | Same registry check; preserve expanded skill/template input when the queue drains |
| `follow_up` | `rpc-mode.js:323` → `session.followUp` → `_queueUserInput` | Same registry check; preserve expanded skill/template input when the queue drains |
| Previously queued user input | `_queueSteer` / `_queueFollowUp` → agent queues | Command rejection occurs before enqueue; expanded skill/template messages remain content |

Native `steer` and `follow_up` already refused registered extension commands
with “cannot be queued.” They do not expand extension commands by calling
`session.prompt` later. Their SDK failures now use the same specific refusal
as `prompt`. Model messages and tool-result messages are appended to agent
context; their text is not submitted to this command dispatcher.

## Pinned command inventory

The drift test scans every upstream source registration and also checks the
live ordinary-host registry. A new registration requires classification.
`pi-subagents-bridge` belongs to the separate pane bridge and is not registered
by the ordinary root extension.

| Command | Disposition and reason |
| --- | --- |
| `run` | Refused: native child, including `--bg` and `--fork` |
| `prompt-workflow` | Refused: one or more workflow children |
| `subagents-refine` | Refused: proposal child when bounded evidence exists |
| `subagents-check-profile` | Refused: launches Pi model-probe processes |
| `subagents-refresh-provider-models` | Refused: live Pi model probes when refreshing |
| `subagents-generate-profiles` | Refused: catalog refresh can launch those probes |
| `subagents` | Allowed: metadata administration |
| `subagent-cost` | Allowed: cost report |
| `subagents-doctor` | Allowed: diagnostics |
| `subagents-inspect-rpc` | Allowed: inspect an existing child |
| `subagents-guide` | Allowed: packaged guide |
| `subagents-fleet` | Allowed: inspect existing fleet |
| `subagents-detach` | Allowed: detach an existing child |
| `subagents-stop` | Allowed: stop an existing child |
| `subagents-steer` | Allowed: existing child; explicitly disables steering recovery |
| `subagents-models` | Allowed: model mappings |
| `subagents-profiles` | Allowed: list saved profiles |
| `subagents-load-profile` | Allowed: settings and current model selection |
| `subagents-watchdog` | Allowed: watchdog configuration and its in-process reviewer, not a subagent runner |
| `pi-subagents-bridge` | Allowed: separate pane bridge dispatch, no subagent launch |

## Runtime evidence

Measured locally on macOS 26.5 arm64, Bun 1.4.3, Node v24.18.0. The runtime
assets report Pi 1.5.0 and pi-subagents 0.87.0. Tests and probes use only the
runtime-contract loopback provider and synthetic credentials.

The payload regression compiles the built SDK root and the existing product
host entry with `bun build --compile`, and ships assets with
`copyPiRuntimeAssets({ form: 'compiled-executable' })`. It records runner
re-entry before the reserved helper dispatch and records authorization calls.
The positive workflow control must produce both the runner marker and a
nested `subagent_launch` request, so the negative checks cannot pass because
those recorders are disconnected.

| Compiled case | Outcome | Child model requests | Launch authorization |
| --- | --- | ---: | --- |
| Exact Host `/run` | Failed start: `pi_host_command_denied` | 0 | None |
| Host `/run --bg` | Failed start: `pi_host_command_denied` | 0 | None |
| Host mid-text `/run` | Literal user content; no runs in status | 0 | None |
| Model text `/run` | Literal assistant output; no runs in status | 0 | None |
| File-tool result `/run` | Literal result and subsequent model input; no runs in status | 0 | Read only, then explicit status query |
| Workflow tool control | Workflow and child complete | 1 | `subagent`, then nested `subagent_launch` |

A separately retained compiled probe produced executable SHA-256
`4ecc2f5a57a9b5a3dee05a8e7ec53cd87cf6c14e2f00798d04f0140a1448427f`.
Its verifier confirmed the same six outcomes. The workflow control's
`subagent_launch` had `parentToolCallId: call_1`; the child and workflow both
recorded `state: complete`. The synthetic child returns a marker without the
upstream structured acceptance report, so the separate post-execution
attestation is rejected; this does not prevent observing its completed
execution or authorization.

## Verification

Commands run against the change:

```sh
bun run build
bun run typecheck
bun run --cwd packages/client test src/__tests__/pi-rpc-host.test.ts src/__tests__/pi-host-payload.test.ts src/__tests__/pi-subagent-extension-order.test.ts src/__tests__/pi-scoped-subagent.test.ts src/__tests__/pi-tool-authorization.test.ts
bun run check:api-surface
```

Build, typecheck and API checks passed. The affected suites passed 77 tests;
two existing payload forms were skipped because the local Homebrew Node is
not relocatable and no official Node SEA binary was configured. The required
Bun-compiled regression ran. No public declaration changed. The private Pi
host closure grew by 1,211 bytes, from 555,793 to 557,004; its exact budget and
generated README row were updated.

Red-green proof: temporarily omitting the session boundary caused all three
RPC-entry regressions to fail. `prompt` unexpectedly returned success for
`/run:2`; `steer` and `follow_up` returned the native queue error instead of
the SDK refusal. Restoring the boundary made all three pass. No existing
assertion was removed or relaxed.
