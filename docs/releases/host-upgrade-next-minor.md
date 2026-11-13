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
and keeps one it reused, since another installation may be using it; after
`installation_exists` every version directory stays until the next
successful upgrade's prune or `uninstall()` removes it (#1991). When the next
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
