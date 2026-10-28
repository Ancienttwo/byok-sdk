# Grok terminal capability does not hide the native tool

The SDK does not provide a Grok hidden-terminal mode. On qualified Grok
1.0.52, setting ACP `initialize.clientCapabilities.terminal` to `false` did
not remove `run_terminal_command` from the actual model request. A client
capability declaration, or a client callback that refuses execution, is not
proof that a native tool is hidden. This is the Grok boundary of
[#1061](https://github.com/Ancienttwo/byok-sdk/issues/1061).

## Qualified observation

The 2026-10-28 experiment used the official
[macOS arm64 1.0.52 artifact](https://x.ai/cli/grok-1.0.52-macos-aarch64),
downloaded to a separate temporary directory. Its SHA256 matched the qualified
binary before execution:

```text
c2caa9895dd763297a75e8fb6077e175d9c5304c53903e52cff8891a1384bbb9
```

Isolated `--version` returned `grok 1.0.52 (0920c8169e27)`. The installed CLI,
global links and user configuration were unchanged. This binary's embedded
official guide documents custom model endpoints; the experiment used a local
OpenAI-compatible endpoint with synthetic credentials.

One true/false pair ran the real CLI as
`agent --no-leader --model probe-local stdio`, with the default agent profile.
Each case had a fresh HOME/GROK_HOME, explicit environment and temporary cwd.
ACP protocol version was 1; filesystem capabilities were identical, with
`readTextFile` and `writeTextFile` both true. Only the terminal capability
differed. Both cases completed initialize, session creation and a fresh turn.

| Terminal capability | Tools in the main model request | `run_terminal_command` | Turn result |
| --- | --- | --- | --- |
| `true` | 26 | Present | `end_turn` |
| `false` | 26 | Present, identical schema | `end_turn` |

The tool names and order matched. Twenty-five schemas were identical; the
remaining `send_feedback` description contained a different temporary session
path. The evidence is the tools array captured at the local model endpoint,
not merely an initialize response or a simulated CLI.

## Evidence limits

The responder returned fixed text and never requested terminal execution.
This experiment does not qualify the native executor, bypass behavior,
resume or pending calls. A local Host MCP server was supplied in both cases,
but its asynchronous readiness and dynamic tool discovery were not fully
observed; Host MCP preservation and invocation are not qualified here.

The CLI ran inside a verified localhost-only network sandbox, with reads of
the real Grok home and keychains denied. No real authentication, cloud model
request or paid call was used. Auxiliary local requests to `/` and the
session-title `/v1/responses` endpoint received 403; those errors remain part
of the evidence, so this is not an error-free qualification of every service.
All captured requests stayed local and were not forwarded upstream. Empty
proxy CONNECT records do not rule out other attempts denied by the sandbox.
After each completed turn, the process did not exit within two seconds of
stdin closure and its owned process group was killed; turn completion is not
being reported as a clean process exit.

The SDK will not present capability changes or execution-time refusal as a
hidden-terminal implementation, or replace the user's agent profile as a
patch. Upstream needs a supported native tool-registration control that
preserves the default profile, with observable model-tool removal and defined
executor/resume behavior. Until that contract is qualified, the Grok portion
of the requested hidden-tool guarantee remains unsupported.

The local qualification record is
`_ops/issue-lanes/1061-s3-grok-qualification.md`; its final appended section
supersedes the earlier missing-binary status. Raw evidence was retained as
`probe-result.json` under the task's temporary artifact directory, SHA256
`fdb9efcd08fc6ca05f219acc57a5c3880231dabf2a668bf5f4449a4522503992`.
