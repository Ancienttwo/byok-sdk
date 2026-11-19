# Host upgrade to the next MINOR

This checklist starts after the published 0.44.1 release. Hosts on an earlier release first follow the
[0.44.0 checklist](host-upgrade-0.44.0.md) and its predecessors.

## MCP toolset search

The configuration accepts `exposure: 'search'` on a local `DaemonConfig.mcpToolsets.<id>` entry. The Host selects the ID with `requiredToolsets` as usual. In a qualified ordinary Attempt, one task-scoped `byoktools` server provides `tool_search` and `call_tool` for all selected search toolsets.

The initial combination is SDK-built dsh `0.2.2-rc.1` on macOS arm64, in the ordinary lane with `sandbox: 'danger-full-access'` and the Node distribution helper. Set the daemon environment variable `BYOK_DSH_BIN` to the absolute path of the qualified dsh executable. This combination uses SDK authorization mode `all`. Other combinations stay closed. Prepared input preparation and execution require `direct`. Use `direct` also for native-sessions, durable Pi, and custom adapters. [Runtime qualification](../researches/2026-11-19-mcp-search-runtime-qualification.md)

If a selected server already uses `byoktools`, keep that task direct-only or rename the server before selecting any search toolset. Update the Host's exact selectors and any native rules or hooks that mention the old name. Check whether a saved runtime session can resume with the changed tool names before reusing it.

Claude stays closed to search in this release. When qualifying a future Claude combination, its native deny rules and `PreToolUse` hooks see the hub call, such as `mcp__byoktools__call_tool`, with the inner identity in `server` and `tool` and its parameters in `arguments`. Review any native filters that rely on a direct tool name before opting in. SDK authorization selectors continue to match the inner tool name, server, and arguments.
