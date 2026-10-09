import type { ModelProviderProfile } from './provider-profile';
import { isAbsolute } from 'node:path';
import { ByokKeysError } from './errors';
import { modelApiUrl } from './http';
import { PiModelConfigSchema } from './pi-model-config';

export const PI_PROJECTED_KEY_ENV = 'PI_PROVIDER_API_KEY';

/**
 * The fixed, non-secret `apiKey` projected for an `auth_mode: 'none'` profile.
 *
 * Pi's OpenAI client refuses a request that has no API key and no
 * authorization header. Pi documents a fixed dummy key in `models.json` for a
 * keyless server. The Pi child therefore sends `authorization: Bearer
 * byok-sdk-auth-none`; a keyless server ignores it. This value is not a
 * credential, and the launcher reads no secret for such a profile.
 */
export const PI_AUTH_NONE_API_KEY = 'byok-sdk-auth-none';

/** The path Pi's Anthropic SDK appends to a provider `baseUrl`. */
const PI_ANTHROPIC_MESSAGES_PATH = '/v1/messages';

/**
 * The runtime entries this launcher may parent, and the ONLY two.
 *
 * The entry is not a hint about which flags happen to be present: it selects
 * which delegated-argv grammar below is applied, and the two grammars admit
 * disjoint argument sets. A client that could omit it would be a client whose
 * argv decides the grammar, so the flag is required at the parser rather than
 * defaulted — a client/keys version skew then fails closed instead of
 * silently launching a prepared host under the rpc grammar.
 */
export const PI_LAUNCHER_RUNTIME_ENTRIES = ['pi-rpc', 'pi-prepared', 'pi-durable'] as const;
export type PiLauncherRuntimeEntry = (typeof PI_LAUNCHER_RUNTIME_ENTRIES)[number];

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
export function buildPiProviderProjection(profile: ModelProviderProfile, runtimeEntry: PiLauncherRuntimeEntry = 'pi-rpc'): object {
  const { thinkingLevel: _, ...modelSettings } = requirePiModelConfig(profile);
  const projectedProviderId = piProjectionProviderId(profile.profile_ref);
  return {
    providers: {
      [projectedProviderId]: {
        baseUrl: profile.adapter === 'anthropic' ? piAnthropicBaseUrl(profile) : profile.base_url,
        api:
          profile.adapter === 'anthropic'
            ? 'anthropic-messages'
            : 'openai-completions',
        apiKey: piApiKey(profile, runtimeEntry),
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
 * The Pi `baseUrl` that sends Pi's Messages request to the same URL as
 * `AnthropicMessagesClient`.
 *
 * A profile `base_url` follows this package's suffix convention: the keys
 * client posts to `modelApiUrl(base_url, 'messages')`, so the catalog stores
 * `https://api.anthropic.com/v1`. Pi's Anthropic SDK appends `/v1/messages` to
 * its `baseUrl`. The projection removes that suffix from the keys endpoint.
 * No Pi `baseUrl` reaches an endpoint that does not end in `/v1/messages`, so
 * the projection refuses such a profile and never sends Pi to another URL.
 */
function piAnthropicBaseUrl(profile: ModelProviderProfile): string {
  const endpoint = modelApiUrl(profile.base_url, 'messages');
  if (!endpoint.endsWith(PI_ANTHROPIC_MESSAGES_PATH)) {
    throw new ByokKeysError(
      'PROVIDER_URL_INVALID',
      `${profile.profile_ref} Anthropic base_url must end in /v1 for Pi, which appends /v1/messages`,
    );
  }
  return endpoint.slice(0, -PI_ANTHROPIC_MESSAGES_PATH.length);
}

/**
 * The projected key reference. Only the rpc entry serves a keyless profile:
 * the prepared host and the durable worker both require a launcher-delivered
 * credential, so a keyless profile fails here, before a child exists.
 */
function piApiKey(profile: ModelProviderProfile, runtimeEntry: PiLauncherRuntimeEntry): string {
  if (profile.auth_mode !== 'none') {
    return runtimeEntry === 'pi-durable' ? 'byok:durable-ipc' : `$${PI_PROJECTED_KEY_ENV}`;
  }
  if (runtimeEntry !== 'pi-rpc') {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      `${profile.profile_ref} declares auth_mode "none"; the ${runtimeEntry} runtime entry requires a provider credential`,
    );
  }
  return PI_AUTH_NONE_API_KEY;
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
    if (flag === '--no-tools' || flag === '--no-skills' || flag === '--no-extensions') continue;
    if (flag === '--config') {
      const value = delegatedArgs[++index];
      if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)) {
        throw new Error('Pi launcher --config requires an absolute single-line path');
      }
      continue;
    }
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

/**
 * The whole delegated argv a prepared host may be launched with: one
 * `--config <absolute path>` pair, and nothing else.
 *
 * Nothing is APPENDED either. The rpc grammar ends by binding the child to the
 * projected provider, the configured model and the configured thinking level,
 * because the rpc child composes its session from `models.json`. A prepared
 * host composes nothing: the request it consumes was already compiled and the
 * model it verifies against is the one the durable record pinned, so a
 * `--provider`/`--model`/`--thinking` appended here would be a second, silent
 * authority over a request that was already decided — and the host's own
 * argument parser refuses anything but `--config` regardless.
 */
export function buildPiPreparedArgs(delegatedArgs: readonly string[]): string[] {
  if (delegatedArgs.length !== 2 || delegatedArgs[0] !== '--config') {
    throw new Error('Pi prepared launcher requires exactly --config <path>');
  }
  const value = delegatedArgs[1];
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)) {
    throw new Error('Pi launcher --config requires an absolute single-line path');
  }
  return [...delegatedArgs];
}

function requirePiModelConfig(profile: ModelProviderProfile) {
  if (profile.pi_model === undefined) throw new Error('Pi execution requires explicit pi_model configuration');
  return PiModelConfigSchema.parse(profile.pi_model);
}
