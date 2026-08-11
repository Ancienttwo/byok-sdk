# @byok-sdk/client

The local BYOK daemon. It pairs a device, durably journals tasks, connects over
WebSocket or long poll, dispatches to local Claude Code, Codex, or pi adapters,
and exposes authenticated local diagnostics/control commands.

The package installs `byok-agent` and `byok-approval-mcp` binaries. Provider
credentials are not read by the dispatch plane; `@byok-sdk/keys` is separate.

Pi is a required exact npm dependency and runs as an external Node subprocess;
authenticate it with your own provider credentials. Claude Code and Codex
remain user-installed runtimes. The SDK never reads or packages provider
credentials. Hosts that only need runtime detection/composition can import the
transport-free adapter surface:

```ts
import { PiAdapter, ClaudeAdapter, CodexAdapter } from '@byok-sdk/client/adapters';
```

MIT licensed. Node.js 22.19.0 or newer.
