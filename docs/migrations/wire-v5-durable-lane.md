# Wire v5: `durableLane` and generic runtime names

The release after 0.33.0 moves the envelope wire from v4 to v5
(`PROTOCOL_VERSION = 5`). It renames one field: the runtime capability
`durablePi` is `durableLane`, the durable worker lane (Pi today). Every other
v4 shape is unchanged. The same release gives the client's Pi-named runtime
options and types generic names. 0.33.0 is the last v4 release.

A rename narrows a shipped shape. A v4 reader would strip `durableLane` and a
v5 reader would strip `durablePi`, so between mixed peers the durable lane
would silently disappear. That is why this is a wire major and not an alias
([protocol, Freeze rule](../protocol.md#freeze-rule)).

## Who has to do something

| Host | Action |
| --- | --- |
| Every deployment | Drain, then upgrade the server side and the daemons together (below). |
| Hosted cloud | Read the results you still need of tasks that ended before the cut. |
| `DaemonConfig.durablePi` | Set `runtimes.pi.durableLane` instead. |
| `createDaemonWithAdapters` with a durable Pi | Construct `PiAdapter({ durableLane: true })`; no daemon option is needed. |
| Reads presence or `RuntimeCapabilities` | Read `durableLane`. |
| Custom runtime adapter | Type `runtimeLaunch` as `RuntimeLaunchResources`. |

## Drain and upgrade

There is no v4 reader and no negotiation. A v4 envelope is rejected at the
version boundary, a `conn.hello` whose `protocolVersions` omits `5` is refused
with `hello_protocol_version_unsupported`, and a v5 daemon cannot use a v4
server.

1. Stop new submissions. Let every pending mailbox row be processed and
   acknowledged, every in-flight execution reach a terminal, and every daemon
   pending terminal be acknowledged.
2. Stop the v4 Host and its daemons.
3. Start the v5 embedded server or hosted cloud (`@byok-sdk/cloud`,
   `@byok-sdk/cloud-dataplane`), then the v5 daemons. A Topology L
   application upgrades both sides together.

Unlike the v3 → v4 cut, the stores need not be new and devices keep their
enrollment. A pending v4 row stops startup and is left unchanged:

| Store | Refusal |
| --- | --- |
| Embedded server SQLite | `SqliteSchemaError`, `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED` |
| Hosted Postgres | `PostgresMailboxProtocolUnsupportedError`, `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` |
| Daemon journal | `DaemonJournalProtocolUnsupportedError` |

Retained `acked` and `expired` rows do not block startup. If a refusal
appears, keep the database and finish the drain with the previous SDK; do not
delete rows to force startup. The offline check is in
[protocol, SQLite startup check](../protocol.md#sqlite-startup-check-for-wire-major-upgrades).

Nothing rewrites v4 bytes. A hosted terminal receipt a v4 build stored no
longer decodes, so `projectTerminalResult` and `readDeviceTerminalReceipt`
fail with `terminal_receipt_unreadable` for a task that ended before the cut.
Read and keep the results you still need before you upgrade.

## Runtime names

- `DaemonConfig.durablePi` is removed and raises
  `DaemonConfigFieldRemovedError`. Set `runtimes.pi.durableLane: true`. The
  same checks apply: it needs an Agent home and the Pi custody launcher, and
  it is unavailable on Windows.
- `PiAdapterOptions.durablePi` and `RuntimeCapabilities.durablePi` are
  `durableLane`.
- The daemon wires the durable journal and `durableContext` from an
  adapter's `capabilities.durableLane`, not from a daemon option. A Host that
  passes `PiAdapter({ durableLane: true })` to `createDaemonWithAdapters`
  gets the durable lane with no other setting. Such an adapter without an
  Agent home refuses to start.
- The launch resources are the exported `RuntimeLaunchResources`
  (`scratch`, `release()`). `RuntimeOperationStartInput.runtimeLaunch` and
  `PreparedRuntimeOperation.resolveRuntimeLaunch` use it; the Pi launch type
  extends it.
