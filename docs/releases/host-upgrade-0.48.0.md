# Host upgrade to 0.48.0

This checklist covers the 0.47.1 → 0.48.0 upgrade. Hosts on an earlier release
first follow the [0.47.0 checklist](host-upgrade-0.47.0.md) and its predecessors.

0.48.0 keeps wire v8. Existing 0.47.1 server databases, daemon journals,
provider stores, and device pairings carry forward in place. The
[upgrade manifest](../../packages/client/upgrade-manifest.json) records three
breaking and seven additive entries.

## Node.js 24.22.3 minimum

The public SDK packages declare `engines.node` as `>=24.22.3`. Upgrade Node
to 24.22.3 or later on Hosts and daemon machines before installing the new
SDK. Rebuild Node SEA launchers with a supported Node executable.

## Pi 1.7.0 closure (#2585)

- Re-prepare inputs compiled with an earlier Pi closure before dispatch. Pi
  rejects the previous runtime identity with
  `preparation_runtime_identity_mismatch`. Rebind Host accounting rulings to
  the 1.7.0 closure to avoid `accounting_policy_inapplicable`.
- Review `ModelRoutePolicy.default_models` against the pinned 1.7.0 keys
  catalog. Replace retired Ant Ling IDs `Ring-2.6-1T`, `Ling-2.6-1T`, and
  `Ling-2.6-flash` with a supported model such as `Ling-3.1-flash`. Replace
  Qwen Token Plan `qwen4-max-preview` with `qwen4-max`.
  The catalog also removes entries for OpenRouter and Together. When lookup
  returns `not_in_catalog`, choose a supported model or supply a manual Pi
  model configuration.
- Hosts moving from the published 1.6.0 pin should also review the Baseten
  models `deepseek-ai/DeepSeek-V4.1-Flash-1017` and
  `deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast`, which lose `medium` and gain
  `xhigh`. `moonshotai/Kimi-K3.1-Pro` loses `minimal` and gains `max`.
- Stored profiles whose catalog entry was removed or whose saved configuration
  no longer matches the entry reopen as manual with their saved `pi_model`
  configuration and thinking level.
- Existing pi-durable 1.6.0 and 1.6.1 SQLite replicas open in place. No export,
  rebuild or schema migration is required.

## Cursor Agent CLI (#2514)

On macOS and Linux, add `cursor` to `runtimeAllowlist` to enable the new
harness. Install `cursor-agent` and run `cursor-agent login` under the device
user. Set `runtimes.cursor.executable` and `runtimes.cursor.model` if the Host
needs an executable override or a default model. Phase 1 has fake-CLI
coverage and remains unqualified. Track live qualification in #2579.
[Cursor capabilities](../adapter-capabilities.md#cursor-implementation-and-qualification-2514) ·
[Refs #2579](https://github.com/Ancienttwo/byok-sdk/issues/2579)

## OAR 0.138.1 (#2521)

- Pass `{ allowPrintMode: true }` to `AgyAdapter.accountUsage()` to continue reading Antigravity quota. For local control IPC, include `allowPrintMode: true` in the `runtimes.usage` request. With the option omitted or false, the call returns `{ kind: 'unsupported', reason: 'print_mode_disabled' }` without starting agy. Opting in runs the `models` authentication check and `/usage` through the SDK-owned reader.
- Antigravity CLI 1.5.18 is the qualified version. Update to 1.5.18 to clear the default advisory for an older supported version. The SDK sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` for agy subprocesses.
- Codex still receives the Host's exact structured answer. The SDK scrubs the secret fields from the matching native answer echo before recording or projection.

## Suggested runtime versions (#2524)

- Import `checkSuggestedRuntimeVersion` from `@byok-sdk/client` to show an advisory for an installed runtime below OAR's suggested minimum for recent models. Pass the SDK runtime ID from the observation, such as `agy` for Antigravity. The check returns advice under that ID and uses the bundled `suggestedRuntimeVersions` snapshot by default.
- The Host may fetch `SUGGESTED_RUNTIME_VERSIONS_URL` on its own schedule, pass the decoded JSON through `parseSuggestedRuntimeVersions`, and supply a valid manifest to the check. The SDK performs the comparison offline. Compatibility floors, Host version policy, and the `required` and `available` upgrade states retain their existing meanings.

## Host-selected service tier (#2523)

- To select a tier, check for `harness-service-tier` and
  `harnesses[].capabilities.serviceTier` on the intended Codex or Claude
  harness. Set `target.serviceTier` to `fast` or `default`. Codex also accepts
  native tier IDs advertised by the chosen model.
- Set `target.serviceTierFallback: 'default'` only if the same harness also
  advertises `serviceTierFallback` and standard service is acceptable. Both
  adapters verify the applied tier before the first prompt and report it as a
  `service_tier` activity event. A device that reconnects without the required
  support declines the queued offer before starting it.
- The wire major stays at v8. Offers that omit both fields continue to use
  the runtime's configured tier.

## OAR 0.136.0 (#2512, #2513)

- `OpenCodeAdapter.listModels()` on OpenCode 2.x reads the catalog from a private `opencode serve --stdio` loopback listener instead of `opencode models --standalone`. Entries now carry `displayName`, `provider` and `effortLevels`, and a cold catalog no longer comes back id-only. The listener is stopped when the read ends, is cancelled or times out. On OpenCode 1.x and 2.x, `effortLevels` no longer lists the native `default` variant.
- `AgyAdapter.accountUsage()` window labels drop agy's trailing "Remaining" (`Shared · Weekly Limit Remaining` becomes `Shared · Weekly Limit`), because the window reports a used ratio. A Host that matches on the old label text must update it.
- `ClaudeAdapter` declines an MCP elicitation request (`form` or `url`) at once. Before, it hung an unattended task and ended a task with `nativeInteractions` as an unknown native request. Other unknown native requests still end the task.
- With `nativeInteractions`, `CodexAdapter` launches Codex with `-c features.default_mode_request_user_input=true`, so structured questions reach the Host outside plan mode. The qualified version stays 0.169.0.
  With `nativeInteractions` configured, `prepare()` rejects Codex versions below 0.107.0 or unrecognized version output with `runtime_unavailable`.

## Host MCP task context (#2559)

- To enable task-scoped Host MCP tools, configure
  `CreateByokServerOptions.hostMcpTaskContext` with `{ enabled: true }` on the
  server and require the advertised `host-mcp-task-context` capability before
  using the lane. The server defaults to disabled.
- Verify incoming assertions with `verifyHostMcpTaskAssertion` using the
  configured issuer, audience and toolset before invoking a Host tool. For
  multiple server processes, supply a shared atomic replay authority.
  [Refs #2559](https://github.com/Ancienttwo/byok-sdk/issues/2559)

## Host toolset observations (#2564)

Match Host-toolset calls by the canonical MCP server and tool identity in
observations. Update projections or measurement predicates that match a
runtime-specific wrapper name. DSH continues to emit its native observations.
[Refs #2564](https://github.com/Ancienttwo/byok-sdk/issues/2564)

## Task-scoped skills wire (#2575)

Wire v8 adds optional `requiredSkills` with 1–16 logical `SkillId` values on
Agent offers, gated on the device’s `skill-selection` capability. Optional
`RuntimeCapabilities.skills` advertises runtime support in `conn.hello`,
presence, and `task.claim`. Prepared offers and `nativeSessions` refuse
`requiredSkills`. The wire contract ships ahead of client support. Leave
`requiredSkills` unset until the device advertises `skill-selection` and
the intended runtime reports `skills`.
[Task-scoped skills spec](../spec.md#task-scoped-skills) ·
[Refs #2575](https://github.com/Ancienttwo/byok-sdk/issues/2575)

## Bot profile skills (#2578)

Hosts can set `skills` on `TeamSnapshotBot` and `BotProfile`. K8 combines
template `requiredSkills` and Bot skills for Turns, with template IDs first,
duplicates removed, and a maximum of 16 IDs. Daily dreams omit
`requiredSkills`. Keep both Host fields unset for execution on devices
without `skill-selection`.
[K8 Bot skills spec](../spec.md#k8-bot-skills) ·
[Refs #2578](https://github.com/Ancienttwo/byok-sdk/issues/2578)
