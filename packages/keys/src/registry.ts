import { AnthropicMessagesClient } from './anthropic-client';
import { ByokKeysError } from './errors';
import type { ProviderFetch } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import type { ProviderProfileStore } from './profile-store';
import {
  type ModelProviderAdapter,
  type ModelProviderId,
  type ModelProviderProfile,
  type ProviderAuthMode,
} from './provider-profile';
import {
  type ModelProviderSecretName,
  type SecretStore,
  modelProviderSecretName,
} from './secret-store';

/** A transport client for whichever dialect the resolved profile declares. */
export type ModelProviderClient =
  | AnthropicMessagesClient
  | OpenAiCompatibleChatClient;

/**
 * What a caller supplies to {@link ProviderRegistry.configure}: the profile
 * minus the fields the registry owns (`kind`, both timestamps) and minus the
 * secret, which travels as a separate argument so it cannot be mistaken for
 * persisted data.
 */
export interface ProviderConfiguration {
  adapter: ModelProviderAdapter;
  auth_mode: ProviderAuthMode;
  base_url: string;
  display_name: string;
  /** Defaults to `true`: configuring a provider makes it the default. */
  enabled?: boolean;
  model: string;
  provider_id: ModelProviderId;
}

/**
 * The registry's outward projection of a profile.
 *
 * It reports **whether** a secret exists (`secret_configured`) and never the
 * secret itself — the property `registry.golden.test.ts` asserts, mirroring
 * `docs/researches/HANDOFF-byok-keys.md` §4.3's "status JSON contains no
 * plaintext key".
 */
export interface ProviderStatus {
  adapter: ModelProviderAdapter;
  auth_mode: ProviderAuthMode;
  base_url: string;
  created_at: string;
  display_name: string;
  enabled: boolean;
  model: string;
  provider_id: ModelProviderId;
  /** Whether the credential store currently holds this provider's key. */
  secret_configured: boolean;
  updated_at: string;
}

export interface ProviderRegistryOptions {
  fetchImpl?: ProviderFetch;
  /** Injected clock, so tests get deterministic timestamps. */
  now?: () => Date;
  profileStore: ProviderProfileStore;
  secretStore: SecretStore<ModelProviderSecretName>;
}

/**
 * The configure/resolve boundary, ported from `providers.ts:1180-1229`
 * (`configure`) and `providers.ts:1331-1354` (`resolveDefaultModelProvider`).
 *
 * Both halves of a provider's configuration are written here and nowhere else:
 * the non-secret profile goes to the injected {@link ProviderProfileStore}, the
 * API key goes to the injected {@link SecretStore}. Splitting them is the whole
 * point of the package, so the registry is the only place that knows both.
 *
 * Two departures from the source, both required by
 * `docs/researches/HANDOFF-byok-keys.md` §4.5:
 *
 * - `resolveDefaultModelProvider` returns a transport client or `undefined`,
 *   and throws on a broken configuration. The source returned an
 *   `UnavailableNarrativeProvider` null-object carrying an error code, which is
 *   a narrative-domain symbol that stays in aip-main-open — and a degradation
 *   fallback this package's fail-closed rule does not permit. A caller that
 *   wants aip's behaviour catches `ByokKeysError` and reads `.code`, which is
 *   the same information the null-object carried.
 * - The source's `#migrateLegacyModelSecret` is not ported (legacy secret
 *   migration is out of scope per the plan).
 */
export class ProviderRegistry {
  readonly #fetch: ProviderFetch | undefined;
  readonly #now: () => Date;
  readonly #profiles: ProviderProfileStore;
  readonly #secrets: SecretStore<ModelProviderSecretName>;

  constructor(options: ProviderRegistryOptions) {
    this.#fetch = options.fetchImpl;
    this.#now = options.now ?? (() => new Date());
    this.#profiles = options.profileStore;
    this.#secrets = options.secretStore;
  }

  close(): void {
    this.#profiles.close();
  }

  /**
   * Persist a provider's profile and, when supplied, its secret
   * (`providers.ts:1180-1229`).
   *
   * Order matters and is the source's: write the secret first, then require
   * that an authenticating profile actually has one, and only then save the
   * profile. A profile is therefore never persisted in a state that claims
   * authentication it cannot perform.
   */
  async configure(
    configuration: ProviderConfiguration,
    secret?: string,
  ): Promise<ProviderStatus> {
    const timestamp = this.#now().toISOString();
    const previous = this.#profiles.get(configuration.provider_id);
    const profile = {
      ...configuration,
      created_at: previous?.created_at ?? timestamp,
      enabled: configuration.enabled ?? true,
      kind: 'model',
      updated_at: timestamp,
    } as ModelProviderProfile;
    const secretName = modelProviderSecretName(configuration.provider_id);

    if (configuration.auth_mode === 'none' && secret !== undefined) {
      throw new ByokKeysError(
        'PROVIDER_SECRET_NOT_ALLOWED',
        'A provider without authentication cannot accept a secret',
      );
    }
    if (secret !== undefined) {
      if (secret.length === 0) {
        throw new ByokKeysError(
          'PROVIDER_SECRET_EMPTY',
          'Provider secret cannot be empty',
        );
      }
      await this.#secrets.set(secretName, secret);
    }
    if (
      configuration.auth_mode !== 'none' &&
      !(await this.#secrets.has(secretName))
    ) {
      throw new ByokKeysError(
        'PROVIDER_SECRET_MISSING',
        'Provider authentication requires a secret in the operating-system credential store',
      );
    }

    const saved = this.#profiles.save(profile);
    if (saved.auth_mode === 'none') {
      await this.#secrets.delete(secretName);
    }
    return this.#status(saved);
  }

  /** Remove a provider's profile and its secret together. */
  async delete(providerId: ModelProviderId): Promise<boolean> {
    const removed = this.#profiles.delete(providerId);
    await this.#secrets.delete(modelProviderSecretName(providerId));
    return removed;
  }

  async get(providerId: ModelProviderId): Promise<ProviderStatus | undefined> {
    const profile = this.#profiles.get(providerId);
    return profile === undefined ? undefined : this.#status(profile);
  }

  async list(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.#profiles.list().map((profile) => this.#status(profile)),
    );
  }

  /**
   * Build a client for the one enabled provider (`providers.ts:1331-1354`).
   *
   * `undefined` means "nothing is configured", which is a legitimate state a
   * caller must handle. A configured-but-broken provider throws instead — a
   * missing secret or an unusable profile is a fault, not an absence.
   */
  async resolveDefaultModelProvider(): Promise<ModelProviderClient | undefined> {
    const profile = this.#profiles.getEnabled();
    if (profile === undefined) return undefined;
    const secret = await this.#secrets.get(
      modelProviderSecretName(profile.provider_id),
    );
    const options = { fetchImpl: this.#fetch, profile, secret };
    return profile.adapter === 'anthropic'
      ? new AnthropicMessagesClient(options)
      : new OpenAiCompatibleChatClient(options);
  }

  /** Switch which configured provider is the default. */
  async setDefaultModelProvider(
    providerId: ModelProviderId,
  ): Promise<ProviderStatus> {
    return this.#status(this.#profiles.setEnabled(providerId));
  }

  async #status(profile: ModelProviderProfile): Promise<ProviderStatus> {
    return {
      adapter: profile.adapter,
      auth_mode: profile.auth_mode,
      base_url: profile.base_url,
      created_at: profile.created_at,
      display_name: profile.display_name,
      enabled: profile.enabled,
      model: profile.model,
      provider_id: profile.provider_id,
      secret_configured: await this.#secrets.has(
        modelProviderSecretName(profile.provider_id),
      ),
      updated_at: profile.updated_at,
    };
  }
}
