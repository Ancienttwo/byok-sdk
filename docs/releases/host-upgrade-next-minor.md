# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Pi cache warming stops at settlement (#1949)

No configuration change is needed. Every SDK Pi RPC session now caps its settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings, instead of answering each idle `cache_warming_decision` with `stop`. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file.

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
