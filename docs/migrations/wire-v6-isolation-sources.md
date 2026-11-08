# Wire v6: isolation sources

The next MINOR after 0.40.0 moves the envelope wire from v5 to v6
(`PROTOCOL_VERSION = 6`). It replaces one field: the runtime capability
`isolation.userContext` becomes one bit per source of user-level context a
runtime can keep out. Every other v5 shape is unchanged. 0.40.0 is the last
v5 release.

Removing a field narrows a shipped shape. A v5 reader would strip the new
bits and a v6 reader would strip `userContext`, so between mixed peers the
isolation facts would silently disappear. That is why this is a wire major
and not an alias ([protocol, Freeze rule](../protocol.md#freeze-rule)).

This page holds the wire facts only. The Host steps, the per-adapter values
and what still reaches the model are in the
[0.41.0 Host upgrade guide](../releases/host-upgrade-0.41.0.md).

## Shape

`RuntimeCapabilities.isolation` (`RuntimeCapabilitiesSchema`), carried on
`conn.hello` `runtimes[]` and `harnesses[]`, on `task.claim` and in presence
`runtimes[].capabilities` (`PresenceRuntimeCapabilities`), and in the
client's `RuntimeIsolationCapabilities`:

| v5 | v6 | Source the bit names |
| --- | --- | --- |
| `userContext` | removed | |
| | `userInstructions` | User-level instruction files: a user `CLAUDE.md`, `AGENTS.md` or rules |
| | `userOutputStyle` | The output style the user configured for the runtime |
| | `userMemory` | The runtime's user-level memory store |
| | `userSkills` | Skills the user installed, including their names and descriptions |
| | `userHookContext` | Context that user-configured hooks add to the model, such as SessionStart output |
| `userMcpServers` | `userMcpServers` | MCP servers the user configured for the runtime |
| `sessionPersistence` | `sessionPersistence` | The runtime's own transcript store |

Every bit stays optional on the wire. `true` is a guarantee the runtime
contract suite checks, or an evidence-backed declaration that the qualified
runtime has no such source; `false` means the SDK makes no such guarantee; a
missing bit is unknown. There is no derived `userContext` field: a v6 peer
neither sends nor reads it.

## Errors

There is no v5 reader and no negotiation.

| Where | v5 input | Result |
| --- | --- | --- |
| Envelope decoder | an envelope with `v: 5` | `EnvelopeValidationError` on `v` |
| Server handshake | a `conn.hello` whose `protocolVersions` omits `6` | `hello_protocol_version_unsupported` |
| Server inbound | a `v: 5` envelope | `protocol_version_unsupported` |
| `POST /byok/messages` | a batch with a `v: 5` envelope | HTTP 400 |

A v6 daemon cannot use a v5 server: the v5 decoder rejects every v6 envelope.

## Store refusals

Each store checks its pending rows when it opens and refuses a row of
another major. The check is read-only: the row is left unchanged. Retained
`acked` and `expired` rows do not block startup. There is no drain or
upgrade-precheck tool for this cut.

| Store | Refusal |
| --- | --- |
| Embedded server SQLite | `SqliteSchemaError`, `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED` |
| Hosted Postgres | `PostgresMailboxProtocolUnsupportedError`, `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` |
| Daemon journal | `DaemonJournalProtocolUnsupportedError` (`daemon_journal_protocol_unsupported`) |

The offline SQLite query is in
[protocol, SQLite startup check](../protocol.md#sqlite-startup-check-for-wire-major-upgrades).
