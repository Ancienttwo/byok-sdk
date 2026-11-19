import { vi } from 'vitest';

import type { ProviderProfileStore } from '../profile-store';
import type { SecretStore } from '../secret-store';

/** Keep one real scoped view available for test spies and fault injection. */
export function observeProviderCredentials<TName extends string>(base: SecretStore<TName>, profiles: ProviderProfileStore): SecretStore<TName> {
  const id = profiles.credentialNamespaceId;
  const scope = base.scope.bind(base);
  const credentials = scope(id);
  vi.spyOn(base, 'scope').mockImplementation(namespace => namespace === id ? credentials : scope(namespace));
  return credentials;
}
