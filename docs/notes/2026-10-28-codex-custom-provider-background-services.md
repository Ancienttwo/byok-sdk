# Codex custom providers and background services

A custom model provider selects the model endpoint. It does not promise that
Codex contacts only that endpoint. Disabling plugins does not disable the
separate ChatGPT cloud-config bootstrap path. This note records the remaining
boundary of [#1060](https://github.com/Ancienttwo/byok-sdk/issues/1060).

## Observed startup request

On 2026-10-28, an isolated macOS arm64 experiment with the real Codex CLI
0.164.0 used a fresh HOME/CODEX_HOME, synthetic credentials, a loopback model
provider with `requires_openai_auth=false`, and `plugins=false`. A
localhost-only network sandbox prevented external traffic. For this experiment
only, `chatgpt_base_url` pointed to a local receiver so it could inspect the
synthetic request without TLS interception or real credentials.

| Authentication fixture | Cloud-config bundle requests |
| --- | --- |
| ChatGPT business, valid token format | One `GET /backend-api/wham/config/bundle` |
| ChatGPT plus, valid token format | None in the startup window |
| ChatGPT team, valid token format | None in the startup window |
| API key | None in the startup window |

The business request carried `Authorization: Bearer` and
`ChatGPT-Account-Id`; both matched synthetic sentinels. Its body was empty.
All four login checks succeeded. “Valid token format” means the local parser
accepted the fixture, not that a real server authenticated it. The experiment
sent only initialization and account-read RPCs, with no model turn or paid
call. The ChatGPT fixtures also requested the loopback provider's
`/v1/models?client_version=0.164.0`, without authorization or account headers.
The receiver did not supply a real model catalog, so the business case logged
a model-catalog decode error; this does not negate the captured bundle GET.

The binary SHA256 was
`d8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf`.
Source inspection used official Codex 0.164.0 commit
`6aaac694803004a63c6f393d153c96d22521a6b9`; 0.160.0 commit
`a956835d020762cb2b570053af06f643a11c0ecc` was a source-only comparison,
not another HTTP experiment.

## Why provider routing does not suppress this request

App-server [bootstrap constructs an AuthManager and cloud-config loader](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/src/in_process_bootstrap.rs#L101-L152)
before opening a thread. The loader requires backend authentication and an
[eligible account plan](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/cloud-config/src/service.rs#L52-L63).
It uses `chatgpt_base_url`, independently of the model provider's `base_url`.
The [backend client selects the bundle path](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/backend-client/src/client.rs#L526-L545),
and [ChatGPT auth supplies bearer and account headers](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/model-provider/src/bearer_auth_provider.rs#L33-L52).

No supported switch to disable cloud-config specifically for a custom provider
was found in the inspected bootstrap/service paths. This is a configuration
gap requiring upstream confirmation, not a claim that no network controls
exist anywhere. Do not redirect `chatgpt_base_url` with real credentials as a
“disable” strategy: it changes the destination of authenticated requests.
Plugin exclusion and `requires_openai_auth=false` are not substitutes for that
missing control.

## Corrections and limits

An earlier synthetic business fixture had an empty JWT signature segment.
Codex rejected it with `invalid ID token format`; its zero-connection result
was not evidence about an authenticated business account. The
[decoder requires three nonempty segments](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/login/src/token_data.rs#L144-L156).
The corrected experiment above used a nonempty synthetic signature.

The original issue's 9/10 CONNECT attempts cannot be attributed individually:
the proxy recorded hostnames and rejected the tunnels before HTTP headers or
bodies could be observed. This experiment establishes a possible authenticated
background path, not that those original attempts sent credentials or model
prompts. It does not establish prompt leakage or elimination of all external
connections. The short startup window does not cover real account refresh,
401 recovery, periodic refresh, real-runtime resume, or every auth mode and
Codex version. The negative controls say nothing about unrelated services.
