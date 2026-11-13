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

Credential-store errors from every `ProviderRegistry` method (`get()`, `list()`, `configure()`, `replaceSecret()`, `delete()`, `setDefaultModelProvider()` and `resolveDefaultModelProvider()`, #2029) keep a keychain, Credential Manager or secret-shape code with a fixed SDK message and no cause. Any other store error becomes `PROVIDER_SECRET_STORE_FAILED`, because an injected store may put a key in its own error. Match on `error.code`, not on the message text. `applySealedProviderProvisioning()` and `DeviceSealingKeyStore` use the same boundary (#2051): sealed provisioning, which used to report every store error as `PROVIDER_SECRET_STORE_FAILED`, now keeps those codes too, so handle them wherever you handle `PROVIDER_SECRET_STORE_FAILED`. `configure()`, `replaceSecret()`, `setDefaultModelProvider()` and `delete()` never read the stores after their commit (#2023). The status they return is the state the call committed, which may be stale once the call returns. A call that resolves has committed its change. A call that rejects with the new `PROVIDER_CHANGE_COMMITTED` has also committed it, but a later step failed: either deleting the previous key after `configure()` switched a profile to `auth_mode: 'none'`, in which case that key stays in the credential store until a later `configure()` or `delete()` removes it, a profile store that wrote the change but could not confirm it, or releasing the configuration lock. Its `cause` carries only the failed step's code, never the step's own message. Treat that code as success, read the status again with `get()`, and, for the `auth_mode: 'none'` case, retry the `configure()` to remove the leftover key. A rejection with any other code committed nothing. `configure()` without a secret now reuses the stored key only when the committed profile already authenticates against the same `base_url`; switching a profile from `auth_mode: 'none'` back to authentication, or changing its `base_url`, rejects with `PROVIDER_SECRET_MISSING` until the Host supplies the key again.
