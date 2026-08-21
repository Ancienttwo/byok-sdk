# RAFT toolset operability pattern applied to BYOK SDK

> Date: 2026-08-21
> Source comparison: `projects/raft-study` architecture refresh and RAFT
> 1.0.18 reverse probes
> Scope: device-local MCP registry status/reload only

## Conclusion

RAFT's useful extraction is the local operability shape: content-addressed
configuration, explicit reload receipt, and bounded diagnostic projection. Its
process lifecycle semantics cannot be copied wholesale because BYOK daemon does
not currently own a long-lived connector process. Claude receives a task-scoped
`--mcp-config` and owns the spawned MCP subprocess for that task.

BYOK therefore applies the pattern as two explicit authorities:

1. `McpToolsetRegistry` owns validated executable configuration, canonical
   revision, atomic replacement, and the logical ids projected to admission and
   discovery.
2. The local connector host owns lifecycle truth. It may report one typed,
   bounded observation. Absence is `unobserved`; the SDK never derives
   readiness from configuration or command presence.

## P1 — architecture map

- `packages/client/src/daemon/toolset-registry.ts`: sole registry and
  observation authority.
- `create-daemon.ts`: composition, public host methods, authenticated control
  RPC, and redacted status.
- `task-runner.ts`: reads one snapshot per offer and copies the resolved MCP
  server projection before claim/start.
- `presence-publisher.ts` and `ws-transport.ts`: read current logical ids;
  executable definitions stay local.
- `bin/commands/toolsets.ts`: CLI host reads the config file and sends a complete
  CAS candidate; daemon never reads a caller-supplied path.

Out of scope: wire schema changes, remote installation, tool mutation policy,
daemon-owned connector supervision, and enable/disable.

## P2 — concrete trace

`byok-agent toolsets reload --config <path>` loads local JSON, calls live
`status` for the current revision, then sends `{expectedRevision, mcpToolsets}`
over the authenticated control socket. The daemon validates a complete candidate
and swaps it synchronously only if the revision still matches. The receipt
contains previous/current revision, changed flag, ids, server counts, and any
still-valid explicit observations. It contains no executable bytes.

An offer already admitted keeps the copied MCP projection it received. The next
offer calls the registry getter and resolves the new snapshot. Presence reads
the current ids on every heartbeat; WS reads them on every `conn.hello`.

## P3 — decision and falsifier

Content revision is the authority instead of a process-local counter so restart
and same-content reload are stable. CAS prevents two local hosts from silently
overwriting one another. An observation is tied to the definition revision:
unchanged definitions retain it; changed definitions clear it.

An observation report also carries the expected definition revision, so a late
event from the pre-reload process fails closed instead of attaching to the new
definition.

Falsifier: a real product needs the daemon itself to guarantee `ready`, detect a
mid-run crash, or restart a connector with no external host report. That proves
the missing product is a long-lived connector supervisor, not more registry
metadata. Start a separate work package that first assigns process ownership and
defines a crash/recovery receipt; do not extend this registry with probes or
heuristics.

## Verification boundary

- Stable revision independent of input key order and restart.
- Same-content reload is idempotent.
- Stale and malformed reloads preserve current authority.
- First and second offers keep pre/post reload projections respectively.
- Presence heartbeat and reconnect hello read current logical ids.
- Status and receipts are redacted; concrete lifecycle state exists only after
  an explicit host report.
