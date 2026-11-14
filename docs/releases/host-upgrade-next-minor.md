# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Unique injected adapter IDs (#2135)

`createDaemonWithAdapters(config, adapters)` now throws `DaemonConfigInvalidError`
synchronously when two injected adapters have the same `descriptor.id`. The
error has `code: 'daemon_config_invalid'` and names the duplicate ID in its
message. Previously the array was accepted and lookup by ID silently selected
the first matching adapter.

`checkDaemonConfig(config, { source: 'embedded', adapters })` now returns
`ok: false` for the same duplicate IDs. Its `issues` match the construction
error's `issues`: `code: 'invalid_value'`, the path
`adapters[i].descriptor.id` of the first repeated ID, and a message naming
that ID. Preflight does not return an effective configuration for this input.

Before constructing the daemon, remove duplicate registrations and choose one
implementation for each ID. If two custom runtimes are distinct, give them
distinct IDs and update the Host's runtime routing to match. Handle this error
at construction as a configuration defect: correct the adapter list before
retrying; calling `daemon.start()` cannot resolve it.

## Behavior-only upgrade notices (#2117)

`@byok-sdk/client`'s upgrade manifest now declares behavior-only breaking changes with `behavior:<entry-id>`. Read `entries` for all upgrade actions; generated `changes` describes only snapshot differences and does not include these declarations. The gate requires a matching entry id, `impact: 'breaking'`, a summary and a migration link. It cannot detect a behavior change an author forgot to declare.

`checkUpgradeFrom()` and `byok-agent upgrade check --from <installed-version> --json` now return the authored `summary` on every breaking entry, including archived entries. Display it with `migration` in Host upgrade prompts. Test doubles that construct `UpgradeFromBreakingEntry` must also supply `summary`. A behavior-only entry causes the same `refused` verdict as other breaking entries when the candidate's release is newer than the supplied version.

The first declaration is `task-home-live` (#2084): `DaemonConfig.runtimeEnvironment` and per-runtime `runtimes.<id>.runtimeEnvironment` give task children the daemon's live `HOME` under the default `login-shell` base. If a startup file sets another `HOME`, tasks now use a different home. `PATH`, `XDG_*` and other derived snapshot values do not change; explicitly pass consistent live values or select `base: 'allowlist'` and supply them. Existing policies that pass `HOME` or use `allowlist` keep their behavior. See the [HOME migration guidance](#launchd-jobs-run-with-the-installs-home-2017). This behavior now appears in the machine-readable upgrade report as well as the changelog and Host checklist.

## Committed cancellation with a pending wake (#2004)

`HostExecutionCore.cancel()` now returns an object instead of `void`. Update callers and test doubles that require `Promise<void>` to accept its result. `BotCollaboration.cancelTurn()` and `abortSwitch()` keep their existing result fields. When only wake dispatch fails after one of these operations commits, it resolves with `wakePending: true` instead of rejecting. The failure can concern any wake in that drain, including one unrelated to the operation, and a concurrent retry may succeed before the result returns. Do not repeat the committed operation solely because the flag is present.

To inspect outstanding work, read `HostLedger.snapshot().outbox` on the ledger used by the core or Bot. Failed rows have `kind: 'schedule'` or `kind: 'cancel-wake'` and `lastError`; the core retries each row on a timer up to 10 times, with backoff capped at 60 seconds. After that, the row waits for another drain to retry it. Track the row's outbox key and wake key: a successful SDK schedule or cancel removes that unchanged row. A row can also be superseded by later work, so its disappearance alone does not prove that the wake fired. For a scheduled wake, `server.wakes.pending()` reports SDK-queued wakes; acceptance into that queue is not completion of the wake hook. An explicit `HostExecutionCore.drain()` or `BotCollaboration.drain()` that resolves confirms its drain did not report a dispatch failure; drains and wake hooks still reject `WakeDispatchError` when their only failures are wake calls.

## Committed cancellation with a drain failure (#2072)

`HostExecutionCore.cancel()`, `BotCollaboration.cancelTurn()`, `cancelHostIntent()` (#2144) and `abortSwitch()` now also resolve when the drain after commit fails on a Host job, projection outbox capacity, or a mixture of failures. Their existing result object gains `drainError?: unknown`. Check `'drainError' in result`, since JavaScript can throw `undefined`. The value is the exact drain rejection: a standalone `OutboxFullError` retains its class for `instanceof`; an `AggregateError` stays whole, with the original Host-thrown values in `errors`. Nothing is flattened or wrapped. `cancelTurn` and `cancelHostIntent` preserve the first non-wake failure even if a subsequent pass succeeds. For `cancelHostIntent`, both the core drain and the later Bot process pass follow this rule. The error comes from the same coalesced drain and can concern other Host work. A `cancelled` result confirms the cancel committed; with `drainError` or `wakePending`, its optional `conclusion` may be absent until a later successful drain settles the intent. After draining or recovery, replay `cancelHostIntent(key)` to read `already_settled` with its conclusion, or `cancel_pending` while a submitted intent awaits its terminal. A queued intent whose settlement still fails can return `cancelled` without a conclusion again. Direct callers (including AiphaBee) must move post-commit failure handling from `catch` to a property-presence check on the resolved `HostIntentCancelResult`; keep `catch` for pre-commit failures. Wake-only failures keep `wakePending: true` as described above.

Treat the operation as committed, inspect/report the error, and retry remaining work through `drain()` or recovery. Do not retry cancellation or abort solely because `drainError` is present; the abort's original revision is already stale. The field reports a failed drain, not pending work or terminal completion: a job that fails retains its existing retry state, while a job already concluded by the drain stays concluded. Capacity-refused transactions still roll back and can proceed after projections are delivered. Explicit drains and wake hooks continue to reject on these failures. Validation and transaction failures before the operation commits still reject.

## OpenCode qualified version 2.3.0 (#1972)

The OpenCode adapter's default policy qualifies 2.3.0. A device still running 2.2.6 reports the `runtime_version_unqualified` advisory with `qualifiedVersion: '2.3.0'` through detect; hello and presence report `state: 'warn'` with the same qualified version. The default policy remains `warn`, so tasks can still run. Upgrade the device's OpenCode to 2.3.0 to clear the advisory, or keep 2.2.6 and show the advisory while planning the upgrade. A Host that supplies its own OpenCode `versionPolicy` keeps that policy; review it separately before changing versions. See the [qualification evidence](../researches/2026-11-13-opencode-2.3.0-qualification.md).

## Undici in the Host dependency tree (#2081)

The client now depends on `undici` 8.12.4. Pi 1.5.2 still declares 8.12.3 exactly, so a Host install can retain a separate vulnerable copy. To use 8.12.4 throughout the npm dependency tree, add the line for your package manager to the root `package.json` and reinstall:

- npm: `"overrides": { "undici": "8.12.4" }`
- Bun: `"overrides": { "undici": "8.12.4" }`
- pnpm: `"pnpm": { "overrides": { "undici": "8.12.4" } }`

Merge these entries into any existing overrides. After reinstalling, inspect the dependency tree with `npm ls undici --all`, `bun pm why undici`, or `pnpm why -r undici`, respectively; every listed undici version should be 8.12.4. Pi's upstream pin is tracked in [#2098](https://github.com/Ancienttwo/byok-sdk/issues/2098). This does not update Node's built-in undici or copies bundled inside other packages; update those runtimes and packages separately.

## Cancel selected Host intents without a pass (#2003)

`BotCollaboration.cancelHostIntents(keys)` atomically cancels a chosen set of unsubmitted Host intents without draining. It returns settled conclusions on replay and refuses the whole set when any key is unknown, a Bot Turn or in flight. `HostIntentError.rejected` lists every refused key and code; exhaustive switches over `HostIntentError.code` add `inflight`. Existing single cancellation and switch APIs retain their other behavior, and the store format is unchanged; see the wake-dispatch change above. A Host may replace freeze → individual cancels → abort with this call; keep the freeze when other work on the device must also be held. Successors start on the next pass, or call `drain()` to start them.

## Ledger precheck and store ID (#1981)

The local bot-collaboration entry exports `inspectLedger(path, tenant)`, a precheck that reads a private copy of the stopped L ledger. If it reports `migration-required`, run `migrateWouldDo` after taking a snapshot and before serving. A valid exported ledger is accepted; if its switch is aborted, run the precheck again before serving. `LocalStoreId` adds `bot-collaboration-ledger`: update exhaustive switches and `Record<LocalStoreId, ...>` mappings to include the new member.

## cloud-do archived

`@byok-sdk/cloud-do` leaves the release train. Remove the dependency, or pin it to exactly 0.42.0 if the Host still needs it. No later version or fixes will be published. At the next MINOR release, the owner deprecates its published npm versions (#1959). The upgrade train check no longer inspects this package, even if it remains installed.

A Host retaining the 0.42.0 pin must not dispatch sealed tasks to cloud-do: it reads task content in plaintext and executes with platform keys. Route sealed tasks only to a device that supports the [sealed payload contract](../spec.md#hosted-sealed-payload-654).

Restart requires a product that needs a cloud agent using platform keys with Pi’s durable harness in Cloudflare Durable Objects. Start from `archive/cloud-do` (the last main commit with the package; it differs from the last published version `v0.42.0` only in its README), qualify it again against the Pi version current at the time, and obtain the replay-safe tool list, provider profiles and binding names from the Host. See [ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md).

## Pi cache warming stops at settlement (#1949)

No configuration change is needed. Every SDK Pi RPC session now caps its settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings, instead of answering each idle `cache_warming_decision` with `stop`. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file.

## MCP start-failure reasons carry only the error code (#2065)

When an MCP server or helper process cannot start, the reason in `task.decline` and `task.fail` now ends in `failed to start: spawn failed: <code>` instead of Node's `spawn <command path> <code>` message. For example, `MCP toolset server "team" failed to start: spawn /usr/local/bin/team-mcp ENOENT` now reads `MCP toolset server "team" failed to start: spawn failed: ENOENT`. Node's message named the command path, and its error kept the arguments, which can carry a credential, so only the code remains. Agent runtime, agent terminal tool and Pi RPC start failures use the same `spawn failed: <code>` form.

A Host that matches these reasons should key on the code (`ENOENT`, `EACCES` and so on) after `spawn failed: `, not on the command path or the old `spawn <path>` text. A reason without a Node code ends in `spawn failed: unknown`.

## Provider status reads take the configuration lock (#2012)

`ProviderRegistry.get()`, `list()` and `setDefaultModelProvider()` now read provider status under the same configuration lock that credential writers hold. In one process, a status read waits for a running `configure()`, `replaceSecret()`, `delete()` or sealed provisioning change to finish. With a file-backed `SqliteProviderProfileStore` that another process also writes (for example a separate custody child), a status read waits at most the store's `configurationLockWaitMs` (default `PROVIDER_CONFIGURATION_LOCK_WAIT_MS`, 10 000 ms). If the lock is still held after that wait, the read rejects with a `ByokKeysError` whose `code` is `PROVIDER_CONFIGURATION_BUSY`. Earlier releases never rejected here.

A Host that lists providers in a UI should catch this code, show the list as temporarily unavailable rather than as empty, and retry after the writer finishes. Writers hold the lock only for one credential change, so a retry after a short delay normally succeeds. Do not fall back to a cached list or a list read without the lock:

```ts
import { ByokKeysError } from '@byok-sdk/keys';

try {
  return await registry.list();
} catch (error) {
  if (error instanceof ByokKeysError && error.code === 'PROVIDER_CONFIGURATION_BUSY') {
    // Another process is changing a provider key: show "busy" and retry later.
  }
  throw error;
}
```

A Host that already handles `PROVIDER_CONFIGURATION_BUSY` from `configure()` or `resolveDefaultModelProvider()` can reuse that handling. When one profile's credential read fails, `list()` now rejects with that failure only after the other reads have finished. No configuration change is needed.

## One operation at a time per install root

Every `install()`, `upgrade()`, `rollback()`, `recover()` and `uninstall()`
now holds an install-root gate for its whole run (#2001). The gate does not
use the lifecycle `gateRoot`, so installations under different gate roots
that share one install root exclude each other: a second operation fails at
once with `lifecycle_owner_busy`, which now also means the install root is
in use, and writes nothing. Retry it after the first one ends. This resolves
the 0.42.0 known issue about installations under different `gateRoot`s
sharing one `installRoot`. A first install therefore no longer reads
`current` again under the store leases or refuses with `installation_exists`
after staging, and the install snapshots are listed once, after the gate is
taken. Every operation creates a missing install root before taking the
gate, so a refused operation can leave an empty install root behind; every
spelling of the root takes the same gate. On macOS and Linux, an install root
owned by another user (also one that user created first) is refused with the
new `ServiceInstallationErrorCode` `install_root_foreign_owner` before
anything is written in it; run the operation as the owner of the root. The
gate and the owner check use the effective uid. An install root another
user could rename or replace with a symlink after the check is refused with
the new code `install_root_ancestor_unsafe`, naming the directory or link
and why, before anything is created (#2028): the root's path is resolved one
component at a time, every directory read on the way must belong to the
installing user or root and must not be writable by everyone unless it has
the sticky bit, and every symbolic link on the way must belong to the
installing user or root (at most 40 links). Root's own links such as macOS
`/tmp` pass. An install root written with a `..` segment, one under a directory the
installing user cannot read, or one whose links lead through `..` after a missing directory, is refused the same way; a missing
install root is created one directory at a time only after its whole path
passes, and the install root itself owned by another user stays
`install_root_foreign_owner`. Move such an install root under a
directory only the installing user or root can change. Group-writable
directories are accepted and their group trusted (macOS `/Applications` is
root:admin 775). Windows has neither check, since rename rights there follow
ACLs the SDK does not read: keep the install root under a directory only the
installing user can change, such as `%LOCALAPPDATA%`. Two Windows users
operating on one install root are not guaranteed to exclude each other.

## Gate release failures join the thrown error

A path mutation gate release that fails while another error is thrown is
no longer dropped (#2002). A Host that matches `PathMutationGateBusyError`,
`ServiceUnitError` codes or `LocalStateRelocationBusyError` keeps matching
them: those classes and codes stay, and the release failure is in `cause`,
an `AggregateError` of the original error and every release failure. A
`LocalStateRelocationBusyError` from a partial gate acquisition has two
levels: its `cause` is that `PathMutationGateBusyError`, whose own `cause` is
the `AggregateError`. An
error of another class that a managed service lifecycle operation throws
becomes that `AggregateError` when the `service-lifecycle` gate also fails
to release. `localStateRelocation.acquire()` reports a refusal whose gate
release failed as `LocalStateRelocationIntegrityError`, as before, now with
the refusal and the release failures in `cause`; its busy and integrity
errors otherwise carry the original error as `cause`. A gate whose release
failed may still be held until its process exits.

## Store migration failures are store_migration_failed

Every failure after the store snapshot now throws `store_migration_failed`
on both `install()` and `upgrade()`, after restoring the snapshot (#1984). A
`migrate` callback that throws used to surface its raw error (the raw launch
error of earlier notes), and a post-migration precheck that failed or printed
malformed output surfaced `precheck_failed`; both are now the `cause` of
`store_migration_failed`. On `upgrade()` the receipt records `failed` with
`store_migration_failed`, where a thrown `migrate` callback used to leave it
`pending` until `recover()`. A Host that matched a raw launch error or
`precheck_failed` after a migration matches `store_migration_failed` and
reads `cause`; one that ran `recover()` after a thrown callback no longer
needs to, since the receipt is already `failed` and the old version
restarted.

## Upgrade and rollback enforce the health-check deadline

`upgrade()`, `rollback()` and `recover()` now enforce `healthTimeoutMs` as
`install()` does (#1977). A custom `healthCheck` that ignores its abort signal
no longer keeps the operation pending with the lifecycle owner gate held, and
a check that succeeds after the deadline fails. A late upgrade check restores
the previous version (`health_check_failed`), and a late check of the
restored version leaves a `failed` receipt with `rollback_unhealthy`, as for
any failed check; `upgrade()` then throws `health_check_failed` with that
failure in its `cause` (#2010). The clock
now starts after start returns, as on install; platform commands run
outside it, under their own bounds (see
[Service manager commands time out](#service-manager-commands-time-out-1971)). A Host whose check is slower than `healthTimeoutMs`
raises it. `healthTimeoutMs` must now be an integer from 1 to 2147483647
(2^31-1): any other value makes `createServiceInstallation()` throw a
`TypeError`, the error it already throws for `daemonStores` without
`healthCheck`. Before,
0 or less still ran the check once, and a larger value made the timer fire
at once.

## Service manager commands time out (#1971)

Every service manager command a service lifecycle runs now has a fixed bound:
30 s for `launchctl`, `systemctl --user`, `sc.exe`, the Windows Startup
launcher query and the Startup launch, 120 s for WinSW, and 60 s for the
Host's Windows `stop` program. On Windows, the `icacls` run that hardens a
store root when a `ServiceInstallation` leases it has its 30 s bound too. The
bounds are not configurable. A command that outlives its bound is stopped
(its process tree; for the Startup launch only its own `cmd`) and reported as
`ServiceUnitError` code `service_command_timeout`, as listed below. Before, such a command
could hang the operation forever. Launchd's leading `bootout`, `kickstart -k`
and systemd's `daemon-reload` after removal, which ignore a failure exit,
still fail on a timeout.

The code is new: an exhaustive switch over `ServiceUnitErrorCode` gains a
case. A timeout means the service's state is unknown, never that the change
did not happen. Branch on the error's `exitConfirmed`:

- `true`: the command has exited. Read `status()`, then run the operation
  again; each platform's next `install` or `uninstall` starts from the
  service manager's own state.
- `false`: the command's cleanup failed or did not finish in time, so it may
  still be running and still change the service. Retrying now can race it;
  check the service manager first. The SDK keeps no ownership of that
  process.

Where it appears ("in `cause`" means through `cause` and an
`AggregateError`'s `errors`):

- Every `ServiceInstallation` operation first restores the repair snapshot
  of an earlier failed install when `current` is absent; a timed-out stop or
  store lease there is `upgrade_pending`, with the timeout in `cause`.
- `install()`, first install: a timed-out stop of the marked unit or store
  lease, before anything is installed, is thrown as is; a timed-out restart
  of that unit after a failed preparation joins the `cause` of the
  preparation's error. A timed-out activation or start is
  `install_health_check_failed` with it in `cause`, as is a timed-out unit
  removal during the cleanup that follows (`upgrade_pending` instead when
  that cleanup cannot restore the stores).
- `install()`, same-version reinstall: a timed-out stop before the unit
  rewrite is thrown as is, and the pending `repair` receipt stays
  (`recover()` then reports `repair_interrupted`). A timed-out activation or
  start is `install_health_check_failed` with it in `cause`.
- `upgrade()`: a timed-out stop or store lease before the switch is
  `upgrade_pending` with it in `cause`. A timed-out start of the candidate is
  `health_check_failed` with it in `cause`, and the rollback runs; a
  timed-out stop or lease in that rollback makes it `upgrade_pending`, and a
  timed-out start of the restored version joins the `cause` of
  `health_check_failed`. A store refusal whose restart of the previous
  version times out keeps the refusal's code, with the timeout in `cause`.
- `rollback()`: a timed-out stop or store lease is thrown as is; only the
  stop has run. A timed-out start of the restored version is not thrown:
  `rollback()` resolves with a `failed` receipt, `rollback_unhealthy`.
- `recover()`: a timed-out stop or store lease before a restore is
  `upgrade_pending` with it in `cause`. A timed-out start is not thrown:
  `recover()` resolves with a `failed` receipt (`switch_unhealthy` or
  `rollback_unhealthy`).
- `uninstall()`: a timed-out stop, unregistration or `daemon-reload` is
  thrown as is, after `current` is removed; the unit files stay when the stop
  or unregistration timed out.
- The lifecycle's own `install`, `repair`, `uninstall`, `start`, `stop` and
  `status` (also through `ServiceInstallation.lifecycle`) reject with it as
  is.

A timed-out start can still take effect later. The launcher it starts runs
`<installRoot>/current`, so what a late start runs depends on when it lands.
After a timed-out candidate start, `upgrade()` stops the service and leases
its stores while `current` still names the candidate: a late start in that
window runs the candidate. Once `current` is removed, a late start finds no
payload (the SDK's own daemon start refuses with `store_owned`), and once the
previous version is restored and `current` names it, a late start runs that
version. If the stop or the lease fails too, `upgrade()` throws
`upgrade_pending` and `current` still names the candidate. Run `recover()`
(CLI: `byok-agent upgrade recover`) after checking the service manager: it
resolves the receipt from where `current` points, and a present `current`
runs as it is, so read the receipt it returns and call `rollback()` to go
back to the previous version.

## Windows ACL hardening timeouts are hardening errors (#2116)

On Windows, the `icacls` run that hardens a private directory has a 30 s bound
(#1971). A run that outlives it is stopped and now rejects with the public
hardening error instead of an internal, unexported timeout class:
`SecureDirHardeningError` with `code: 'secure_dir_command_timeout'`, from
`ensureSecureDir()` and from every public SDK operation that reports a
directory hardening failure (for example pairing). Other hardening failures
carry `code: 'secure_dir_hardening'`.

**Breaking for a type-narrowing Host.** `SecureDirHardeningError` now has a
`code` field. A Host that narrows `ServiceUnitError | SecureDirHardeningError`
with `'code' in error` and then switches exhaustively over the service codes
fails to compile, and routes the new codes wrongly. Test
`error instanceof SecureDirHardeningError` first, then branch on `code`.

A timeout means the ACL's state is unknown, never that it was not applied.
`exitConfirmed` is set only with `secure_dir_command_timeout`, with the meaning
it has on `ServiceUnitError`: `true`, the stopped `icacls` has exited, so run
the operation again; `false`, it may still be running and still change the ACL,
so a retry now can race it. `cause` is the timeout, for diagnostics only. A
`ServiceInstallation` store lease still reports this timeout as
`ServiceUnitError` `service_command_timeout`, as listed above.

`exportDeviceSupportBundle` does not change: it catches a file hardening
failure and rejects with `DeviceOperatorError` `operation-failed`, without
`exitConfirmed` or the hardening error as `cause`.

## Upgrade resolves when an old snapshot cannot be pruned

After a healthy switch, `upgrade()` removes the snapshots of earlier
switches. A removal that fails there (for example `EBUSY` or `EACCES`) no
longer rejects the upgrade (#1986): it resolves with its `switched` receipt,
and the next successful upgrade tries to remove the leftover again; one that
keeps failing (for example a persistent `EACCES`) stays, and each later
successful upgrade retries it, until the cause is fixed. Rollback still uses only the
snapshot of `current`. Other pruning errors still reject. There is no
cleanup diagnostic hook; a Host that wants to see leftovers lists
`<installRoot>/snapshots/`.

## Upgrade leaves the service stopped after a failed store restore

When `upgrade()` restores its snapshot after a failed migration and that
restore fails too, the stores may be partial (#1987). `upgrade()` no longer
starts the previous version on them: the service stays stopped, the receipt
stays `pending`, `snapshots/<to>` is kept, and the error (an
`AggregateError` carrying the preparation error and the restore error) names
the snapshot path and `recover()`. On this error, call `recover()`.
`current` is absent until then, so a reboot or login starts nothing on the
partial stores, and a failed restore after a failed health check is covered
the same way (#1992); see
[Upgrades commit through current](#upgrades-commit-through-current-2011).

## Store release failures name the next step

A refused first install now removes only a version directory it created,
and keeps one it reused, which holds the version already staged (#1991). When the next
first install cannot stop the service, take the leases, or restore or retire
a repair snapshot, it starts nothing and removes a marked unit; nothing else
changes.

When a lease or gate release fails after a refusal, 0.42.0 threw an
`AggregateError` from a first install. Now (#1991) `install()`, `upgrade()`,
`rollback()` and `recover()` throw the refusal itself when it is a
`ServiceInstallationError`, with its code, and its `cause` is an
`AggregateError` of the refusal and every release failure; a Host that
matched the 0.42.0 `AggregateError` reads `cause` instead. Another error
becomes that `AggregateError` itself. A first install joins a failure to
remove its staged version or its marked unit, or to restart that unit, the
same way. `upgrade()`'s receipt records the refusal's code.

The top-level error code follows the outcome (#1991, #2010). A call that
wrote its final receipt throws its first failure's own class and code; later
release or restart failures join its `cause`, one flat `AggregateError` with
the first failure first. A call that leaves its work unfinished throws
`upgrade_pending`, whose `cause` lists every failure in order: an upgrade,
rollback or recover whose receipt stays `pending` (a failed stop, pointer
write, snapshot restore, release or final receipt write, including an
upgrade refusal whose `failed` receipt could not be written), and an install
whose stores could not be restored and left a repair snapshot (0.42.0 threw
an `AggregateError` there). Call `recover()` next. A lease that failed to
release stays held by its process, so `recover()` in the same process can
fail with `store_busy` in its cause; restart the Host process first. An
upgrade refusal starts the previous version before writing its `failed`
receipt; when that write fails, `recover()` starts it again idempotently and
writes the receipt. A preparation error that is not the
SDK's own (a `precheck` launch that throws, a failed stop) is
the new `ServiceInstallationErrorCode` `store_preparation_failed` with the
original error as its cause: an upgrade records it in a `failed` receipt and
starts the previous version again, where 0.42.0 left the receipt `pending`
and started the previous version anyway. A repair snapshot
(`snapshots/.install-repair-<uuid>`) is now restored first by any operation,
`recover()` included, while no version is current, not only by the next first
install. With no version current, a symlinked `snapshots/` is refused
with `snapshots_symlinked` before anything under it is read, by every
operation; nothing changes. When a failed
install's cleanup restored the stores but could not release their leases,
the error lists `store lease release` as remaining and says the stores were
restored; the install snapshot it names is then an ordinary leftover to
remove before the next install.

## Upgrades commit through current (#2011)

The service unit and launcher run only `<installRoot>/current`, and
`current` is absent whenever the stores may be partial. This resolves the
0.42.0 known issue where `recover()` restored a snapshot over writes of a
service that had already restarted.

- **Before upgrading the SDK:** when `upgrade-receipt.json` is `pending`,
  run `recover()` with SDK 0.42 first. The new SDK refuses a pending
  version 1 receipt with `receipt_upgrade_required`; a final one reads as
  version 2, and the next write stores version 2. `byok-agent upgrade
  status` still exits normally on a pending version 1 receipt: `--json` prints `receipt: null` and the new field
  `receiptError: { code: 'receipt_upgrade_required', message }`, and the
  text output prints `receipt: refused code=receipt_upgrade_required`. The
  file is not read further or changed.
- **Required on macOS:** rewrite the unit before the first upgrade or
  rollback as described in [launchd jobs run with the install's HOME](#launchd-jobs-run-with-the-installs-home-2017).
- **`program` runs from `current`:** `createServiceInstallation` throws
  `service_program_not_current` when neither the command nor an argument
  lies under `<installRoot>/current` (compared by path segment, without case
  on macOS and Windows). `upgrade()` and `rollback()` also require the
  installed unit to be exactly the one the SDK writes; reinstall a unit
  written another way. These are plausibility checks: a program that names
  `current` but runs something else is the Host's contract.
- **`recover()` follows the receipt:** a `pending` receipt journals its
  `kind` (`upgrade`, `rollback` or `repair`). With `current` absent,
  `recover()` restores the snapshot and starts `from`; with `current` at
  `from` or `to` it starts that version as it is and writes the final
  receipt. A pointer state no operation leaves is `receipt_state_inconsistent`
  and nothing changes: inspect `current`, `previous` and the receipt.
- **`switch_unhealthy`:** when `recover()` finds `current` at a candidate
  already found unhealthy, it starts, stops and restores nothing and writes a
  `failed` receipt with `switch_unhealthy`. The Host decides: call
  `rollback()` to discard the candidate's store writes, or keep it.
- **`repair_interrupted`:** a same-version reinstall journals a `repair`
  receipt, stops the service before rewriting the unit, and never replaces
  `current`. A failed one now keeps the payload,
  `current` and the unit and puts the earlier receipt back (0.42.0 removed
  the installation). After an interruption, `recover()`
  writes the earlier receipt back and throws `repair_interrupted`; call
  `install()` again.
- **Start gate:** `byok-agent start` and `createDaemon` refuse with
  `store_owned` while a `pending` receipt has `current` absent. A Host
  process that opens the stores without them checks the receipt itself.
- **Migration:** an upgrade's `migrate` is recorded in the `pending`
  receipt: on POSIX the process group it leads (it runs detached), on
  Windows its pid and start time. Until that group (on Windows, the root)
  ends, nothing restores or starts: `upgrade()` fails with `upgrade_pending`
  when the root exits first, and `recover()` changes nothing. When the record
  cannot be written, the group gets SIGTERM, then SIGKILL, and nothing
  restores until it is proved gone. A pgid reused
  by another group also counts as running; when `recover()` keeps refusing
  with no migration process left, end the group it names or restart the
  machine. A process that leaves the group (`setsid`), and what a Windows
  migration starts, are not tracked: stop them before `recover()`.
- **Links under `snapshots/`:** every operation refuses a symbolic link at
  `snapshots/`, at a snapshot it is about to restore, at its `snapshot.json`
  or at any path segment of a file it lists, with
  `snapshots_symlinked`, before its first side effect (#2061). A link swapped
  in after that check is the Host's responsibility.
- **`store_overlaps_service_state`:** a store your precheck lists must not
  be, hold or lie in the install root or a daemon store's `service/`
  directory (its leases, launcher and records), compared after resolving
  symbolic links and, on macOS and Windows, without case. Such a store is
  refused before anything is snapshotted; list the store's own files or
  directory instead. List normalized absolute paths: a store path with a
  `..` segment (either separator on Windows) is `precheck_failed`, because
  `..` after a link resolves differently from how it is compared.
- **What a precheck refusal does:** it depends on which precheck refuses.
  - An upgrade's first precheck (`store_overlaps_service_state`, the `..`
    refusal, `store_rejected` and the rest): no store is touched and no
    snapshot is taken. The final receipt carries the code, `current` points
    at the previous version again and its service restarts.
  - A first install's precheck: no receipt is written, a version directory
    this call staged is removed, and a marked unit it stopped restarts.
  - The precheck after a migration: the snapshot is already taken. The
    refusal becomes the cause of `store_migration_failed`, the snapshot is
    restored, and an upgrade then returns to the previous version as above.
- **Snapshots SDK 0.42 took are refused (#2106):** a snapshot now records
  each store's resolved path (`snapshot.json` format 2). A snapshot 0.42.0
  took has no such record, so `rollback()`, a `recover()` restore and an
  install repair refuse it with the new code `snapshot_upgrade_required`,
  naming the snapshot directory, before anything changes: the receipt,
  `current`, the snapshot and every store stay as they were. This is the
  same rule as a version 1 pending receipt (`receipt_upgrade_required`).
  With SDK 0.42, finish or abandon that upgrade (`recover()`, or
  `rollback()`), then upgrade with this version. A switched 0.42.0 upgrade
  keeps its snapshot only for a 0.42 `rollback()`; the next upgrade with
  this version replaces it.
- **Restore checks (#2102, #2106):** before a restore changes any store,
  every entry of the snapshot is checked:
  - an entry with a `..` segment is `precheck_failed`, because the file
    system follows a link before `..` and the check would not;
  - an entry that is, holds or lies in the install root or a `service/`
    directory is `store_overlaps_service_state`;
  - two entries that are or lie inside each other, as written or with
    links resolved (a file store under a directory store through a link
    inside it, for example), are `precheck_failed`, naming both paths.
    The precheck refuses such stores too: list the directory store alone,
    or move the inner store out of it;
  - a store path that no longer resolves to the recorded path, for example
    after the candidate's migration repointed a link, is
    `precheck_failed`.

  The restore then writes to the recorded paths, never through the listed
  paths' links again. A refusal throws `upgrade_pending` with it in its
  `cause`; its message names the path. Nothing is restored: from where the
  restore starts, the receipt, `current`, the snapshot and every store stay
  as they were (`rollback()` has already written its pending receipt and
  removed `current`), and `recover()` refuses again. Keep the service
  stopped, restore the links the migration changed, or restore the stores
  by hand from `<installRoot>/snapshots/<version>/` (a directory entry's
  tree is `<index>.d`, a file entry's files are `<index><suffix>`) and
  remove that snapshot directory, then call `recover()`.
- **Daemon stores are listed once by identity (#2161):** `daemonStores()`
  must not list one store under two spellings. A second spelling of a
  `storeDir`, through a symbolic link or in another letter case on a
  case-insensitive volume, is now `daemon_stores_invalid` before any lease is
  taken; before, it waited for its own first lease and failed with
  `store_busy` after `stopTimeoutMs`. De-duplicate the list by each
  `storeDir`'s real path (`fs.realpath`) before returning it.
- **Snapshot removal (#2062):** a snapshot that cannot be removed after the
  final receipt no longer fails the call; it stays.
- On systemd, a start runs `systemctl --user reset-failed` first, since the
  unit may have hit its start limit while `current` was absent.

## Provider key changes roll back on failure (#1946)

`ProviderRegistry.replaceSecret()` and `configure()` restore the previous key when the OS credential write or the profile commit fails, and clear their own pending marker. A profile no longer stays refused as `PROVIDER_CONFIGURATION_PENDING` after a failed key replacement. A Host should handle these codes from both methods:

| Code | Meaning | What the operator does |
| --- | --- | --- |
| `SECRET_VALUE_INVALID` | The key is empty, longer than 2560 UTF-8 bytes, or contains a null or newline character. Nothing was written. | Paste the key again without line breaks. |
| `PROVIDER_SECRET_ROLLBACK_FAILED` | The change failed and the previous key could not be restored. The profile stays pending and is refused until a key change succeeds. | Supply the key again. |
| `KEYCHAIN_SECRET_DECODE_FAILED` | The macOS Keychain or Linux Secret Service entry with this provider key's name was not written by the SDK. No SDK release wrote such an entry. It is left untouched and nothing was written. | Delete or rename that entry in Keychain Access or the keyring, or configure another profile. |
| `KEYCHAIN_UNAVAILABLE` | The OS keychain cannot be used. | On Linux, install `secret-tool` and unlock a keyring on the session D-Bus. |
| `PROVIDER_SECRET_STORE_FAILED` | The credential store failed with an error the SDK does not pass on. | Check the credential store and retry. |

A corrupted SDK entry (new code `KEYCHAIN_SECRET_CORRUPTED` on macOS and Linux, previously reported as `KEYCHAIN_SECRET_DECODE_FAILED`) is repaired by supplying a new key. A Host that matched `KEYCHAIN_SECRET_DECODE_FAILED` to offer "enter the key again" should offer it for `KEYCHAIN_SECRET_CORRUPTED` and show the delete, rename or other-profile guidance for `KEYCHAIN_SECRET_DECODE_FAILED`.

Known limitation on Windows: Credential Manager reports a damaged entry as `CREDENTIAL_MANAGER_READ_FAILED`, the same code as other read failures. `replaceSecret()` cannot tell the two apart, so it refuses instead of overwriting the entry. To recover, delete the entry in Credential Manager (Windows Credentials, the generic credential `<servicePrefix>.model-<profile_ref>-api-key`, by default `com.byok.keys.model-<profile_ref>-api-key`), then configure the key again.

Credential-store errors from every `ProviderRegistry` method (`get()`, `list()`, `configure()`, `replaceSecret()`, `delete()`, `setDefaultModelProvider()` and `resolveDefaultModelProvider()`, #2029) keep a keychain, Credential Manager or secret-shape code with a fixed SDK message and no cause. Any other store error becomes `PROVIDER_SECRET_STORE_FAILED`, because an injected store may put a key in its own error. Match on `error.code`, not on the message text. `applySealedProviderProvisioning()`, `DeviceSealingKeyStore` and `runPiProviderLauncher()` use the same boundary (#2051, #2096): sealed provisioning, which used to report every store error as `PROVIDER_SECRET_STORE_FAILED`, now keeps those codes too, so handle them wherever you handle `PROVIDER_SECRET_STORE_FAILED`. The launcher now maps other injected-store errors to `PROVIDER_SECRET_STORE_FAILED`. `EnvelopeScopedSecretStore` applies the same boundary to every call on the store it wraps, including `available()`, as do the `available()` checks in sealed provisioning and the launcher (#2096): a Host that calls the decorator directly now gets the fixed message and no cause, and a code outside those families becomes `PROVIDER_SECRET_STORE_FAILED`; before, the wrapped store's error passed through unchanged. A launcher spawn failure now has the fixed message `spawn failed: <code>` (or `spawn failed: unknown` if the code is absent) and retains only `code`, rather than Node's path, spawn arguments and other error properties. `configure()`, `replaceSecret()`, `setDefaultModelProvider()` and `delete()` never read the stores after their commit (#2023). The status they return is the state the call committed, which may be stale once the call returns. A call that resolves has committed its change. A call that rejects with the new `PROVIDER_CHANGE_COMMITTED` has also committed it, but a later step failed: either deleting the previous key after `configure()` switched a profile to `auth_mode: 'none'`, in which case that key stays in the credential store until a later `configure()` or `delete()` removes it, a profile store that wrote the change but could not confirm it, or releasing the configuration lock. Its `cause` carries only the failed step's code, never the step's own message. Treat that code as success, read the status again with `get()`, and, for the `auth_mode: 'none'` case, retry the `configure()` to remove the leftover key. A rejection with any other code committed nothing. `configure()` without a secret now reuses the stored key only when the committed profile already authenticates against the same `base_url`; switching a profile from `auth_mode: 'none'` back to authentication, or changing its `base_url`, rejects with `PROVIDER_SECRET_MISSING` until the Host supplies the key again.


## Sealed provisioning retries an unavailable credential store (#2132)

**Breaking (behavior only).** `applySealedProviderProvisioning()` no longer records a rejection when the device's credential store reports `available()` as `false` before any write. The result is still `rejected` with `secret_store_unavailable`, but the device keeps no receipt for it and does not consume its `operationGeneration`. Before, the rejection was recorded and the generation consumed, so the same request stayed rejected after the store recovered (for example after a keyring was unlocked) and a new request needed a higher generation.

What a Host does:

- Change the device's `providerProvisioning` notice handler before it completes a result. Both cases return `rejected` with `secret_store_unavailable`, so on that code call `readSealedProvisioningResult({ profileStore, requestId, requestDigest })`:
  - `absent`: nothing was recorded. Do not complete to the Host and throw from the handler. The notice stays unacknowledged, the Host keeps the request and its ciphertext, and the redelivered notice applies the same request once the operator fixes the credential store. The retry still passes the time window, identity, expected profile and generation watermark checks; once the window closes it returns `request_expired`, which completes as usual.
  - `completed`: the device has a recorded result for this request. Complete `readback.result` to the Host, not the rejection the call returned. It is the recorded `secret_store_unavailable` when the failure came from a credential write (the operation stays pending, only a new key submission resolves it, and sending that request again returns the same rejection), or `applied` when another local call applied the same request after this one saw the store unavailable.
  - `conflict` or `interrupted`: another local request holds this `requestId` with a different digest, or a local call reserved this request after this one and has not recorded a result. Call `applySealedProviderProvisioning()` again with the same request and complete what it returns: `request_conflict` for a conflict; for a reservation it takes the configuration lock (which a store may refuse while the other call holds it) and returns the other call's recorded result, or records `local_commit_interrupted` if that call never finished. If it throws, throw from the handler; the notice stays unacknowledged and is redelivered.
- A handler that keeps completing every result makes the Host store the unrecorded rejection as terminal and acknowledge the notice. Replaying that request later applies on the device but the Host reports `conflict` and keeps the rejection; submit a new request at the same generation instead. The [keys README handler order](../../packages/keys/README.md#sealed-remote-provisioning) shows the updated steps. No type, code or API changes.

## Stored cancellation pruning cutoff

Custom implementations of `LocalTaskJournal` must accept the new `cutoff` argument of `pruneConfirmedJournalTask(taskId, cutoff)` (#1990). Inside its delete transaction, under the write lock, it returns `false` and deletes nothing when the task is valid but not prunable: a confirmed terminal last updated at or after `cutoff`, or a received offer whose first stored `task.cancel` sequenced above the offer was committed at or after `cutoff` (including evidence replaced under the same task id) or that has no such cancellation. For a received offer it throws and deletes nothing when the `task.cancel` that qualifies it is broken: that cancellation fails its hash or enrollment check, names another task id, or carries a `seq` different from its row's. No other row is part of this contract: a confirmed terminal's envelopes, withheld rows and the task's other envelopes may be deleted without verification (#2054). An implementation that ignores `cutoff` still compiles but can delete unexpired or replaced evidence; the SDK does not repeat these checks. Hosts using the SDK SQLite journal need no change.

## Enrollment clear is scoped to its store (#1964)

`clearDeviceEnrollment` and `Daemon.unpair()` no longer delete another store's credential or staged first pairing under the same `productId`. A Host that switches on `DeviceEnrollmentClearError.code` handles the new code `pairing_attempt_unattributed`: the OS entry holds a first-pairing attempt staged by 0.42.0, which names no store, and nothing was cleared. When no other store of this `productId` is pairing, call `clearDeviceEnrollment({ productId, storeDir, clearUnattributedAttempt: true })` once the daemon has exited. `store_not_bound` now also covers a first-pairing attempt another store staged. A first-pairing attempt now carries `storeIdentity`; an injected `DeviceCredentialBackend` must store and return every attempt field, or a clear refuses the store's own attempt as `pairing_attempt_unattributed`. Pairing applies the same rule (#2033): it reuses only its own store's staged attempt and otherwise throws the new `FirstPairingAttemptRefusedError`, with `store_not_bound` (another store's attempt; pair with `replaceOtherStore` to discard it) or `pairing_attempt_unattributed` (clear it as above, then pair again). A clear or pairing that waits more than 30 seconds for another store's clear or pairing of the same `productId` fails; the clear deletes nothing.

## Renewal checks the enrollment binding (#2034)

A running daemon renews its token only while the OS entry still holds this store's enrollment. When another store of the same `productId` paired over it, the renewal writes nothing and the daemon halts with `store_not_bound`; when another store cleared it, the daemon halts with `re_pair_required`. Both reasons were start-time halts before; a Host that handles `DaemonHaltError.reason` or the daemon's halted lifecycle at start handles them the same way when the daemon is running: pair the store again. A renewal that waits more than 30 seconds for another store's clear or pairing fails as busy and is retried; it is not reported as revocation. A running daemon's E2EE member writes (member resume, KEM rotation) follow the same rule (#2055): when another store has paired over or cleared the enrollment, they write nothing and the daemon halts with the same reasons.

Pairing is one critical section of the same lock. It rereads the OS entry, `device.json` and any staged attempt under the lock, so a re-pair of a store that is already paired, or of a daemon that cached its record, now throws `DeviceStoreBindingMismatchError` when another store paired over it since (pair with `replaceOtherStore` to replace it), and `FirstPairingAttemptRefusedError` when another store's or an unattributed staged attempt sits beside its enrollment. The lock is held through the pairing's E2EE member entries and, when the daemon was running, its shutdown, so another store waits for them too. Only the network request has a deadline; each OS credential command has its own 15 s deadline, and a waiter gives up as busy after 30 seconds.

## Retained records elide past the limit (#1932)

`maxRetainedBytes` (default 16 MiB) bounds only native and tool payloads. Past it the oldest are elided in place and the task keeps running. The limit also covers the native payload of a runtime request and its reply. Text and reasoning have their own 16 MiB limit, past which the oldest frames lose their text the same way; the newest frame stays whole (#2056). `ClaudeAdapterOptions` gains `maxRetainedBytes` with the same validation and default.

For Claude this is the existing behavior (since #1892). For Codex, Grok, Antigravity, OpenCode and dsh it changes: their text used to count toward the 16 MiB total and passing it failed the task with `<runtime> retained record byte budget exceeded`. That failure no longer occurs.

- A Host that matched the failure message drops that match; it no longer occurs.
- A Host that passes no `maxRetainedBytes` needs no change.

## Host layout import moves to a subpath

**Breaking (#1925).** Import `resolveHostLayout`, `HostLayoutInputError`, `HostLayout`, `HostLayoutOptions` and `HostLayoutPlatform` from `@byok-sdk/client/host-layout`. They leave the client root; each symbol has one public import path. This pure entry lets an installer or Electron main process compute directories without loading the client daemon, Pi or provider SDKs. The returned paths and error codes are unchanged, and existing stores stay in place.

Apply this import codemod (including type-only imports); split a mixed root import so its other symbols still come from `@byok-sdk/client`:

```diff
-import { resolveHostLayout, HostLayoutInputError, type HostLayout, type HostLayoutOptions, type HostLayoutPlatform } from '@byok-sdk/client';
+import { resolveHostLayout, HostLayoutInputError, type HostLayout, type HostLayoutOptions, type HostLayoutPlatform } from '@byok-sdk/client/host-layout';
```

## launchd jobs run with the install's HOME (#2017)

The plist an `install()` writes on macOS now sets `EnvironmentVariables.HOME` to the home the lifecycle resolved (`os.homedir()` of the installing process), which is the directory it placed the plist and its paths under. launchd previously started the job with the account's home. The public `generateLaunchdPlist()` writes no `HOME`, as before.

The SDK pins `HOME` with one rule in two places:

- **Daemon HOME.** Under `--service` the daemon keeps the plist's `HOME` (and its own `BYOK_*`) after applying the login-shell snapshot, even when a shell startup file resets `HOME`. Paths the daemon resolves from its own `HOME` stay under the installed home.
- **Task HOME (breaking, #2084).** With the default `base: 'login-shell'`, task children now get the daemon's own live `HOME`, no longer the `HOME` in the startup snapshot. On a device whose startup file exports another `HOME`, tasks see a different `HOME` than before. A policy that lists `HOME` in `pass`, and a `base: 'allowlist'` policy, already took the live `HOME` and are unchanged.

Only `HOME` is pinned. `PATH`, `XDG_*` and other values a startup file derived from its own `HOME` stay as the snapshot has them, so they can point at another home than the task's `HOME`. A Host that needs them to agree passes them too (`runtimeEnvironment: { pass: ['HOME', 'XDG_*', ...] }`, or the per-runtime `runtimes.<id>.runtimeEnvironment`), or uses `base: 'allowlist'` and supplies them itself. A Host that passed `HOME` only to isolate tasks under a scratch install can drop it.

**Required step on macOS:** a plist written by an earlier SDK no longer matches the generated unit and inspects as `repairable`. Before the first `upgrade()` or `rollback()` on each macOS device, call `install()` again on the same installation (same service name and install root) with the payload that is installed now, to rewrite the unit, then upgrade. The reinstall must use the current payload id: `install()` with any other payload is refused with `installation_exists`. Read the id with `installation.currentVersion()` and keep the payload directory whose `readPayloadManifest(dir).id` equals it until this reinstall has run. No other platform is affected.

## When whenTaskSettled reports an unknown task (#2067)

No API change. `whenTaskSettled(taskId)` rejects with `DaemonTaskUnknownError` when an earlier journal read returned no row for the task and, once that read finished, this `Daemon` instance had no in-memory record for it (no held runtime, nothing settled or awaited for it in this run) and no offer for it marked as seen. The wait makes those checks in the same step that ends the read, and an offer whose append is journaled while the read is in flight makes it read again instead of reporting unknown ([#2097](https://github.com/Ancienttwo/byok-sdk/issues/2097)). The mark also ends when the offer's append is refused, so a refused offer with no row reads as unknown too. A task whose rows retention pruned (confirmed-journal TTL, default 30 days), a task never journaled on this device and an offer the server sent that has not reached this daemon yet look the same, and the error carries no reason.

Unknown does not prove the task is over or will never start: an offer may still be on its way and start a runtime later. Do not delete a Host attach record on this error alone. Keep the record, or settle it from your own server's terminal state and delivery guarantees.

Every other rejection has its own source, and none of them is `DaemonTaskUnknownError`:

- **Abort:** a `signal` already aborted at the call rejects with `signal.reason`, and so does a later abort while the wait is pending. This includes an abort while the journal read is pending ([#2097](https://github.com/Ancienttwo/byok-sdk/issues/2097)): the read keeps running, but the wait rejects at once. A read that fails before the abort rejects with the journal's error. The task is untouched.
- **Not started:** a call before `start()` rejects as `approve()` does.
- **Journal read failure:** the journal's own error, for example a closed or corrupt journal, or a Host-injected journal row the SDK refuses as malformed.
- **Stored evidence fails an SDK check:** an SDK `Error` when a stored cancellation fails its enrollment identity, hash or task binding check, or a task row carries an unknown terminal state.
- **Offer append refused:** the waiters of an offer whose journal append failed reject with that append's error (for example `LocalStorageEmergencyError`). A redelivery starts a new wait.

The last three are faults.

## Spawn input and start errors (#2151)

`@byok-sdk/core/system-tool` provides `assertNoNulSpawnInput` and
`spawnStartError` (#2111). A Host that starts its own child processes can now
pass the same cwd it gives to spawn as the optional fourth argument:
`assertNoNulSpawnInput(command, args, env, cwd)`. The three-argument call
checks command, args and env only. A NUL-bearing cwd is refused before spawn
with `spawn cwd contains a NUL byte`; the directory itself is not included.
SDK client transports and the Pi custody launcher already pass their cwd.

Synchronous failures from the owned line, owned terminal and Pi RPC spawns
now have the same `spawn failed: <code>` message and optional `code` as their
asynchronous spawn failures, without the original message, path, arguments
or cause. MCP keeps its `MCP server failed to spawn: <code>` wrapper for
synchronous failures. A Host that inspected raw Node spawn errors should
use `error.code` for the owned transports and Pi RPC; MCP still reports a
transport error. Correct invalid cwd input before retrying a NUL rejection.

`spawnStartError` accepts only string codes; absent or non-string values
produce `spawn failed: unknown` and `code: undefined`. Host test doubles
that represent OS errors should use string codes. The helper is intended
for ordinary Node spawn errors: it copies string codes verbatim and does
not sanitize arbitrary objects or protect against throwing code getters.

## Retention failures name the journal task (#2145)

A Host needs a change only if it matches journal integrity error messages or parses `byok-agent` diagnostics text, as described below. A `retention-failure` DaemonEvent, and the matching `audit.jsonl` record, gains `taskId?: string`. It is set only for the `confirmed-journal` class when a task's stored journal rows fail the integrity check that refuses pruning; `code` stays `sweep_failed`, and the daemon emits one event, `count: 1`, per such task in the pass. Any other retention failure carries no `taskId`, and so does every failure of a Host-supplied `LocalTaskJournal`: only the SDK's `SqliteLocalTaskJournal` sets it. The integrity errors it raises, including those `whenTaskSettled` rejects with, now have the fixed message `journal integrity check failed (task "<id>")`; the original error, such as `durable cancellation candidate bytes/hash mismatch`, is in `cause`. A Host that matched the old message text should match `error.cause.message` instead. In `byok-agent` diagnostics text (`tasks`, `tasks --follow`, `status`, `approvals`), every task id is now a JSON-quoted string: `taskId="t1"` on event, approval and live-status lines, and `"t1" Running ...` at the start of a task line. The protocol does not constrain task id characters, so an unquoted id could carry a newline or terminal escape into the one-line output. A script that parses these lines must decode the whole quoted value as a JSON string, for example `JSON.parse` on the text from the opening to the closing quote; stripping the quotes leaves escapes such as `\n` or `\u001b` undecoded. The audit log and the control socket's JSON are unchanged. The event names the task only, never its stored bytes. An operator can use the task ID to inspect or export that task's journal rows before resolving it. A Host that rebuilds `retention-failure` objects field by field, or validates them against a closed schema, should keep `taskId`. A Host that calls `DaemonObserver.noteRetentionFailure` directly may pass it as the new optional fourth argument.
