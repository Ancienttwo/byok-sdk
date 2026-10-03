import type { ModelProviderSecretName, SecretStore, ModelProviderVendorId } from '@byok-sdk/keys';
import { CloudDoError } from './errors';

// Aiphabee 3defa6e1; vendor ids/base URLs agree with keys' catalog. No runtime keys import.
export const PLATFORM_PROFILES = Object.freeze({
  zai_openai: Object.freeze({ vendor: 'zai' satisfies ModelProviderVendorId, baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash', binding: 'AIPHABEE_ZAI_API_KEY', secretName: 'model-zai_openai-api-key' satisfies ModelProviderSecretName }),
  deepseek_direct: Object.freeze({ vendor: 'deepseek' satisfies ModelProviderVendorId, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', binding: 'AIPHABEE_DEEPSEEK_API_KEY', secretName: 'model-deepseek_direct-api-key' satisfies ModelProviderSecretName }),
});
export type PlatformProfileId = keyof typeof PLATFORM_PROFILES;
export type PlatformProfile = (typeof PLATFORM_PROFILES)[PlatformProfileId];

export function platformProfile(id: unknown): PlatformProfileId {
  if (typeof id !== 'string' || !Object.hasOwn(PLATFORM_PROFILES, id)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  return id as PlatformProfileId;
}

/** A small bounded ASCII token, never whitespace/control characters or a header fragment. */
export function requirePlatformKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/-]{16,512}$/u.test(value)) throw new CloudDoError('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
  return value;
}

/** The concrete reader returns a valid key or rejects with a fixed error. */
export function platformCredentialReader(env: Readonly<Record<string, unknown>>): {
  get(name: ModelProviderSecretName): Promise<string>;
} {
  return {
    async get(name) {
      const profile = Object.values(PLATFORM_PROFILES).find(profile => profile.secretName === name);
      if (!profile) throw new CloudDoError('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
      try { return requirePlatformKey(env[profile.binding]); }
      catch { throw new CloudDoError('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE'); }
    },
  } satisfies Pick<SecretStore<ModelProviderSecretName>, 'get'>;
}
