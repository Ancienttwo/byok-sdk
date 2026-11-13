# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Ledger precheck and store ID (#1981)

The local bot-collaboration entry exports `inspectLedger(path, tenant)`, a precheck that reads a private copy of the stopped L ledger. If it reports `migration-required`, run `migrateWouldDo` after taking a snapshot and before serving. `LocalStoreId` adds `bot-collaboration-ledger`: update exhaustive switches and `Record<LocalStoreId, ...>` mappings to include the new member.

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
