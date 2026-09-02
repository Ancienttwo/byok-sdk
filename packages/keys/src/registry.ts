import { AnthropicMessagesClient } from './anthropic-client';
import { ByokKeysError } from './errors';
import type { ProviderFetch } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import type { ProviderProfileStore } from './profile-store';
import {
  type ModelProviderAdapter,
  type ModelProviderKind,
  type ModelProviderProfile,
  type ProviderAuthMode,
  type ProviderModelCapability,
  type ProviderProfileRef,
  exactProviderProfileBinding,
  parseModelProviderProfile,
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
  /**
   * Bounded model capabilities this exact profile supports. Declared, never
   * inferred: an omitted capability means the endpoint does not offer it.
   */
  capabilities: readonly ProviderModelCapability[];
  display_name: string;
  /** Defaults to `true`: configuring a provider makes it the default. */
  enabled?: boolean;
  model: string;
  /** This profile's own local identity; several profiles may share one kind. */
  profile_ref: ProviderProfileRef;
  provider_kind: ModelProviderKind;
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
  capabilities: readonly ProviderModelCapability[];
  created_at: string;
  display_name: string;
  enabled: boolean;
  model: string;
  profile_ref: ProviderProfileRef;
  /** Canonical credential-free revision used by exact task admission. */
  profile_revision: string;
  /** SHA-256 of the normalized non-secret local record. */
  profile_hash: string;
  provider_kind: ModelProviderKind;
  /** Whether the credential store currently holds this profile's key. */
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

  async close(): Promise<void> {
    await this.#profiles.close();
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
    const previous = await this.#profiles.get(configuration.profile_ref);
    const observedNow = this.#now().getTime();
    const previousRevision = previous === undefined ? undefined : Date.parse(previous.updated_at);
    const revision = previousRevision === undefined
      ? observedNow
      : Math.max(observedNow, previousRevision + 1);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new ByokKeysError('PROVIDER_PROFILE_INVALID', 'Provider clock cannot produce a monotonic profile revision');
    }
    const timestamp = new Date(revision).toISOString();
    const profile = parseModelProviderProfile({
      ...configuration,
      capabilities: [...configuration.capabilities],
      created_at: previous?.created_at ?? timestamp,
      enabled: configuration.enabled ?? true,
      kind: 'model',
      updated_at: timestamp,
    });
    const secretName = modelProviderSecretName(configuration.profile_ref);
    let previousSecret: string | undefined;
    let secretWritten = false;

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
      previousSecret = await this.#secrets.get(secretName);
      await this.#secrets.set(secretName, secret);
      secretWritten = true;
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

    let saved: ModelProviderProfile;
    try {
      saved = await this.#profiles.save(profile);
    } catch (cause) {
      if (secretWritten) {
        try {
          if (previousSecret === undefined) {
            await this.#secrets.delete(secretName);
          } else {
            await this.#secrets.set(secretName, previousSecret);
          }
        } catch (rollbackCause) {
          throw new ByokKeysError(
            'PROVIDER_SECRET_ROLLBACK_FAILED',
            'Provider profile write failed and the previous secret could not be restored',
            { cause: new AggregateError([cause, rollbackCause]) },
          );
        }
      }
      throw cause;
    }
    if (saved.auth_mode === 'none') {
      await this.#secrets.delete(secretName);
    }
    return this.#status(saved);
  }

  /** Remove a profile and its secret together. */
  async delete(profileRef: ProviderProfileRef): Promise<boolean> {
    const removed = await this.#profiles.delete(profileRef);
    await this.#secrets.delete(modelProviderSecretName(profileRef));
    return removed;
  }

  async get(profileRef: ProviderProfileRef): Promise<ProviderStatus | undefined> {
    const profile = await this.#profiles.get(profileRef);
    return profile === undefined ? undefined : this.#status(profile);
  }

  async list(): Promise<ProviderStatus[]> {
    return Promise.all(
      (await this.#profiles.list()).map((profile) => this.#status(profile)),
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
    const profile = await this.#profiles.getEnabled();
    if (profile === undefined) return undefined;
    const secret = await this.#secrets.get(
      modelProviderSecretName(profile.profile_ref),
    );
    const options = { fetchImpl: this.#fetch, profile, secret };
    return profile.adapter === 'anthropic'
      ? new AnthropicMessagesClient(options)
      : new OpenAiCompatibleChatClient(options);
  }

  /** Switch which configured profile is the default. */
  async setDefaultModelProvider(
    profileRef: ProviderProfileRef,
  ): Promise<ProviderStatus> {
    return this.#status(await this.#profiles.setEnabled(profileRef));
  }

  async #status(profile: ModelProviderProfile): Promise<ProviderStatus> {
    const binding = exactProviderProfileBinding(profile, []);
    return {
      adapter: profile.adapter,
      auth_mode: profile.auth_mode,
      base_url: profile.base_url,
      capabilities: profile.capabilities,
      created_at: profile.created_at,
      display_name: profile.display_name,
      enabled: profile.enabled,
      model: profile.model,
      profile_ref: profile.profile_ref,
      profile_revision: binding.profileRevision,
      profile_hash: binding.profileHash,
      provider_kind: profile.provider_kind,
      secret_configured: await this.#secrets.has(
        modelProviderSecretName(profile.profile_ref),
      ),
      updated_at: profile.updated_at,
    };
  }
}
