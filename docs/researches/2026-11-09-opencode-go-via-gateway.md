# OpenCode Go via a local gateway (#1587)

Date: 2026-11-09 (Asia/Taipei). Subject: `train/next-minor` at `a637bf7cb`,
built with `bun run build` in a clean worktree. Platform: macOS darwin-arm64,
Node v24.22.1, Pi 1.5.0 (`@earendil-works/pi-ai` 1.5.0). Gateway: the local
magpie app listening on `127.0.0.1:3425`.

The owner approved two runs that use OpenCode Go quota: run 1, then run 2
after run 1 left two gaps
([decision](https://github.com/Ancienttwo/byok-sdk/issues/1587#issuecomment-6730667663)).
Each ran once. Run 2 supplies every acceptance item.

## Method

A throwaway script outside the repository drove each run. It was deleted
afterwards, together with its temporary directories.

1. The gateway key was read from the local Pi configuration, where magpie
   registers itself, and piped through stdin into the script. It never
   appeared in argv, terminal output or this record.
2. `ProviderRegistry.configure` created the profile from the
   [README example](../../packages/keys/README.md#your-own-openai-compatible-gateway)
   in a fresh `SqliteProviderProfileStore`. The secret store was
   `MacOsKeychainSecretStore` with the login keychain and a run-only service
   prefix. `base_url` pointed at a loopback recorder that forwarded every
   request unchanged to `127.0.0.1:3425`. The recorder kept only header
   names, the first 8 characters of session headers, `reasoning_effort`, and
   the names and lengths of reasoning fields in assistant messages. A
   request to also log the request's `thinking` field arrived after run 2
   had finished, so that field was not recorded. The case it would have
   told apart, a request that never enabled thinking, did not come up:
   run 2 returned reasoning.
3. The key check was `checkProviderKey`, with the key read back from the
   keychain.
4. The Pi session ran on the `pi-rpc` lane: `PiAdapter` with a
   `byokLauncher` pointing at the built `byok-pi-provider-launcher`, which
   launched the SDK `byok-pi-rpc` host. The flow followed
   `scripts/release/pi-launcher-smoke.mjs`. `HOME` was an empty temporary
   directory. The script spoke Pi RPC over stdio and logged each assistant
   `message_end`, each `tool_execution_end` and `get_state`.
5. `ProviderRegistry.delete` then removed the profile and the key.

Before each live run, a rehearsal pointed the recorder at a local stub that
answered 500. It ran the same steps with a placeholder key and made no
gateway call.

Differences between the runs:

| | Run 1 | Run 2 |
| --- | --- | --- |
| Profile `thinkingLevel` | `high` (as in the README) | `max` |
| Turn 1 prompt | read a file with the `read` tool and report its content | work out a short sum first, then read a file with the `read` tool and combine the two |
| Turn 2 prompt | a follow-up calculation | a follow-up question that needs reasoning |
| Recorder writes | on upstream response end | on request receipt |

## Run 2 evidence

| Item | Result | Source |
| --- | --- | --- |
| Gateway lists the model | `GET /v1/models` 200; `opencode-go/deepseek-v4.1-flash` present | script |
| Profile validates | `configure` accepted the profile (`PiModelConfigSchema` and the profile parse), `secret_configured: true`, `configuration_pending: false` | `configure` status |
| Key stored | keychain readback present and equal to the input | script |
| Key check | `ok` | `checkProviderKey` |
| Pi readback | provider `byok-sdk-gw-opencode-go-1587`, model `opencode-go/deepseek-v4.1-flash`, thinking level `max`, compat `sendSessionAffinityHeaders: true`; session `01a1be1a…` | RPC `get_state` |
| Turn 1 thinking | assistant `toolUse`: a thinking block with `thinkingSignature: reasoning_content` (302 characters) and one `read` call; tool `isError: false`. The following assistant `stop` also has a `reasoning_content` thinking block | RPC `message_end`, `tool_execution_end` |
| Replay | the request after the tool call carries the tool-call assistant message with `reasoning_content` of 302 characters and no `reasoning`. The turn 2 request carries both turn 1 assistant messages with `reasoning_content` (302 and 96 characters) and no `reasoning` or `reasoning_text` | recorder requests 3 and 4 |
| Session headers | each of the three Pi requests sends `session_id`, `x-client-request-id` and `x-session-affinity`, all `01a1be1a…`, equal across both turns and to the Pi session id. Pi sends no `x-opencode-session` | recorder requests 2–4 |
| Thinking requested | `reasoning_effort: max` on each Pi request | recorder |
| Turn 2 | assistant `stop` with a `reasoning_content` thinking block (338 characters) and text | RPC `message_end` |
| One OpenCode session | magpie recorded `session` and `native_session` `01a1be1a…` on all three Pi requests | magpie `usage.jsonl` |
| No missing-session error | all requests 200; 0 lines matching `x-opencode-session missing` in magpie `app.log` during the run. OpenCode answers 400 without that header (#1547), so the 200s show magpie sent it | magpie `app.log`, recorder |
| Cleanup | profile gone, keychain entry gone | `registry.delete`, readback |

Quota used in run 2, from magpie `usage.jsonl` (OpenCode Go,
`deepseek-v4.1-flash`):

| Request | Input | Cache read | Output | Reasoning | Effort |
| --- | --- | --- | --- | --- | --- |
| Key check | 66 | 0 | 20 | 14 | none |
| Turn 1, tool call | 4264 | 0 | 163 | 125 | `max` |
| Turn 1, answer | 222 | 4224 | 144 | 52 | `max` |
| Turn 2 | 263 | 4352 | 216 | 163 | `max` |

## Run 1

Run 1 (02:01:52Z to 02:02:02Z) passed the key check, ran the `read` tool
call, and both turns succeeded. magpie used one session, equal to the Pi
session id, on all three Pi requests, and logged no missing-session line.
Two items had no evidence:

- Pi sent `reasoning_effort: high`, but the model returned no reasoning on
  any Pi request (magpie `usage.jsonl`). With no thinking block, there was
  nothing to replay. So at `high`, DeepSeek V4.1 Flash may answer simple
  turns without thinking.
- The recorder waited for the upstream response to end before writing a
  record. That event never fired for the streamed responses, so it lost
  the Pi requests. Run 2 records on receipt.

Run 1 quota: key check 66 input / 27 output (21 reasoning); Pi requests
4230 / 43, 69 (4224 cached) / 9, 100 (4224 cached) / 3, no reasoning.

## Key-leak check

The diff, this record, the PR body and the issue comments were searched
for the exact gateway key value. Every match is in prose. No match is in a
credential position, such as a header, a `configure` argument or a recorded
value.
