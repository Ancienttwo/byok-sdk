# Host upgrade to the next MINOR

Draft checklist for changes after 0.43.0. Earlier Hosts must first apply the [0.43.0 Host upgrade checklist](host-upgrade-0.43.0.md) and preceding checklists.

Add future Host-visible changes here; do not amend the 0.43.0 cut's upgrade-manifest entries. The 0.43.0 release record archived that manifest unchanged and established the 0.43.0 release snapshot as the next baseline.

## Bot collaboration inbound conversation identity (#2250)

`@byok-sdk/bot-collaboration` `inboundKey(message)` now hashes channel,
conversation kind, conversation id and platform message id. Direct and group
conversations with the same id no longer share inbound or receive command
identities. Existing team configurations remain valid, including a room id
that equals a Bot id.

Every inbound key changes. An event already in flight across the upgrade can
be admitted again once because its previous deduplication identity no longer
matches. Drain inbound delivery before upgrading, or account for that one-time
redelivery. Hosts that persist or compare inbound keys must use the new keys;
there is no compatibility lookup of the old key.

## Bot collaboration round inbound disposition (#2255)

`@byok-sdk/bot-collaboration` `inboundDispositions()` and its `inbound:`
projections now describe whether a room input got an answer. An existing root
Turn remains authoritative, including explicit root cancellation. Without a
root Turn, a succeeded or delivered seat wins over any failed or cancelled
seat, so cancelling a sibling after an answer no longer changes `answered`
to `cancelled`. If no seat succeeded, a failed or cancelled seat means
`failed`; otherwise the input remains `coalesced`. Even cancelling all seats
does not cancel the round root.

Hosts that render or consume these dispositions must treat `cancelled` as
root or batch cancellation and accept `failed` for seat-only cancellation.
Re-reading existing ledger rows uses this precedence too. No store migration
is needed.

## Device retirement keeps assertion replay entries (#2264)

On the Postgres data plane (`@byok-sdk/cloud-dataplane`
`createPostgresCloudStores()`), `devices.revoke()` and machine supersession
through `devices.register()` or `pairing.redeemAndRegister()` no longer delete
the retired device's `device_assertion_replay` rows. Each row stays until its
assertion expires (at most 5 minutes after issue) and `collectExpired` removes
it. Before, re-registering the same `deviceId` with the same public key let a
device or task assertion spent before the retirement authenticate once more.

The in-memory and SQLite compositions never deleted these entries and are
unchanged. A Host that implements its own `@byok-sdk/cloud` `DeviceDirectory`
must not delete replay entries on revoke or supersession either. No schema
change or migration is needed; replay retention stays bounded by the assertion
TTL.

Expired replay rows are not removed on their own. Pass the replay authority as
`createByokCloud({ deviceAssertionReplay })` and run `runMaintenance()` on a
schedule; without the authority the `deviceAssertionReplay` step reports
`not-configured` and expired rows accumulate.

## OAR 0.109.0 (#2235)

The vendored OAR moves from 0.105.0 to 0.109.0 (`packages/client/vendor/oar/4eb5919/`, fork branch `byok/0.109.0`). No public type, export or configuration field changes. The upgrade manifest declares the three behavior-only breaking changes below as `model-confirmation-non-retryable`, `agy-model-confirmation-deadline` and `claude-queued-write-failure`.

### Unconfirmed models fail non-retryable (Codex, agy)

When a Codex or agy start ends with the runtime keeping a model other than the requested one, OAR now throws `ModelConfirmationError` and the start fails non-retryable. The `task.fail` for that start carries `retryable: false` and `failure.class: 'unknown'`; earlier releases sent `retryable: true`, with `failure.class` `unknown`, or `runtime_exited` when the runtime process had exited on its own. The `reason` text is unchanged: `codex <method> kept model <reported> although <requested> was requested` for Codex, `ACP config_option_update left model at <reported> although <requested> was requested` for agy. A Host that embeds an adapter directly sees the same values on the `RuntimeExecutionFailure` that `start` rejects with (`phase: 'start'`, `retry: 'non-retryable'`).

Do not retry these starts as transient: the same request asks for the same model and gets the same answer. Change the requested model or update the runtime's model access, then send a new task. dsh already failed this case non-retryable (`UnsupportedOptionError`) and is unchanged. Grok and OpenCode do not confirm the applied model through OAR this way, and OpenCode's own readback check was already non-retryable; both are unchanged.

### agy model mismatches wait up to the request deadline

agy confirms a model switch from its `config_option_update` notifications. 0.43.0 failed the start on the first notification that reported another model (`packages/client/vendor/oar/2f81b34/shared/acp/config-updates.ts:32-35`). Now a conflicting notification is only an observation: a notification with the requested model still confirms the switch immediately, and the start fails only when the request's deadline runs out with agy still reporting another model (`packages/client/vendor/oar/4eb5919/shared/acp/config-updates.ts:50-57`). That deadline is agy's request timeout, 30 s (`packages/client/vendor/oar/4eb5919/runtimes/antigravity/session.ts:42`). The Host sees two differences:

- A conflicting notification followed by the requested model now starts the task; 0.43.0 sent `task.fail`.
- A real mismatch reaches the Host as `task.fail` about 30 s after the switch instead of immediately.

A Host that bounds agy starts with its own timeout shorter than 30 s now hits that timeout first and never receives the `ModelConfirmationError` failure; allow at least the 30 s deadline before giving up on an agy start that requested a model. Do not treat a start that succeeds after an earlier conflicting update as suspect: the model agy finally reported is the requested one.

### agy runs with `--gemini-dir`

agy's ACP command now carries `--gemini-dir <owned home>/.gemini`, the directory the adapter already sets through `GEMINI_HOME`. The argument is passed only to the agy process; no event, error or record changes. The device's agy must accept `--gemini-dir` under `agy acp` (1.5.2 lists it; the qualified 1.5.1 has fixture evidence only). If an allowlist or wrapper validates agy's argv, add the flag.

### Claude queued follow-up write failures

`ClaudeAdapter` session `followUp()` sends a busy-refused instruction through OAR's queue. OAR now always holds a queued input (record `queued: "adapter"`) and writes it to Claude as a separate `toRuntime` prompt request when Claude's own turn ends. Host events for a queued follow-up are unchanged; the held record and the prompt request are internal records and are not projected to events.

One failure path changes. If Claude's own turn ends between the busy refusal and the queue, 0.43.0 wrote the input inside `queue()` (`packages/client/vendor/oar/2f81b34/shared/stream-json/session.ts:247-259`), and a failed stdin write rejected `followUp()` with retryable `RuntimeExecutionFailure` `claude follow-up instruction transport failed` (`packages/client/src/adapters/claude/claude-adapter.ts:772-775`). The write now happens after the queue request is answered (`packages/client/vendor/oar/4eb5919/shared/stream-json/session.ts:253-263`), outside the writes `followUp()` awaits, so `followUp()` resolves. The write failure fails the Claude process (`packages/client/src/adapters/claude/stream-session.ts:94-99`), and the session's `events` iteration then throws the retryable run failure for the ended process: `claude runtime event transport failed` or `claude runtime process ended before a terminal result frame` (`packages/client/src/adapters/claude/claude-adapter.ts:671-684`).

This affects only a Host that embeds `ClaudeAdapter` directly; the daemon does not call `followUp()`, so daemon Hosts need no change. An embedding Host must treat a resolved `followUp()` as accepted for delivery, not as written, and handle the failure from `events` as it handles any mid-turn process failure: the follow-up was not delivered, so resend it on a new session.

## Removed unused client APIs

### Task terminal evidence

`AgentSessionHandoffStore.getTaskTerminal()` is removed. Stop calling the unused
read API. Production failure handling still awaits `recordTaskTerminal()` to
persist evidence before sending `task.fail`; use that write receipt when recording
a failure. There is no public terminal-evidence read replacement.

### Team workspaces

`LocalTeamWorkspace.getWorkspace()`, `updateWorkspace()` and
`validateMemberLease()` (also exposed by `LocalTeamWorkspaceService`) are removed,
along with the unused
`UpdateTeamWorkspaceInput` declaration. Use `listWorkspaces()` to inspect workspace
definitions. Validate a member lease by performing the intended `postMessage()`,
`readMessages()` or `ackMessages()` operation; each resolves the lease itself.
There is no public in-place membership/limit update API. Create a separately named
workspace with the desired definition and issue its member leases instead.

### Egress drop receipts

`AgentEgressController.dropReceipts()` and `AgentEgressDropReceipt` are removed,
including the unused in-memory receipt buffer. `noteTransportDrop(reason)` no
longer accepts an optional `AgentRef`; pass only the drop reason. Use `status()` for each lane's
`dropped`, `replaced` and `lastDropReason`. Per-drop history is no longer retained;
Hosts needing an audit history must collect it at their own transport boundary.

### Standalone daemon log writer

`openDaemonLog()` and `DaemonLog` are removed. An embedding Host that writes its
own individual log lines must own its log sink, append complete lines and apply
its own retention/rotation policy. `DaemonLogOptions` remains because the daemon's
internal process-output router still uses it. That router captures all stdout
and stderr for the daemon process; it is not a same-semantics replacement for a
Host's standalone line writer and is not exported from the package entrypoint.

### Service exit disposition

`serviceExitDisposition()` and `ServiceExitDisposition` are removed.
`EXIT_CODE_CONTRACT` and `ExitCode` remain for documented exit statuses. Hosts
with their own service supervision must configure stop on exit 0 and restart on
failure in that supervisor. The SDK-generated launchd, systemd and WinSW units
already enforce that policy; `daemonExitCode()` remains unchanged.

### Pi RPC close wait

`PiRpcClient.waitClosed()` is removed from the published declaration closure.
Hosts that inject a `spawnFn` and need to observe child transport closure must
subscribe to their owned child's `close` event. Consumers can drain `events` and
inspect `terminalError` / `processExited` for RPC termination. `dispose()` remains
the explicit process-tree cleanup receipt; calling it initiates termination and
is not a passive close wait. Internal process-tree cleanup still waits for the
client's private close promise.

## Blocked Turn projection ids (#2245)

`@byok-sdk/bot-collaboration` publishes a Turn that cannot freeze as `blocked:<turnId>:<code>:<fingerprint>` with `{ owner, turnId, code, reason }`. 0.43.0 published `blocked:<turnId>` with `{ owner, turnId, reason }` each time the reason changed, so a reason that carries a model name or a byte count gave one id two values and K4 `project` threw `Projection identity conflict`. The upgrade manifest declares this as `bot-blocked-projection-id`.

- `code` is `unavailable_model`, `schema_over_budget` or `current_request_too_large`. `reason` keeps the full details, such as the model name or byte counts.
- The fingerprint is the first 12 hex digits of the SHA-256 of the canonical JSON of `{ code, reason }`. Each id has one value.
- A Turn whose reason changes while it stays blocked gets one more `blocked:` id per reason. The byte count of `schema_over_budget` follows the team, so each team change can add one row while the Turn stays blocked. A reason that comes back republishes the same id and value; deduplicate by id.

A Host that routes projections by the `blocked:` prefix needs no change. A Host that builds `blocked:<turnId>` or reads the turn id from the projection id must match the `blocked:` prefix and read `turnId` and `code` from the value.

## Pi Agent skills from DaemonConfig (#2169)

`DaemonConfig.runtimes.pi.agentSkillPaths` (also `PiRuntimeConfig` for
`createRuntimeAdapters`) takes the absolute skill files or directories a Host
authorizes for Pi Agent tasks. It projects to
`PiAdapterOptions.agentSkillPaths`, so a Host no longer has to build its own
`PiAdapter` and call `createDaemonWithAdapters` to hand Pi its skills. Unset
keeps the default `[]`; no Host action is required.

- Config check refuses a relative, duplicated or NUL-carrying path, and a
  non-empty list together with `runtimes.pi.durableLane`, as
  `DaemonConfigInvalidError` at `runtimes.pi.agentSkillPaths`.
- The prepared lane still refuses Agent resources before spawning.
- A skill path that is missing or unreadable when an Agent task starts now
  fails that start before Pi spawns, as a non-retryable `RuntimeExecutionFailure`.
  It used to surface as a retryable `runtime_exited` start failure, so the
  task was retried against the same missing file. This applies to an embedded
  `PiAdapter` too.
- Under a file-scoped offer the SDK's scoped `read` refuses a skill outside the
  granted roots (`outside_scope`), so the model cannot load it on its own;
  `/skill:<name>` still expands it. Symlinks are followed and the owner is not
  checked. See [Host-provided skills](../adapter-capabilities.md#host-provided-skills-by-runtime-1846).
