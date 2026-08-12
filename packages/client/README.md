# @byok-sdk/client

The local BYOK daemon. It pairs a device, durably journals tasks, connects over
WebSocket or long poll, dispatches to local Claude Code, Codex, or pi adapters,
and exposes authenticated local diagnostics/control commands.

The package installs `byok-agent` and `byok-approval-mcp` binaries. Provider
credentials are not read by the dispatch plane; `@byok-sdk/keys` is a separate
install and keeps a zero dependency edge to this package.

Pi is a required exact npm dependency and runs as an external Node subprocess.
For an authoritative BYOK `dispatchSelection`, configure `piByokLauncher` with
the separately installed `byok-pi-provider-launcher`, the local non-secret
profile database path, and a stable Pi session directory. The client passes
only those paths plus provider/model ids; the launcher alone reads the OS
credential when required and spawns Pi. Both custody paths must be absolute;
missing launcher configuration fails closed.

Claude Code and Codex remain user-installed runtimes and use their own login
state. Hosts that only need runtime detection/composition can import the
transport-free adapter surface:

```ts
import { PiAdapter, ClaudeAdapter, CodexAdapter } from '@byok-sdk/client/adapters';
```

MIT licensed. Node.js 22.19.0 or newer.
