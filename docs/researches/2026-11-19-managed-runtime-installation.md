# Managed runtime installation evidence for #2419

The November 19, 2026 candidate was tested on macOS arm64 against the OAR pins in its base, `8aa372807`. The public Host operation installed each package under a temporary SDK root with `--ignore-scripts`. It selected the executable in the table, checked `--version` and the adapter's help command, and published the generation after both checks passed. [#2419](https://github.com/Ancienttwo/byok-sdk/issues/2419)

| Runtime | Package and qualified release | Executable |
| --- | --- | --- |
| Claude | `@anthropic-ai/claude-code@2.1.312` | `@anthropic-ai/claude-code-darwin-arm64/claude` |
| Codex | `@openai/codex@0.160.0` | `node_modules/.bin/codex` |
| DSH | `@deepseek-ai/dsh@0.2.2-rc.1` | `node_modules/.bin/dsh` |
| OpenCode | `@opencode/cli@2.3.0` | `@opencode/cli-darwin-arm64/bin/opencode` |

For DSH, the installer restored mode `0755` on the `node-pty` `spawn-helper`. The qualified `dsh.close` contract used the managed binary through `BYOK_CONTRACT_DSH_BIN`. A real ACP shell tool started, and closing the session reaped its processes. That case passed. The other 23 contract cases were filtered out.

A preflight on the same macOS arm64 host used the Claude and Codex adapter pins from `038d66c9d` in a temporary copy of the client source. Claude `2.1.326` selected `@anthropic-ai/claude-code-darwin-arm64/claude`. Codex `0.169.0` selected `node_modules/.bin/codex`. Both passed the public operation’s version and help probes and published their installations.
The `@openai/codex@0.169.0` package maps its bin to `bin/codex.js`, which
launches the installed platform package. Its manifest declares no postinstall
script.

A Windows x64 run on `win-ci` used Node 26.13.0 and npm 11.20.0. The
installer resolved `node.exe` and its adjacent `node_modules/npm/bin/npm-cli.js`
and passed the SDK install path, which contained spaces, as an argument.
Claude `2.1.312`, Codex `0.160.0`, and OpenCode `2.3.0` each returned
`installed` on the first call and `current` on the second. Uninstall succeeded
for each runtime. DSH's runtime contract covers macOS and Linux.

`agy help update` confirmed the standalone CLI's `agy update` command. Grok returns its vendor npm command. The installer regression suite exercises both vendor responses, native package path selection, version mismatch before publication, and preservation of the previous generation after a failed install.

## Rebase onto OAR 0.121

The rebased SDK used fresh temporary install roots on macOS arm64. Each Host install returned `installed` after its version and liveness probes. A second call returned `current` and kept the same generation.

| Runtime | Qualified release | Selected executable |
| --- | --- | --- |
| Claude | `2.1.326` | `@anthropic-ai/claude-code-darwin-arm64/claude` |
| Codex | `0.169.0` | `node_modules/.bin/codex` |
| DSH | `0.2.2-rc.1` | `node_modules/.bin/dsh` |
| OpenCode | `2.3.0` | `@opencode/cli-darwin-arm64/bin/opencode` |

The runtime contract installer verified the pinned Antigravity archive against the qualified SHA-512. The extracted CLI reported `1.5.11` and printed usage for `agy update`.
