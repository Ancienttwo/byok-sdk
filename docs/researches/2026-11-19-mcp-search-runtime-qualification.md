# MCP search runtime qualification for #2396

No runtime combination qualified for the initial release. The SDK retains an empty production qualification table. This run covered the ordinary lane with the Node distribution helper. Prepared inputs, native-sessions, Pi durable and injected adapters are outside this release scope. [Issue and owner decision](https://github.com/Ancienttwo/byok-sdk/issues/2396#issuecomment-6999561320)

## Environment and receipts

The instrumented runs used SDK `f2ec107b6565edb8e359298e23a8e54101609fd0`, macOS 26.5 (25F71), Darwin 25.5.0 arm64, Node 24.18.0 and Bun 1.4.4. The test-only runner supplied a version candidate for each runtime to exercise the real ordinary offer, claim, stdio helper, frozen catalog and control socket. `qualified-launch` reads the production table and launches the real helper directly. Each receipt carries the SDK commit, OS, architecture, adapter-detected version and source, lane, scenario, chosen launch variant, model tool requests, native frames when available, normalized events, helper frames, and per-target writes. The runtime installs came from the repository's qualified runtime installer and lockfiles, the pinned Pi npm dependency, or the SHA-512-verified official agy archive.

All model requests were served by the runtime contract's `127.0.0.1` loopback providers. The harness used synthetic homes and placeholder credentials or empty login files. A macOS sandbox on each runtime child blocked non-loopback IP traffic and the DNS socket. The harness also routed proxy traffic to its refusal recorder. The sandbox check connected to a loopback listener and returned `EPERM` for a connect to `192.0.2.1`.

### Reproduce

Install the SDK dependencies and build before running the contract. Do the build and runtime runs sequentially because build replaces `dist/` entries that Pi and the hub need at runtime.

```sh
bun ci
bun run build
receipt_dir=$(mktemp -d /private/tmp/byok-mcp-search.XXXXXX)
export BYOK_RUNTIME_CONTRACT=qualified
export BYOK_SEARCH_RECEIPT_DIR="$receipt_dir/receipts"
export BYOK_SEARCH_SDK_COMMIT=$(git rev-parse HEAD)
export BYOK_SEARCH_SANDBOX="$receipt_dir/loopback.sb"
printf '%s\n' '(version 1)' '(allow default)' \
  '(deny network-outbound (remote ip))' \
  '(allow network-outbound (remote ip "localhost:*"))' \
  '(deny network-outbound (remote unix-socket (path "/private/var/run/mDNSResponder")))' \
  > "$BYOK_SEARCH_SANDBOX"

BYOK_SEARCH_SCENARIOS='*' bun run --filter @byok-sdk/client test:runtime-contract -- \
  src/__tests__/runtime-contract/pi.contract.ts

for runtime in claude codex grok dsh agy opencode1 opencode2; do
  install_dir="$receipt_dir/install"
  RUNNER_TEMP="$install_dir" node scripts/ci/runtime-contract-install.mjs "$runtime" qualified > "$receipt_dir/install-$runtime.log"
  entry=$(grep '^BYOK_CONTRACT_.*_BIN=' "$receipt_dir/install-$runtime.log")
  key=${entry%%=*}
  bin=${entry#*=}
  wrapper="$receipt_dir/$runtime"
  printf '#!/bin/sh\nexec /usr/bin/sandbox-exec -f "%s" "%s" "$@"\n' \
    "$BYOK_SEARCH_SANDBOX" "$bin" > "$wrapper"
  chmod +x "$wrapper"
  export "$key=$wrapper"
  BYOK_SEARCH_SCENARIOS=mixed,name-boundary,collision-dash,collision-underscore,collision-exact \
    bun run --filter @byok-sdk/client test:runtime-contract -- "src/__tests__/runtime-contract/$runtime.contract.ts"
done
```

`BYOK_SEARCH_RECEIPT_DIR` enables the search cases. `BYOK_SEARCH_SCENARIOS` selects the cases by name, with `*` running all applicable cases. For the Pi positive cases, inspect `acceptance.status` in every JSON receipt. `BYOK_SEARCH_REQUIRE_PASS=1` is for runs requiring only positive results. The ordinary contract can pass while a separate search receipt records an unavailable or failing combination. The stable safety assertions fail the test if the probe detects a repeated write, a live retired hub token, revived unselected server, leaked fixture process, or inner attribution on a result. `qualified-launch` also records a closed production admission as a distinct outcome.

## Qualification decisions

The attempt counts below are steps sent by the loopback model after any runtime-native discovery. Executions count only synthetic target `tools/call` receipts and include direct calls in the mixed case. Search discovery itself increments no write receipt. The outer names shown are model-visible. The runtime only emits an inner identity where the SDK has a qualified raw-arguments path and can verify a frozen match.

| Runtime and origin | Mixed attempts / executions | Outer names and decisive result |
| --- | ---: | --- |
| Pi 1.5.2, SDK entry and `@earendil-works/pi-coding-agent` pin | 7 / 4 | `mcp__byoktools__tool_search`, `mcp__byoktools__call_tool`. Closed because first search sometimes arrives before Attempt activation. |
| Claude 2.1.312, `@anthropic-ai/claude-code`, environment-selected executable | 7 / 4 | `mcp__byoktools__tool_search`, `mcp__byoktools__call_tool` after `ToolSearch`. Closed because cold search intermittently received inactive proof. Native hooks saw the hub envelope. |
| Codex 0.160.0, `@openai/codex` | 0 / 0 | Normal startup refused `Codex MCP hub tool approval is not qualified`. The isolated A/B comparison also recorded different execution counts for the same native grant. |
| Grok 1.0.77 (`50ca579fa996`), `@xai-official/grok` | 7 / 5 in the successful mixed run, 0 / 0 in a repeat | Native `search_tool` and `use_tool` bridge to the hub. Repeats also produced ACP startup and process-ownership quarantine failures. A `byok-tools` variant failed before model calls. Closed. |
| dsh 0.2.2-rc.1, `@deepseek-ai/dsh` | 7 / 5 | `mcp__byoktools__tool_search`, `mcp__byoktools__call_tool`. The ordinary mixed smoke passed in `all`; the full lifecycle and policy matrix is incomplete. Closed. |
| agy 1.5.1, official macOS arm64 archive | 7 / 5 | `mcp_byoktools_tool_search`, `mcp_byoktools_call_tool`; Gemini function calls needed `toolSummary`. `alwaysLoad` and the proposed 20k tool-definition threshold remain unverified. Closed. |
| OpenCode CLI 1.19.5, `opencode-ai`, configured executable | 7 / 5 | `byoktools_tool_search`, `byoktools_call_tool`. The ordinary mixed smoke passed in `all`; the full lifecycle and policy matrix is incomplete. Closed. |
| OpenCode CLI 2.3.0, `@opencode/cli`, configured executable | 7 / 5 | Model sees `execute`; calls dispatch through `tools["byoktools"]`. No qualified outer-call event correlation or complete lifecycle matrix. Closed. |

The mixed fixtures selected `alpha` and `beta` with the same `submit_result` name, plus `blocked`. The model attempted `outside`, an unselected server with its own target receipt path. Across the mixed runs, `outside` had zero starts and zero writes. Pi and Claude ran the SDK `auto` rule with a rejected approval for `blocked`, yielding zero writes on that server. Other probes ran `all`, and their selected `blocked` tool was intentionally callable under that policy.

### Pi 1.5.2

This candidate was SDK-built Pi semantics with the default `agentUserContext: 'inherit'`, SDK ordinary RPC launcher, Node distribution helper, and no `packageDir` override. The test wraps the real bundled Pi process for egress denial and captures its stdout JSONL. The native frames carry the exact `args` object and `toolCallId` and run on the root Session stream, with no per-frame child key. One successful mixed run has the following trace. Each row is a separate model step and the result shares the same call ID.

| Root call ID | Input or target | `tool_use.mcp` | `tool_result.mcp` | Writes |
| --- | --- | --- | --- | ---: |
| `call_1` | `{ "query": "submit result" }` | `byoktools/tool_search` | `byoktools/tool_search` | 0 |
| `call_2` | `alpha/submit_result`, `{ "summary": "first" }` | `alpha/submit_result` | `byoktools/call_tool` | 1 |
| `call_3` | `beta/submit_result`, `{ "summary": "second" }` | `beta/submit_result` | `byoktools/call_tool` | 1 |
| `call_4` | `alpha/long_…`, 64-character inner name | `alpha/long_…` | `byoktools/call_tool` | 1 |
| `call_5` | `blocked/submit_result`, rejected SDK approval | `blocked/submit_result` | `byoktools/call_tool` | 0 |
| `call_6` | `outside/submit_result`, catalog miss | `byoktools/call_tool` | `byoktools/call_tool` | 0 |
| `call_7` | `native/submit_result` | `native/submit_result` | `native/submit_result` | 1 |

A single model response emitted two calls to `call_tool`. Both entered the hub at the same recorded millisecond with distinct IDs and arguments. The beta reply preceded the delayed alpha reply by 501 ms, with one matching receipt per target. Pi's native `isError` tracks callback exceptions; MCP errors can also arrive via trusted SDK bridge details. For the hub, the daemon carries that error bit into the outer result. A tool-use frame neither proves that the SDK granted the call nor that the server saw it.

On successful repetitions, `byok-tools` and `byok_tools` each retained a distinct provider name and reached only its own direct receipt. The exact `byoktools` conflict declined before claim with 0 attempts and 0 writes. A 64-character server and 64-character tool produced a 135-character direct Pi name and a real write receipt. The 64-character inner tool also ran through the hub.

| Scenario | Representative model attempts / target receipts | Observation |
| --- | ---: | --- |
| Hub killed idle | 3 / 1 | One hub spawn. The first call returned. The explicit next call failed with a closed transport. |
| Hub killed with a dispatched write pending | 3 / 1 | The write reached the target once. Both pending and subsequent attempts reported transport errors. |
| Inner child killed idle | 3 / 2 | Same hub and catalog. The replacement handled only the next explicit request. |
| Inner child killed with a dispatched write pending | 3 / 2 | `first` appeared once with unknown result, then `explicit-next` appeared once. |
| Inner schema changed after death | 3 / 1 | The next explicit request returned catalog drift before dispatch. |
| Outer initialize delayed 12 s | 1 / 0 | No search reached the helper. The Pi tool reported an outer startup error. |
| Inner list delayed 700 ms | 2 / 1 | Search returned in 835 ms and the inner write followed. |
| Inner list delayed 12 s | 1 / 0 | The initialized hub returned its discovery budget error after 10,014 ms. |
| Write awaited SDK/Pi call deadline | 2 / 1 | The target recorded the write. Pi sent cancellation after 120,654 ms and reported an outer timeout. |
| 16 × 16 servers | 2 / 1 | All 256 servers answered `tools/list`, one handled the dispatched call. The discovery phase took 6,709 ms on the instrumented run. Peak observed across repeats was eight inner children and 40 helper FDs. |
| Cancel while discovery was blocked | 1 / 0 | Claim and start preceded cancellation. No discovery result or target write followed. All tracked fixture PIDs were gone at teardown. |
| End and next offer | 7 / 4 | Retired nonce was revoked. A new Attempt proved active while the old token and restored old catalog failed live search and call checks. The target receipt captured the Agent workspace cwd and a synthetic marker in the filtered environment. |

The important failures were intermittent. One cold `inner-idle` run attempted search while the daemon still considered the Attempt inactive. The response was `MCP hub Attempt is inactive or could not be verified.`, with zero writes. The later `call_tool` was denied because no catalog had been published, and the turn ended after Pi exhausted its native retry policy. Further cold runs reproduced a first-search refusal in the drift and cancellation scenarios. Successful repetitions include the direct SDK helper launch and all individual scenarios. The failing repetitions keep the entire Pi row closed. `PiAdapter.start()` submits its first prompt before the daemon writes the session handoff and installs `ActiveTask.mcpHub` as active. The remedy needs to preserve the claim, cancellation and liveness boundaries while making the first discovery reachable.

### Claude and Codex

Claude's positive mixed run reached the same alpha, beta, long-name and direct receipts as Pi. Its `PreToolUse` hook receives `mcp__byoktools__call_tool` and the inner envelope. The hub-side MCP trace also recorded `_meta["claudecode/toolUseId"]`, which agreed with the normalized outer tool event. In a separate cold in-flight scenario the first search got inactive proof and no write reached a target. A successful in-flight check killed and replaced the hub. The two receipts were `first` and the later `explicit-next`, once each.

The Codex A/B runner is `packages/client/scripts/codex-mcp-hub-comparison.mjs`. It drives isolated native and hub arms using the same short scratch root, exact alpha grant, ungranted beta tool, placeholder Responses provider, annotation variants, start/resume and interactions off/on. Invoke its `compareCodexMcpHub({ root, command })` export with a fresh short absolute root, a sandboxed qualified `codex` binary, and only `PATH`, a temporary directory and `OPENAI_API_KEY=runtime-contract-placeholder` in the process environment. A read-only beta tool reached the target in the native arm and was refused in the hub arm. A completed pair has 1 native beta receipt and 0 hub beta receipts for the same attempted call. Additional cases could not complete in the local matrix. This comparison is evidence to keep Codex closed.

### agy schema control

The SHA-512-verified 1.5.1 archive contains this release-note text in the installed executable: `MCP servers ... mark a tool as always loaded by setting _meta: {"antigravity/alwaysLoad": true} ... instead of discovering it on demand`. The executable also mentions a dedicated 20,000-token budget for user and workspace rules. That reference does not identify an MCP tool-definition threshold. The harness used synthetic tool descriptions with 18,000 and 22,000 repeated words, with and without the marker. All four controls had 0 tool attempts and 0 receipts, and the full schema did not reach the loopback provider. These word counts are fixture sizes, so the tests do not establish the vendor token threshold or its interaction with the marker. The agy row remains unverified for that part of qualification.
