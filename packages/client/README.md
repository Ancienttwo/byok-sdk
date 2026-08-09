# @byok-sdk/client

The local BYOK daemon. It pairs a device, durably journals tasks, connects over
WebSocket or long poll, dispatches to local Claude Code, Codex, or pi adapters,
and exposes authenticated local diagnostics/control commands.

The package installs `byok-agent` and `byok-approval-mcp` binaries. Provider
credentials are not read by the dispatch plane; `@byok-sdk/keys` is separate.

MIT licensed. Node.js 20 or newer; SQLite-backed journaling requires a runtime
with `node:sqlite` support.
