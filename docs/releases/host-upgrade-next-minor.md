# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Committed cancellation with a pending wake (#2004)

`HostExecutionCore.cancel()` now returns an object instead of `void`. Update callers and test doubles that require `Promise<void>` to accept its result. `BotCollaboration.cancelTurn()` and `abortSwitch()` keep their existing result fields. When only wake dispatch fails after one of these operations commits, it resolves with `wakePending: true` instead of rejecting. The failure can concern any wake in that drain, including one unrelated to the operation, and a concurrent retry may succeed before the result returns. Do not repeat the committed operation solely because the flag is present.

To inspect outstanding work, read `HostLedger.snapshot().outbox` on the ledger used by the core or Bot. Failed rows have `kind: 'schedule'` or `kind: 'cancel-wake'` and `lastError`; the core retries each row on a timer up to 10 times, with backoff capped at 60 seconds. After that, the row waits for another drain to retry it. Track the row's outbox key and wake key: a successful SDK schedule or cancel removes that unchanged row. A row can also be superseded by later work, so its disappearance alone does not prove that the wake fired. For a scheduled wake, `server.wakes.pending()` reports SDK-queued wakes; acceptance into that queue is not completion of the wake hook. An explicit `HostExecutionCore.drain()` or `BotCollaboration.drain()` that resolves confirms its drain did not report a dispatch failure; drains and wake hooks still reject `WakeDispatchError` when their only failures are wake calls.

Other errors can still reject after commit. In particular, a drain that also encounters a Host job failure or `OutboxFullError` may reject after the cancellation or abort was committed; this remaining ambiguity is tracked in [#2072](https://github.com/Ancienttwo/byok-sdk/issues/2072).

## OpenCode qualified version 2.3.0 (#1972)

The OpenCode adapter's default policy qualifies 2.3.0. A device still running 2.2.6 reports the `runtime_version_unqualified` advisory with `qualifiedVersion: '2.3.0'` through detect; hello and presence report `state: 'warn'` with the same qualified version. The default policy remains `warn`, so tasks can still run. Upgrade the device's OpenCode to 2.3.0 to clear the advisory, or keep 2.2.6 and show the advisory while planning the upgrade. A Host that supplies its own OpenCode `versionPolicy` keeps that policy; review it separately before changing versions. See the [qualification evidence](../researches/2026-11-13-opencode-2.3.0-qualification.md).

## Cancel selected Host intents without a pass (#2003)

`BotCollaboration.cancelHostIntents(keys)` atomically cancels a chosen set of unsubmitted Host intents without draining. It returns settled conclusions on replay and refuses the whole set when any key is unknown, a Bot Turn or in flight. `HostIntentError.rejected` lists every refused key and code; exhaustive switches over `HostIntentError.code` add `inflight`. Existing single cancellation and switch APIs retain their other behavior, and the store format is unchanged; see the wake-dispatch change above. A Host may replace freeze → individual cancels → abort with this call; keep the freeze when other work on the device must also be held. Successors start on the next pass, or call `drain()` to start them.

## Ledger precheck and store ID (#1981)

The local bot-collaboration entry exports `inspectLedger(path, tenant)`, a precheck that reads a private copy of the stopped L ledger. If it reports `migration-required`, run `migrateWouldDo` after taking a snapshot and before serving. A valid exported ledger is accepted; if its switch is aborted, run the precheck again before serving. `LocalStoreId` adds `bot-collaboration-ledger`: update exhaustive switches and `Record<LocalStoreId, ...>` mappings to include the new member.

## cloud-do archived

`@byok-sdk/cloud-do` leaves the release train. Remove the dependency, or pin it to exactly 0.42.0 if the Host still needs it. No later version or fixes will be published, and its npm versions will be deprecated. The upgrade train check no longer inspects this package, even if it remains installed.

Restart requires a product that needs a cloud agent using platform keys with Pi’s durable harness in Cloudflare Durable Objects. Start from `archive/cloud-do` (the last main commit with the package; it differs from the last published version `v0.42.0` only in its README), qualify it again against the Pi version current at the time, and obtain the replay-safe tool list, provider profiles and binding names from the Host. See [ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md).

## Pi cache warming stops at settlement (#1949)

No configuration change is needed. Every SDK Pi RPC session now caps its settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings, instead of answering each idle `cache_warming_decision` with `stop`. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file.

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
gate and the owner check use the effective uid. These guarantees hold only
while the install root's parent directory is writable by the installing user
alone: another user who can write it can rename the root or replace it with a
symlink after the check (#2028). Windows has no owner check, and two Windows
users operating on one install root are not guaranteed to exclude each other.

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
now starts after start returns, as on install; platform commands still have
no time bound (#1971). A Host whose check is slower than `healthTimeoutMs`
raises it. `healthTimeoutMs` must now be an integer from 1 to 2147483647
(2^31-1): any other value makes `createServiceInstallation()` throw a
`TypeError`, the error it already throws for `daemonStores` without
`healthCheck`. Before,
0 or less still ran the check once, and a larger value made the timer fire
at once.

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
the snapshot path and `recover()`. On this error, call `recover()` as soon as
possible and do not restart the machine first: the unit stays installed, so a
reboot or login before `recover()` starts the previous version on the partial
stores. This covers the restore after a failed preparation only; a failed
restore after a failed health check still throws the underlying error, which
need not name the snapshot, and is left to #1992.

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
fail with `store_busy` in its cause; restart the Host process first. When an
upgrade refusal's `failed` receipt cannot be written, the previous version
stays stopped until `recover()`, which would otherwise restore the snapshot
over what the restarted service wrote. A preparation error that is not the
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

Credential-store errors from every `ProviderRegistry` method (`get()`, `list()`, `configure()`, `replaceSecret()`, `delete()`, `setDefaultModelProvider()` and `resolveDefaultModelProvider()`, #2029) keep a keychain, Credential Manager or secret-shape code with a fixed SDK message and no cause. Any other store error becomes `PROVIDER_SECRET_STORE_FAILED`, because an injected store may put a key in its own error. Match on `error.code`, not on the message text. `configure()`, `replaceSecret()`, `setDefaultModelProvider()` and `delete()` never read the stores after their commit (#2023). The status they return is the state the call committed, which may be stale once the call returns. A call that resolves has committed its change. A call that rejects with the new `PROVIDER_CHANGE_COMMITTED` has also committed it, but a later step failed: either deleting the previous key after `configure()` switched a profile to `auth_mode: 'none'`, in which case that key stays in the credential store until a later `configure()` or `delete()` removes it, a profile store that wrote the change but could not confirm it, or releasing the configuration lock. Its `cause` carries only the failed step's code, never the step's own message. Treat that code as success, read the status again with `get()`, and, for the `auth_mode: 'none'` case, retry the `configure()` to remove the leftover key. A rejection with any other code committed nothing. `configure()` without a secret now reuses the stored key only when the committed profile already authenticates against the same `base_url`; switching a profile from `auth_mode: 'none'` back to authentication, or changing its `base_url`, rejects with `PROVIDER_SECRET_MISSING` until the Host supplies the key again.

## Stored cancellation pruning cutoff

Custom implementations of `LocalTaskJournal` must accept the new `cutoff` argument of `pruneConfirmedJournalTask(taskId, cutoff)` (#1990). Inside its delete transaction, under the write lock, it returns `false` and deletes nothing when the task is valid but not prunable: a confirmed terminal last updated at or after `cutoff`, or a received offer whose first stored `task.cancel` sequenced above the offer was committed at or after `cutoff` (including evidence replaced under the same task id) or that has no such cancellation. For a received offer it throws and deletes nothing when the `task.cancel` that qualifies it is broken: that cancellation fails its hash or enrollment check, names another task id, or carries a `seq` different from its row's. No other row is part of this contract: a confirmed terminal's envelopes, withheld rows and the task's other envelopes may be deleted without verification (#2054). An implementation that ignores `cutoff` still compiles but can delete unexpired or replaced evidence; the SDK does not repeat these checks. Hosts using the SDK SQLite journal need no change.

## Enrollment clear is scoped to its store (#1964)

`clearDeviceEnrollment` and `Daemon.unpair()` no longer delete another store's credential or staged first pairing under the same `productId`. A Host that switches on `DeviceEnrollmentClearError.code` handles the new code `pairing_attempt_unattributed`: the OS entry holds a first-pairing attempt staged by 0.42.0, which names no store, and nothing was cleared. When no other store of this `productId` is pairing, call `clearDeviceEnrollment({ productId, storeDir, clearUnattributedAttempt: true })` once the daemon has exited. `store_not_bound` now also covers a first-pairing attempt another store staged. A first-pairing attempt now carries `storeIdentity`; an injected `DeviceCredentialBackend` must store and return every attempt field, or a clear refuses the store's own attempt as `pairing_attempt_unattributed`. Pairing applies the same rule (#2033): it reuses only its own store's staged attempt and otherwise throws the new `FirstPairingAttemptRefusedError`, with `store_not_bound` (another store's attempt; pair with `replaceOtherStore` to discard it) or `pairing_attempt_unattributed` (clear it as above, then pair again). A clear or pairing that waits more than 30 seconds for another store's clear or pairing of the same `productId` fails; the clear deletes nothing.

## Renewal checks the enrollment binding (#2034)

A running daemon renews its token only while the OS entry still holds this store's enrollment. When another store of the same `productId` paired over it, the renewal writes nothing and the daemon halts with `store_not_bound`; when another store cleared it, the daemon halts with `re_pair_required`. Both reasons were start-time halts before; a Host that handles `DaemonHaltError.reason` or the daemon's halted lifecycle at start handles them the same way when the daemon is running: pair the store again. A renewal that waits more than 30 seconds for another store's clear or pairing fails as busy and is retried; it is not reported as revocation.

Pairing is one critical section of the same lock. It rereads the OS entry, `device.json` and any staged attempt under the lock, so a re-pair of a store that is already paired, or of a daemon that cached its record, now throws `DeviceStoreBindingMismatchError` when another store paired over it since (pair with `replaceOtherStore` to replace it), and `FirstPairingAttemptRefusedError` when another store's or an unattributed staged attempt sits beside its enrollment. The lock is held through the pairing's E2EE member entries and, when the daemon was running, its shutdown, so another store waits for them too. Only the network request has a deadline; each OS credential command has its own 15 s deadline, and a waiter gives up as busy after 30 seconds.

## Retained records elide past the limit (#1932)

`maxRetainedBytes` (default 16 MiB) bounds only native and tool payloads. Past it the oldest are elided in place and the task keeps running. The limit also covers the native payload of a runtime request and its reply. Text and reasoning are kept whole, because the folds read them, so `maxRetainedBytes` is not a bound on total retained bytes (#2056). `ClaudeAdapterOptions` gains `maxRetainedBytes` with the same validation and default.

For Claude this is the existing behavior (since #1892). For Codex, Grok, Antigravity, OpenCode and dsh it changes: their text used to count toward the 16 MiB total and passing it failed the task with `<runtime> retained record byte budget exceeded`. That failure no longer occurs, and their text now has no byte bound.

- A task's text grows with the provider's per-turn output limit times the number of turns. A Host that needs a hard bound sets `maxDurationMs`: the offer's `limits.maxDurationMs`, or `DaemonConfig.defaultMaxDurationMs`.
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

Two HOME values matter, and the SDK pins only the first:

- **Daemon HOME.** Under `--service` the daemon keeps the plist's `HOME` (and its own `BYOK_*`) after applying the login-shell snapshot, even when a shell startup file resets `HOME`. Paths the daemon resolves from its own `HOME` stay under the installed home.
- **Task HOME.** Runtime children get the environment the runtime environment policy builds. With the default `base: 'login-shell'`, that is the startup snapshot, so a startup file that exports `HOME` (or derives `PATH`, `XDG_*` and other values from the real home) still sets them for tasks. Follow-up: #2084.

A Host that installs under a scratch `HOME` to isolate a test install must also isolate tasks: put `HOME` in the policy's `pass` (`runtimeEnvironment: { pass: ['HOME', ...] }`, or the per-runtime `runtimes.<id>.runtimeEnvironment`) so tasks get the daemon's live `HOME`, or use `base: 'allowlist'` and supply `PATH`, `XDG_*` and other derived values itself. Do not rely on the startup snapshot for isolation.

**Required step on macOS:** a plist written by an earlier SDK no longer matches the generated unit and inspects as `repairable`. Before the first `upgrade()` or `rollback()` on each macOS device, call `install()` again on the same installation (same service name and install root) with the payload that is installed now, to rewrite the unit, then upgrade. The reinstall must use the current payload id: `install()` with any other payload is refused with `installation_exists`. Read the id with `installation.currentVersion()` and keep the payload directory whose `readPayloadManifest(dir).id` equals it until this reinstall has run. No other platform is affected.

## When whenTaskSettled reports an unknown task (#2067)

No code change. `whenTaskSettled(taskId)` rejects with `DaemonTaskUnknownError` when an earlier journal read returned no row for the task and, once that read finished, this `Daemon` instance had no in-memory record for it (no held runtime, nothing settled or awaited for it in this run) and no offer for it marked as seen. The read and those checks are not atomic. An offer appended while the read was pending ends the mark, so the wait can report unknown although the row now exists ([#2097](https://github.com/Ancienttwo/byok-sdk/issues/2097)). The mark also ends when the offer's append is refused, so a refused offer with no row reads as unknown too. A task whose rows retention pruned (confirmed-journal TTL, default 30 days), a task never journaled on this device and an offer the server sent that has not reached this daemon yet look the same, and the error carries no reason.

Unknown does not prove the task is over or will never start: an offer may still be on its way and start a runtime later. Do not delete a Host attach record on this error alone. Keep the record, or settle it from your own server's terminal state and delivery guarantees.

Every other rejection has its own source, and none of them is `DaemonTaskUnknownError`:

- **Abort:** a `signal` already aborted at the call rejects with `signal.reason`, and so does an abort after the journal read succeeded, while the wait is registered. The task is untouched. The wait does not listen during the journal read: a pending read delays the abort, and a failed read rejects with the journal's error instead ([#2097](https://github.com/Ancienttwo/byok-sdk/issues/2097)).
- **Not started:** a call before `start()` rejects as `approve()` does.
- **Journal read failure:** the journal's own error, for example a closed or corrupt journal, or a Host-injected journal row the SDK refuses as malformed.
- **Stored evidence fails an SDK check:** an SDK `Error` when a stored cancellation fails its enrollment identity, hash or task binding check, or a task row carries an unknown terminal state.
- **Offer append refused:** the waiters of an offer whose journal append failed reject with that append's error (for example `LocalStorageEmergencyError`). A redelivery starts a new wait.

The last three are faults.
