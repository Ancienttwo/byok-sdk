# Runtime contract suite

Runtime CLIs release on their own schedules. The runtime contract suite
(#1103) runs every adapter against a real installed CLI and checks the
behavior the SDK depends on. Model traffic goes to a loopback provider on
`127.0.0.1`, so no credential or paid call is used (the #1058 and #1072
pattern).

## Cases

Each adapter file under `packages/client/src/__tests__/runtime-contract/`
binds every case either to a check or to an explicit skip with a reason. A
missing case is a type error. An adapter cannot skip a case for a capability
its descriptor advertises: `mcpToolsets`, `messageDraft`,
`toolAuthorizationAuto`, and each `isolation` guarantee (`userContext`,
`userMcpServers`, `sessionPersistence`).

| Case | Checks |
| --- | --- |
| `detect.version` | `detect()` is available. The suite reads the version text itself, so a broken adapter parser fails here. It also checks the effective version-policy verdict (allow for the qualified token, warn exactly where the unqualified-version advisory appears) and that the unqualified-version advisory appears exactly when the version is not the qualified one. |
| `detect.auth.*` | `authPresent` is false with no credential, and true for an API key in the environment and for the runtime's own stored login. |
| `mcp.submitResult` | A Host MCP server's `submit_result` call reaches the server, including through deferred-tool search (Claude `ToolSearch`, Grok `search_tool`/`use_tool`). |
| `instructions.project` | The project instruction file (AGENTS.md, or CLAUDE.md for Claude) reaches the model. |
| `isolation.*` | With an exclusion option on, user instructions, user MCP servers, or session transcripts do not appear. A positive control shows they do appear with the option off. |
| `drafts` | Streamed text reaches the Agent message draft, either as `message_draft_delta` events or as `progress` deltas, using the daemon's own rule. |
| `gate.auto` | The `auto` gate refuses a high-risk native write before it executes. |
| `egress.declaredHostsOnly` | No proxied request goes to an undeclared host. The proxy only sees clients that honor `HTTP(S)_PROXY`. |

One case is synthetic and needs no installed CLI:
`version-block.contract.ts` builds a Host-configured `versionPolicy` block,
runs it through the same local admission as a real offer, and asserts that
`pickAdapter` declines before claim (`runtime_version_blocked`, retryable
false) without calling `prepare()` or `start()`. Real runtimes are never
deliberately blocked; the fixture is the only exercise of that path. A policy
block is admission-only: a nightly `latest` verdict of `warn` or `block`
changes the reported verdict, not the suite's pass/fail rule.

Declared hosts carry their reason in the adapter file. Currently there are
two:

- Claude's `auth status` checks an API key with `api.anthropic.com` during
  detect.
- Grok syncs its workspace and bundles with `cli-chat-proxy.grok.com` during a
  turn, whatever the model provider.

## Runs

- **PR CI** (`ci.yml` job `runtime-contract`, selected by
  `scripts/ci/select-impact.mjs`): one leg per adapter, at the qualified
  versions. Each qualified version comes from the adapter's constant:
  `QUALIFIED_CODEX_VERSION`, `QUALIFIED_GROK_VERSION`,
  `QUALIFIED_HERMES_VERSION`, or `QUALIFIED_CLAUDE_VERSION`. Pi has no
  separate constant: it is bundled, and its version is
  `byok.piRuntimePin`.
- **Nightly** (`runtime-contract-nightly.yml`, also `workflow_dispatch`): the
  same suite against each CLI's latest release. A failure comments on one open
  tracking issue, or creates it. Pi's leg reports every case as skipped,
  because the SDK runs only the pinned Pi.

`scripts/ci/runtime-contract-install.mjs <runtime> <qualified|latest>` installs
a CLI and passes its path to the suite.

To run locally, from `packages/client` after `bun run build`:

```sh
BYOK_RUNTIME_CONTRACT=qualified BYOK_CONTRACT_CODEX_BIN=/abs/path/to/codex \
  bun run test:runtime-contract -- src/__tests__/runtime-contract/codex.contract.ts
```

A latest run also needs `BYOK_CONTRACT_<RUNTIME>_VERSION`. The suite refuses
to start without `BYOK_RUNTIME_CONTRACT`. A selected runtime without its
executable fails; it never skips.
