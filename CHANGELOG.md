# Changelog

## Unreleased

- **Breaking (client; #1925)** — `resolveHostLayout`, `HostLayoutInputError`, `HostLayout`, `HostLayoutOptions` and `HostLayoutPlatform` move from `@byok-sdk/client` to the new `@byok-sdk/client/host-layout` entry and leave the root, with no alias. The entry loads no daemon, Pi or provider SDK, so an installer or Electron main process can compute Host directories without them. Returned paths, error codes and existing stores are unchanged. Change the import path, including type-only imports, and split a mixed root import. See the [next-MINOR Host upgrade checklist](docs/releases/host-upgrade-next-minor.md#host-layout-import-moves-to-a-subpath).

- **Removed (Breaking; #1959)** — `@byok-sdk/cloud-do` is archived after 0.42.0 and leaves the release train. It may return when a product needs a cloud agent using platform keys with Pi’s durable harness in Cloudflare Durable Objects; restart from `archive/cloud-do` (the last main commit with the package; it differs from the last published version `v0.42.0` only in its README), requalify against the current Pi version, and obtain replay-safe tools, provider profiles and binding names from the Host. See the [Host upgrade guide](docs/releases/host-upgrade-next-minor.md#cloud-do-archived).

- **Breaking (server, bot-collaboration; #2004)** — `HostExecutionCore.cancel`, `BotCollaboration.cancelTurn` and `abortSwitch` resolve with `wakePending: true` when a wake dispatch fails after the operation commits. The durable outbox retains the failure for retry; wake hooks and explicit drains still reject. `HostExecutionCore.cancel` now returns an object instead of `void`. See the [Host upgrade note](docs/releases/host-upgrade-next-minor.md#committed-cancellation-with-a-pending-wake-2004).


- **Changed (client; #1972)** — The OpenCode adapter's qualified version moves from 2.2.6 to 2.3.0. Detect now reports the unqualified-version advisory for other versions, including 2.2.6. The runtime contract checks the namespace-level notice sent when Host MCP tools disappear on resume. See the [qualification evidence](docs/researches/2026-11-13-opencode-2.3.0-qualification.md).
- **Fixed (client; #1944)** — A failed release of an offer-owned scratch (an offer that declines or fails before any runtime starts) no longer sets `disposal: 'failed'` on `whenTaskSettled`. It still emits `runtime-disposal-failed` with `runtimeId: 'scratch'`, but `disposal` stays `none` whether the failure lands before or after the decline or failure settles. The daemon classifies the failure by the owner that reported it, not by the id, so a custom harness whose id is `scratch` still sets `disposal: 'failed'`. This resolves the 0.42.0 known issue.

