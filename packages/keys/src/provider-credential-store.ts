import { isCredentialNamespaceId } from './credential-namespace.js';
import { ByokKeysError } from './errors.js';
import type { SecretStore } from './secret-store.js';
import { sanitizeSecretStoreError } from './secret-store-call.js';

export function bindProviderCredentialStore<TName extends string>(base: SecretStore<TName>, namespaceId: string): SecretStore<TName> {
  if (!isCredentialNamespaceId(namespaceId)) {
    throw new ByokKeysError('SECRET_NAMESPACE_INVALID', 'Provider store credential namespace is invalid');
  }
  try {
    return base.scope(namespaceId);
  } catch (error) {
    throw sanitizeSecretStoreError(error);
  }
}
