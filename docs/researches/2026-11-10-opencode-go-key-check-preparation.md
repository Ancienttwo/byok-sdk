# OpenCode Go key-check and Pi acceptance (#1551)

Date: 2026-11-10. Scope: [PR #1551](https://github.com/Ancienttwo/byok-sdk/pull/1551), [#1547 Design §§1–2](https://github.com/Ancienttwo/byok-sdk/issues/1547) and the Pi provider identity delivered by #1586/#1698. Three separately approved live invocations used head `0ebf4321e947734b0e75f973b43f4f601bf5c7e6` on macOS arm64, Node v24.18.0 and Bun 1.4.3. The third passed the real key check and one real Pi turn. Subsequent rebases and review fixes have offline evidence; the live result remains tied to that head and its integration range-diff. Native OpenCode adapter custody (Design §3) remains outside this PR.

## Candidate and offline evidence

The explicit `opencode-go` provider kind selects the key-check session header and truthful package/version User-Agent. A URL or model name never selects that behavior. The session id is created once per check and retained across the existing reasoning-only retry. Pi execution separately declares `pi_model.api: 'openai-completions'` and `pi_model.providerId: 'opencode-go'`; provider kind never infers Pi identity.

All 13 released/old-workspace fixture stores lack the new kind and expect `migration-required`; their bytes are unchanged. The Host calls `migrateProviderProfileStore` before opening the store and preserves profiles and credential-store references. Published release guides are unchanged; the next-MINOR checklist and manifest acceptance `migrate` describe the change.

Offline checks before the live runs passed: build, workspace typecheck, 215 affected keys tests, 62 affected client/replay tests and 18 upgrade-manifest script tests, plus catalog drift, API-surface, version-authority, manifest and diff checks. The replay test receives `reasoning: 'THINK'` and sends `reasoning_content: 'THINK'` without `reasoning` on turn 2. These are offline replay results, not evidence that the final live turn emitted reasoning.

The catalog closure increases and providerId golden change have an [advisor t4 approval record](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6775175260). Rebase validation and review deltas are recorded in the PR body.

## Three approved live runs

Each invocation had separate owner approval, a USD 1 budget and no automatic rerun. All used `deepseek-v4.1-flash`. The completed Pi turn used `thinkingLevel: 'low'`, a 256-token output cap and denied tools.

| Run | Provider fetch attempts | Key check | Pi result | Conservative cost evidence |
| --- | ---: | --- | --- | ---: |
| [1](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6773514087) | 1 | `provider_error`; no HTTP response observed | Not started | Actual charge unknown; reserved ceiling USD 0.3146112 |
| [2](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6774083273) | 1 | HTTP 200, `ok`; 66 input / 21 output tokens | Launcher failed before a Pi upstream request | Peak-rate estimate USD 0.000045 |
| [3](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6774762943) | 2 | HTTP 200, `ok`; 18 input / 6 output tokens | HTTP 200; turn completed; 4300 input / 3 output tokens | Peak-rate estimate USD 0.0013062 |

The final run completed from `2026-11-10T17:43:21.211Z` to `2026-11-10T17:43:26.475Z`. It made exactly one key-check request and one Pi request, with no retry. Both carried a non-empty `x-opencode-session` and authorization matching the approved keys-store value in memory; the key check also carried the expected versioned keys User-Agent. Pi reported 4303 total tokens and zero reasoning tokens.

The successful responses' combined peak-rate valuation is **USD 0.0013512**. Retaining the first run's full unknown-charge reservation yields a **conservative cumulative upper bound of USD 0.3159624**, below USD 1. Captured responses reported `usage.cost: 0`, but a numeric Go allowance deduction was not captured and the first run had no response. An exact cumulative billed or allowance amount is therefore not established. The estimates use the then-published peak rates of USD 0.30/M input and USD 1.20/M output tokens from [Go pricing](https://opencode.ai/docs/go/) and [pay-as-you-go pricing](https://opencode.ai/docs/zen/).

## Causes found without the stored credential

### Node address-family attempt timeout

[Credential-free transport diagnosis](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6773800053) found that DNS resolved and unauthenticated curl reached the base URL with HTTP 404, while native Node v24.18.0 fetch failed with `ETIMEDOUT` and nested `EHOSTUNREACH` under its default 250 ms family-attempt timeout. Forced IPv4 completed verified TLS. Changing only the diagnostic process timeout to 3000 ms also produced verified TLS 1.3 and HTTP 404. No proxy variables were configured.

The later approved live processes used `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000`; no persistent environment change or certificate-verification bypass was applied. The original transport subtype had been dropped by the local recorder's catch, which returned 502; the SDK then mapped that response to the closed outcome `provider_error`.

### Default Keychain lookup under isolated HOME

[Dummy-key Pi diagnosis](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6774377689) captured `KEYCHAIN_UNAVAILABLE: macOS Keychain is unavailable` in the launcher before Pi was spawned. The controller's key check read the store directly under its normal home; the launcher first called `available()` under an isolated HOME. The default-Keychain metadata query succeeded under the normal home and failed under the isolated home.

An in-memory dummy-store control completed a local Pi turn. The macOS backend with native availability metadata and an intercepted dummy `get()` reproduced the failure. An explicit `keychainPath` made metadata availability and the local Pi turn succeed while preserving HOME isolation. Metadata commands did not read credentials; every diagnostic credential lookup returned an inert dummy value. The third approved run passed the explicit Keychain path to both controller and launcher.

The original local runner also discarded the launcher exception and the controller's wrapped startup cause, and omitted collected stderr. Before the final run, closed error-name/code reporting, bounded causes and sanitized stderr records were added. Seven privacy/bounds tests, three dummy-key scenarios and a full rehearsal passed. Those controls included reflected-secret rejection and scanning across chunk boundaries beyond the capture cap.

## Credential boundary and limits

The real credential was read through the approved OS-store reference. The key check read it under the profile-store configuration lock; the launcher independently resolved the same entry through its custody snapshot and delivered it over private IPC. Its value was never printed or retained in evidence, argv or environment. No credential-store write or plaintext fallback occurred.

The final run recorded 26 artifact file checks, zero credential matches, zero OS-store writes and zero child stderr bytes. Temporary runtime artifacts were removed and the supervisor reset the approval flag to false after the invocation. Retained evidence contains metadata, booleans, HTTP statuses and numeric usage; raw provider responses and foreign error text are not retained. The [final result comment](https://github.com/Ancienttwo/byok-sdk/pull/1551#issuecomment-6774762943) links the operational preparation and audit details.

The request guard allowed at most two key-check requests under the SDK's existing retry and one Pi request, capped input bodies, refused redirects and checked cumulative exposure before forwarding. Missing credentials or failed custody stopped launch. This qualifies the bounded real key check and short Pi turn on the recorded head; it does not establish native OpenCode custody, live reasoning replay, broader model behavior or production acceptance.
