# OpenCode native onboarding qualification (#1538, PR 3)

Date: 2026-11-08 (Asia/Taipei). Implementation subject:
`e6ee3a1cabe8a38846b76635ca0816623b8c90fe` (PR #1545).
OAR closure: 0.94.0, `45488e745abc9e320da9adb2df851b249160c74e`.

This record distinguishes native CLI observations, SDK adapter canaries and
controlled replay coverage. A missing native gate does not qualify a platform,
version or capability. Local checks do not establish hosted CI or release
acceptance.

## Method and boundary

- The native canary calls the built `OpenCodeAdapter` through `prepare`, a
  sealed operation manifest and SDK-owned execution scratch. It observes real
  ACP requests and replies through `spawnFn`; it supplies no synthetic reply.
  Normal daemon admission remains gated by the descriptor's empty platform list.
- The Host candidate configuration is, in order,
  `opencode/deepseek-v4.1-flash-free`, `opencode/crouton-alpha-free`,
  `opencode/beam-free`. These are canary inputs, not SDK product defaults.
- Model selection must be explicit and the native readback must match before
  prompting. An initial native default model is not selection authority.
- macOS uses the existing official-installer executable, discovered by the
  adapter's PATH/official-location resolver. No installation or upgrade was
  performed on the Mac. The CLI inherits the native user's environment and
  configuration; no SDK home, auth-store read or credential injection is used.
- Linux uses a disposable colima container on aarch64, Debian 12. Neither a
  configured binary nor a PATH installation existed there. Official npm packages
  `opencode-ai@1.19.5` and `@opencode/cli@2.2.6` were installed into separate
  prefixes so neither line overwrote the other. The verified executables were
  then supplied explicitly by the canary Host. No Mac home or credentials were
  mounted. The canary was bundled from the subject's built adapter and SDK
  manifest/scratch helpers, then copied into the container; it did not depend
  on the Mac's architecture-specific dependency installation.
- A first-completion deadline is 180 seconds. A watchdog termination is harness
  cleanup, never evidence of successful SDK cancellation or disposal. Process
  snapshots compare against the pre-run process table and count owned roots
  and new `serve --service` processes. Subsequent gates are unrun after a failed
  prerequisite.
- Native diagnostic runs bypass the SDK entirely:
  `opencode run -m <Host candidate> "reply ok"`, with a 120-second deadline.
  Probe-owned process groups are terminated after a timeout. No login, model
  listing or deliberate rate-limit traffic is used.

## Results

Each combination remains unqualified because its completion gate did not pass.

| Native OS / architecture | Version output | Model | Native adapter result |
| --- | --- | --- | --- |
| macOS 26.5 / arm64 | `1.19.5` | first Host candidate | Prompt sent; completion deadline expired; native diagnosis below |
| Linux Debian 12 / aarch64 (colima) | `1.19.5` | first Host candidate | Prompt sent; no post-prompt frame or completion within 180 seconds |
| Linux Debian 12 / aarch64 (colima) | `opencode v2.2.6` | first Host candidate | Native `provider.free-limit` refusal; no fallback or completion |
| Windows 11 Pro 10.0.26100 / x64 | `opencode v2.2.6` | first Host candidate | Native free-usage quota refusal; no fallback or completion |

| Release gate | macOS v1 | Linux v1 | Linux v2 | Windows v2 |
| --- | --- | --- | --- | --- |
| Native detection and open | pass | pass | pass | pass |
| Explicit Host model and matching readback | pass | pass | pass | pass |
| Prompt submission | observed | observed | observed | observed |
| Completion | timeout | timeout | quota refusal | quota refusal |
| One pre-output rate-limit fallback | not observed | not observed | not applicable to quota cap | not applicable to quota cap |
| Resume and completion | unrun | unrun | unrun | unrun |
| Different-cwd refusal | unrun | unrun | unrun | unrun |
| Native permission refusal | unrun | unrun | unrun | unrun |
| Cancel and process-tree cleanup | unrun | unrun | unrun | unrun |
| SDK disposal | unproven; watchdog cleanup only | unproven; watchdog cleanup only | pass for refused turn only | pass for refused turn only |

### macOS v1

Observed ACP sequence: `initialize`, `session/new`,
`session/set_config_option` with `configId: model` and the first Host candidate,
then `session/prompt`. The native selected-model readback matched the Host
candidate. No completion, permission request or rate-limit response was observed
before the 180-second deadline. The timeout snapshot contained one live owned
ACP root and zero `serve --service` processes. An independent process snapshot
after watchdog termination found no remaining ACP or service process. This is
not a cancellation/disposal pass; resume, cwd refusal and permission refusal
remain unrun.

Plain native DeepSeek also exceeded 120 seconds with no stdout; stderr contained
only the selected-model banner. The completion stall therefore reproduces
outside the SDK. This does not establish whether the upstream CLI, provider or
network caused the stall, and does not establish an SDK projection defect.

All three permitted native diagnostic runs reproduced the stall:

| Plain native Host candidate | Measured deadline | Stdout | Stderr |
| --- | --- | --- | --- |
| `opencode/deepseek-v4.1-flash-free` | 120.0 seconds | empty | Selected-model banner only |
| `opencode/crouton-alpha-free` | 120.1 seconds | empty | Selected-model banner only |
| `opencode/beam-free` | 120.1 seconds | empty | Selected-model banner only |

Each probe terminated its own native process group at the deadline. A final
independent macOS process snapshot found no surviving canary CLI or service.
No further native retry was performed after this three-run diagnostic budget.

One separately authorized read-only check ran
`opencode models opencode` on the installed v1 1.19.5 CLI. It exited zero in
2.1 seconds with no stderr and listed all three Host candidates. This shows
they remain catalogued on v1; a model listing does not prove current inference
availability and was not used for admission or qualification. No additional
model call was made for this check.

### Linux v1

Version detection, `initialize`, `session/new`, explicit Host model selection,
matching readback and `session/prompt` were observed. No incoming ACP frame
arrived after the prompt before the 180-second deadline. One owned ACP root
was live at timeout and no `serve --service` was present. After watchdog
termination, an independent container process snapshot found no ACP or service
survivor. Completion, resume, cwd refusal, permission refusal, SDK cancellation
and SDK disposal are unproven. No rate-limit response or fallback was observed.

### Linux v2

Version detection, open and explicit first-candidate model readback passed.
The first prompt received this native JSON-RPC error, before any output:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32603,
    "message": "Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
    "data": { "service": "session", "errorName": "provider.free-limit" }
  }
}
```

No model switch or second prompt occurred. The adapter surfaced
`RuntimeExecutionFailure` with `phase: run` and `category: semantic`.
`session/close` received a successful empty result. The final adapter process
snapshot and a subsequent independent container snapshot both found no new ACP
or `serve --service` survivor; live owned root count was zero. This proves
cleanup for this refused turn, not successful completion, resume, permission
refusal or cancellation. Those later gates remain unrun.

Owner decision: this free-limit is a quota cap, not a rate limit. It does not
trigger the pre-output rate-limit fallback. No product change is required.

The current trace explains the result without proving a retry defect: the
OpenCode ACP profile supplies no `failureOutcome` reader. Generic
`shared/acp/failure.ts` calls `classifyFailure` on the error's message;
`shared/failure-class.ts` treats usage-limit prose as `quota`, distinct from
`rate_limited`. `OpenCodeAdapter.finish` retries only `rate_limited` and reports
text-derived terminal classes as `unknown`. The native observation in this
record is reported as quota exhaustion; the SDK's terminal reporting is not
changed to claim a structured classification it did not emit.

### Native Windows v2

A self-contained native Windows runbook and complete canary script were handed
to the coordinator and executed on native Windows 11 Pro x64 at the same
implementation subject. The separate Windows worker installed dependencies and
built successfully with Node 26.13.0 and Bun 1.4.4 (the packet specified Bun
1.4.3; the deviation is recorded, not treated as a qualification pass).

An existing standalone user installation was found through PATH, then supplied
explicitly to the adapter. It reported `opencode v2.2.6`. Native open, explicit
DeepSeek selection and matching readback passed. The first prompt failed with
the same free-usage-limit message as Linux v2, with no fallback or second
prompt. The saved receipt reports `RuntimeExecutionFailure`, `phase: run`,
`category: semantic`, then a `session/close` call. Windows used the
earlier packet without raw post-prompt frame capture, so no structured
`errorName` claim is made for that host.

Final adapter cleanup counts were zero for new runtime processes, live owned
roots and surviving services. The independent Windows process snapshot found
one pre-existing user OpenCode service and zero new canary processes; that
unrelated service was preserved. Later resume, cwd, permission and cancellation
gates were unrun. The actual saved receipt was retrieved through Herdr and
checked against the worker's terminal report; this is native Windows evidence,
separate from the Linux runs.

### Quota interpretation and next native run

Owner hypothesis, not independently verified: earlier free-model consumption,
including `iceman-free` use on the Windows machine, probably consumed the free
allowance. The cap may be shared per account, IP or day. Its scope and reset
time were not established by these canaries. These quota refusals do not
establish that free models are unavailable in principle or that the keyless
onboarding premise failed. V1's separate 120-second no-reply observations do
not establish discontinuation either.

The next bounded v2 canary is deferred until after the expected next-day quota
reset (2026-11-09, Asia/Taipei). It must rerun the completion gate and every
remaining release gate on each claimed native host; no paid call or quota
bypass is authorized by this record.

## Qualification decision

No native combination has passed all release gates in this record. Keep
`platforms: []`, no default `qualifiedVersion`, and `mcpToolsets: false` until a
completed native matrix supports a change. The compatibility floors (v1
1.18.35 and v2 2.0.26) remain executable version parsing gates; they are not
qualification evidence. Replay's resume capability declaration does not make
an empty platform list available for dispatch.

The existing descriptor has a platform list and a separate version policy,
without an OS-by-line qualification table. Adding two independent lists would
imply their Cartesian product. Any future partial matrix needs an explicit
admission decision before entries are enabled; this evidence change does not
alter the descriptor schema or weaken compatibility checks.

## Local verification

- `bun run build` and `bun run typecheck`: pass.
- Client package Vitest: OpenCode adapter, adapter capability conformance and
  runtime capability matrix: 75 passed, one existing skip.
- Node test runner: capability matrix, device setup and upgrade manifest:
  31 passed.
- API surface (including final `--update`), version authority, upgrade manifest,
  device setup and capability matrix checks: pass. Device setup and capability
  projections were regenerated from their existing authorities; generated cells
  did not change because qualification entries did not change.
- No product code or test assertions changed. Added test lines: 0; added product
  lines: 0; added test files: 0. Native probes are operational evidence, not new
  automated tests. The full repository test matrix was not run.

An initial root-level Vitest invocation did not load the client package's
configuration and selected Node test files with the wrong runner. It failed on
scratch-path setup and test discovery. The package-scoped Vitest and native
Node test-runner invocations above are the valid checks; no assertions were
changed to repair the invocation.
