import type { ModelProviderProfile } from './provider-profile';
import { isAbsolute } from 'node:path';
import { PiModelConfigSchema } from './pi-model-config';

export const PI_PROJECTED_KEY_ENV = 'PI_PROVIDER_API_KEY';

/**
 * The runtime entries this launcher may parent, and the ONLY two.
 *
 * The entry is not a hint about which flags happen to be present: it selects
 * which delegated-argv grammar below is applied, and the two grammars admit
 * disjoint argument sets. A client that could omit it would be a client whose
 * argv decides the grammar, so the flag is required at the parser rather than
 * defaulted — a client/keys version skew then fails closed instead of
 * silently launching a prepared host under the rpc grammar.
 *
 * `@byok-sdk/implementation-identity` declares four entries; the other two
 * (`pi-subagent-print`, `pi-subagent-runner`) are descendants the launcher
 * never parents, so restating the pair here is a narrowing, not a second
 * vocabulary.
 */
export const PI_LAUNCHER_RUNTIME_ENTRIES = ['pi-rpc', 'pi-prepared'] as const;
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
