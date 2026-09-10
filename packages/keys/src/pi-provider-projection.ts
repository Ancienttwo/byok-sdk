import type { ModelProviderProfile } from './provider-profile';
import { isAbsolute } from 'node:path';
import { PiModelConfigSchema } from './pi-model-config';

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
  const { thinkingLevel: _, ...modelSettings } = requirePiModelConfig(profile);
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
            ...modelSettings,
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
  const config = requirePiModelConfig(profile);
  if (delegatedArgs.length > 128) throw new Error('Pi launcher delegated argument limit exceeded');
  let modeCount = 0;
  let extensionCount = 0;
  const singleFlags = new Set<string>();
  for (let index = 0; index < delegatedArgs.length; index += 1) {
    const flag = delegatedArgs[index];
    if (typeof flag !== 'string' || /[\u0000\r\n]/u.test(flag)) throw new Error('Pi launcher argument must be single-line');
    if (flag !== '--extension') {
      if (singleFlags.has(flag)) throw new Error(`Pi launcher duplicate argument ${flag}`);
      singleFlags.add(flag);
    }
    if (flag === '--no-tools') continue;
    if (flag === '--extension') {
      const value = delegatedArgs[++index];
      if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)) {
        throw new Error('Pi launcher --extension requires an absolute single-line path');
      }
      if (++extensionCount > 16) throw new Error('Pi launcher extension limit exceeded');
      continue;
    }
    if (flag === '--mode') {
      modeCount += 1;
      const value = delegatedArgs[index + 1];
      if (value !== 'rpc') throw new Error('Pi launcher requires --mode rpc');
      index += 1;
      continue;
    }
    if (flag === '--session' || flag === '--tools' || flag === '--exclude-tools') {
      const value = delegatedArgs[index + 1];
      if (!value || value.startsWith('--') || /[\u0000\r\n]/u.test(value)) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new Error(`Pi launcher does not allow delegated argument ${flag ?? '<missing>'}`);
  }
  if (modeCount !== 1) throw new Error('Pi launcher requires exactly one --mode rpc');
  if (singleFlags.has('--no-tools') && singleFlags.has('--tools')) {
    throw new Error('Pi launcher cannot combine --no-tools and --tools');
  }

  return [
    ...delegatedArgs,
    '--provider',
    piProjectionProviderId(profile.profile_ref),
    '--model',
    profile.model,
    '--thinking',
    config.thinkingLevel,
  ];
}

function requirePiModelConfig(profile: ModelProviderProfile) {
  if (profile.pi_model === undefined) throw new Error('Pi execution requires explicit pi_model configuration');
  return PiModelConfigSchema.parse(profile.pi_model);
}
