# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

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
restored version is `rollback_unhealthy`, as for any failed check. The clock
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

The top-level error code now names the Host's next step, which follows where
the receipt stops (#1991). On every exit where a store gate or lease fails to
release and the receipt stays `pending` (an upgrade refusal whose `failed`
receipt could not be written, a refusal that is not a
`ServiceInstallationError`, a failed pointer write or snapshot restore, the
release after the pointer writes in `upgrade()`, `rollback()` or
`recover()`, an upgrade's rollback after a failed health check), the error is
the new `ServiceInstallationErrorCode` `store_release_failed`. Its `cause` is
one flat `AggregateError`: the failure that came first (`health_check_failed`
after a failed health check, a preparation error, `store_busy`), every
release failure, then a failed receipt write or restart. Call `recover()`
next. A lease that failed to release stays held by its process, so
`recover()` in the same process can report `store_busy`; restart the Host
process first. An install whose lease is stuck reports `store_busy` from its
cleanup in the same way; restart the Host process before the next install.
A refusal whose final receipt was written keeps its code, and a release or
restart failure after it joins its `cause`. When an upgrade refusal's `failed`
receipt cannot be written, the receipt stays `pending` and the previous
version stays stopped until `recover()`, which would otherwise restore the
snapshot over what the restarted service wrote. A release failure after a final
receipt would not turn a committed result into a rejection, the rule #1996
applies to pruning; no path releases there today. When a failed
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

Credential-store errors from these methods keep their code but carry a fixed SDK message and no cause, because an injected store may put a key in its own error. Match on `error.code`, not on the message text.
