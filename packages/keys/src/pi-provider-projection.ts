import type { ModelProviderProfile } from './provider-profile';

export const PI_PROJECTED_KEY_ENV = 'PI_PROVIDER_API_KEY';

/** Keep projected providers disjoint from Pi built-ins so composition can never fall back to one. */
export function piProjectionProviderId(profileRef: string): string {
  return `byok-sdk-${profileRef}`;
}

/**
 * Credential-blind Pi configuration derived from one validated local profile.
 *
 * The projected provider is namespaced by the profile's own ref, not by its
 * provider kind, so two independently configured endpoints of the same kind
 * project to two distinct Pi providers instead of colliding on one. Model
 * `input` modalities are projected from the profile's declared capabilities —
 * declared local configuration is the only authority; nothing is inferred from
 * the model name or base URL.
 */
export function buildPiProviderProjection(profile: ModelProviderProfile): object {
  const projectedProviderId = piProjectionProviderId(profile.profile_ref);
  return {
    providers: {
      [projectedProviderId]: {
        baseUrl: profile.base_url,
        api:
          profile.adapter === 'anthropic'
            ? 'anthropic-messages'
            : 'openai-completions',
        ...(profile.auth_mode === 'none'
          ? {}
          : { apiKey: `$${PI_PROJECTED_KEY_ENV}` }),
        ...(profile.auth_mode === 'bearer' ? { authHeader: true } : {}),
        models: [
          {
            id: profile.model,
            name: profile.display_name,
            input: [
              'text',
              ...(profile.capabilities.includes('image-input') ? ['image'] : []),
            ],
          },
        ],
      },
    },
  };
}

/**
 * Validate the credential-blind RPC argv the client may delegate, then bind
 * the Pi child to the namespaced projection and exact configured model.
 */
export function buildPiProviderArgs(
  profile: ModelProviderProfile,
  delegatedArgs: readonly string[],
): string[] {
  let modeCount = 0;
  for (let index = 0; index < delegatedArgs.length; index += 1) {
    const flag = delegatedArgs[index];
    if (flag === '--no-tools') continue;
    if (flag === '--mode') {
      modeCount += 1;
      const value = delegatedArgs[index + 1];
      if (value !== 'rpc') throw new Error('Pi launcher requires --mode rpc');
      index += 1;
      continue;
    }
    if (flag === '--session' || flag === '--tools' || flag === '--exclude-tools') {
      const value = delegatedArgs[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new Error(`Pi launcher does not allow delegated argument ${flag ?? '<missing>'}`);
  }
  if (modeCount !== 1) throw new Error('Pi launcher requires exactly one --mode rpc');

  return [
    ...delegatedArgs,
    '--provider',
    piProjectionProviderId(profile.profile_ref),
    '--model',
    profile.model,
  ];
}
