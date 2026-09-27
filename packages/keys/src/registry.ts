import { AnthropicMessagesClient } from './anthropic-client';
import { configurationPendingError, withConfigurationLock } from './custody';
import { ByokKeysError } from './errors';
import type { ProviderFetch } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import { type ProviderProfileStore, providerNotConfigured } from './profile-store';
import type { PiModelConfig } from './pi-model-config';
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
  /** Required for Pi execution; omitted profiles remain direct-transport-only. */
  pi_model?: PiModelConfig;
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
  pi_model?: PiModelConfig;
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
  /**
   * Whether an unfinished credential change is recorded for this profile. While
   * true no reader may use the key; only a change that supplies a new key (or
   * a delete) clears it.
   */
  configuration_pending: boolean;
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
 * Build the normalized profile `configure` would persist: registry-owned
 * `kind`, a monotonic `updated_at` revision strictly after the previous one,
 * and the previous `created_at`. Shared with the sealed provisioning applier
 * so there is one revision authority.
 */
export function buildConfiguredProfile(
  previous: ModelProviderProfile | undefined,
  configuration: ProviderConfiguration,
  now: () => Date,
): ModelProviderProfile {
  const observedNow = now().getTime();
  const previousRevision = previous === undefined ? undefined : Date.parse(previous.updated_at);
  const revision = previousRevision === undefined
    ? observedNow
    : Math.max(observedNow, previousRevision + 1);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ByokKeysError('PROVIDER_PROFILE_INVALID', 'Provider clock cannot produce a monotonic profile revision');
  }
  const timestamp = new Date(revision).toISOString();
  return parseModelProviderProfile({
    ...configuration,
    capabilities: [...configuration.capabilities],
    created_at: previous?.created_at ?? timestamp,
    enabled: configuration.enabled ?? true,
    kind: 'model',
    updated_at: timestamp,
  });
}

/** The credential-free status projection of a profile. */
export function providerStatusOf(
  profile: ModelProviderProfile,
  state: { secretConfigured: boolean; configurationPending: boolean },
): ProviderStatus {
  const binding = exactProviderProfileBinding(profile, []);
  return {
    adapter: profile.adapter,
    auth_mode: profile.auth_mode,
    base_url: profile.base_url,
    capabilities: profile.capabilities,
    configuration_pending: state.configurationPending,
    created_at: profile.created_at,
    display_name: profile.display_name,
    enabled: profile.enabled,
    model: profile.model,
    ...(profile.pi_model === undefined ? {} : { pi_model: profile.pi_model }),
    profile_ref: profile.profile_ref,
    profile_revision: binding.profileRevision,
    profile_hash: binding.profileHash,
    provider_kind: profile.provider_kind,
    secret_configured: state.secretConfigured,
    updated_at: profile.updated_at,
  };
}

/**
 * The configure/resolve boundary, ported from `providers.ts:1180-1229`
 * (`configure`) and `providers.ts:1331-1354` (`resolveDefaultModelProvider`).
 *
 * Both halves of a provider's configuration are written here (and, for
 * remotely sealed changes, by `applySealedProviderProvisioning` under the same
 * custody protocol): the non-secret profile goes to the injected
 * {@link ProviderProfileStore}, the API key goes to the injected
 * {@link SecretStore}.
 *
 * Every writer and every credential reader holds the store's configuration
 * lock (`custody.ts`). Writers record a secret-free pending marker before the
 * OS credential write and clear it in the same store transaction that commits
 * the profile, so a crash between the two leaves a marker instead of an
 * "old profile + new key" pair, and readers refuse to read a key while a
 * marker exists.
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
   * Under the configuration lock: validate everything, require that an
   * authenticating profile will have a secret, mark pending, write the
   * secret, then commit the profile and clear the marker in one store
   * transaction. An unfinished earlier change (a pending marker) can only be
   * resolved by a call that supplies a new secret.
   */
  async configure(
    configuration: ProviderConfiguration,
    secret?: string,
  ): Promise<ProviderStatus> {
    return withConfigurationLock(this.#profiles, async () => {
      const profileRef = configuration.profile_ref;
      const previous = await this.#profiles.get(profileRef);
      const profile = buildConfiguredProfile(previous, configuration, this.#now);
      const secretName = modelProviderSecretName(profileRef);

      if (configuration.auth_mode === 'none' && secret !== undefined) {
        throw new ByokKeysError(
          'PROVIDER_SECRET_NOT_ALLOWED',
          'A provider without authentication cannot accept a secret',
        );
      }
      if (secret !== undefined && secret.length === 0) {
        throw new ByokKeysError(
          'PROVIDER_SECRET_EMPTY',
          'Provider secret cannot be empty',
        );
      }
      const pendingBefore = await this.#profiles.getPending(profileRef);
      if (configuration.auth_mode !== 'none' && secret === undefined) {
        if (pendingBefore !== undefined) throw configurationPendingError();
        if (!(await this.#secrets.has(secretName))) {
          throw new ByokKeysError(
            'PROVIDER_SECRET_MISSING',
            'Provider authentication requires a secret in the operating-system credential store',
          );
        }
      }

      await this.#profiles.markPending({
        profileRef,
        operation: 'configure',
        requestId: null,
        requestDigest: null,
        operationGeneration: null,
        since: this.#now().toISOString(),
      });
      let previousSecret: string | undefined;
      let secretWritten = false;
      if (secret !== undefined) {
        previousSecret = await this.#secrets.get(secretName);
        await this.#secrets.set(secretName, secret);
        secretWritten = true;
      }

      try {
        await this.#profiles.commitCustody({
          profileRef,
          mutation: { kind: 'save', profile },
          clearPending: true,
        });
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
        // The previous profile and secret are back in place. The marker is
        // cleared only when it was this call's own; an earlier unfinished
        // change stays unfinished.
        if (pendingBefore === undefined) {
          await this.#profiles.commitCustody({ profileRef, mutation: { kind: 'none' }, clearPending: true });
        }
        throw cause;
      }
      if (profile.auth_mode === 'none') {
        await this.#secrets.delete(secretName);
      }
      const saved = (await this.#profiles.get(profileRef)) ?? profile;
      return this.#status(saved);
    });
  }

  /**
   * Replace only the credential of an existing authenticating profile. The
   * profile record is untouched, so its revision and hash — and every exact
   * binding a Host holds — stay valid (plan D4).
   */
  async replaceSecret(profileRef: ProviderProfileRef, secret: string): Promise<ProviderStatus> {
    return withConfigurationLock(this.#profiles, async () => {
      const profile = await this.#profiles.get(profileRef);
      if (profile === undefined) throw providerNotConfigured(profileRef);
      if (profile.auth_mode === 'none') {
        throw new ByokKeysError(
          'PROVIDER_SECRET_NOT_ALLOWED',
          'A provider without authentication cannot accept a secret',
        );
      }
      if (secret.length === 0) {
        throw new ByokKeysError('PROVIDER_SECRET_EMPTY', 'Provider secret cannot be empty');
      }
      await this.#profiles.markPending({
        profileRef,
        operation: 'replace_secret',
        requestId: null,
        requestDigest: null,
        operationGeneration: null,
        since: this.#now().toISOString(),
      });
      await this.#secrets.set(modelProviderSecretName(profileRef), secret);
      await this.#profiles.commitCustody({ profileRef, mutation: { kind: 'none' }, clearPending: true });
      return this.#status(profile);
    });
  }

  /** Remove a profile and its secret together, through the same pending/commit path. */
  async delete(profileRef: ProviderProfileRef): Promise<boolean> {
    return withConfigurationLock(this.#profiles, async () => {
      const existed = (await this.#profiles.get(profileRef)) !== undefined;
      await this.#profiles.markPending({
        profileRef,
        operation: 'delete',
        requestId: null,
        requestDigest: null,
        operationGeneration: null,
        since: this.#now().toISOString(),
      });
      await this.#secrets.delete(modelProviderSecretName(profileRef));
      await this.#profiles.commitCustody({ profileRef, mutation: { kind: 'delete' }, clearPending: true });
      return existed;
    });
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
   * missing secret, an unfinished credential change, or an unusable profile is
   * a fault, not an absence. The profile, the pending check and the key are
   * read under one configuration lock.
   */
  async resolveDefaultModelProvider(): Promise<ModelProviderClient | undefined> {
    const snapshot = await withConfigurationLock(this.#profiles, async () => {
      const profile = await this.#profiles.getEnabled();
      if (profile === undefined) return undefined;
      if ((await this.#profiles.getPending(profile.profile_ref)) !== undefined) {
        throw configurationPendingError();
      }
      const secret = await this.#secrets.get(
        modelProviderSecretName(profile.profile_ref),
      );
      return { profile, secret };
    });
    if (snapshot === undefined) return undefined;
    const options = { fetchImpl: this.#fetch, profile: snapshot.profile, secret: snapshot.secret };
    return snapshot.profile.adapter === 'anthropic'
      ? new AnthropicMessagesClient(options)
      : new OpenAiCompatibleChatClient(options);
  }

  /** Switch which configured profile is the default. */
  async setDefaultModelProvider(
    profileRef: ProviderProfileRef,
  ): Promise<ProviderStatus> {
    const profile = await withConfigurationLock(this.#profiles, () => this.#profiles.setEnabled(profileRef));
    return this.#status(profile);
  }

  async #status(profile: ModelProviderProfile): Promise<ProviderStatus> {
    return providerStatusOf(profile, {
      secretConfigured: await this.#secrets.has(
        modelProviderSecretName(profile.profile_ref),
      ),
      configurationPending: (await this.#profiles.getPending(profile.profile_ref)) !== undefined,
    });
  }
}
