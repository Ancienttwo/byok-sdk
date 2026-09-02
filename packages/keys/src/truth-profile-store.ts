import { createHash } from 'node:crypto';

import {
  contentHash,
  isCoreConflictError,
  type TenantId,
  type TruthRecord,
  type TruthStore,
} from '@byok-sdk/core';

import { ByokKeysError } from './errors';
import {
  type ProviderProfileStore,
  providerNotConfigured,
} from './profile-store';
import {
  type ModelProviderProfile,
  type ProviderProfileRef,
  parseModelProviderProfile,
} from './provider-profile';

export const PROVIDER_PROFILE_TRUTH_RECORD_KEY =
  'byok-sdk.keys/model-provider-registry-v1';

const PROFILE_KEYS = [
  'adapter',
  'auth_mode',
  'base_url',
  'capabilities',
  'created_at',
  'display_name',
  'enabled',
  'kind',
  'model',
  'profile_ref',
  'provider_kind',
  'updated_at',
] as const;

/**
 * Upper bound on how many profiles one tenant's registry snapshot may carry.
 *
 * The former bound was `MODEL_PROVIDER_IDS.length`, which only held because the
 * primary key was a four-value enum. Profile refs are open, so the CAS body
 * needs an explicit ceiling of its own; a registry is device-local operator
 * configuration, and 32 endpoints is far past any real local setup while
 * keeping the single-record snapshot small.
 */
export const MAX_PROVIDER_PROFILES = 32;

interface ProviderRegistrySnapshotV1 {
  readonly schema_version: 1;
  readonly profiles: readonly ModelProviderProfile[];
}

interface LoadedRegistry {
  readonly profiles: readonly ModelProviderProfile[];
  readonly rev: number;
}

export interface TruthStoreProviderProfileStoreOptions {
  tenant: TenantId;
  truthStore: TruthStore;
}

/**
 * Tenant-bound profile persistence over the core TruthStore snapshot contract.
 *
 * The complete, closed provider registry is one CAS unit. That is what makes a
 * delete and the "at most one enabled profile" transition atomic without
 * adding a second transaction authority. The body is metadata only; provider
 * credentials remain exclusively in the independently injected SecretStore.
 */
export class TruthStoreProviderProfileStore implements ProviderProfileStore {
  readonly #tenant: TenantId;
  readonly #truth: TruthStore;

  constructor(options: TruthStoreProviderProfileStoreOptions) {
    this.#tenant = options.tenant;
    this.#truth = options.truthStore;
  }

  async close(): Promise<void> {
    // The host owns the injected TruthStore lifecycle.
  }

  async delete(profileRef: ProviderProfileRef): Promise<boolean> {
    const current = await this.#load();
    if (!current.profiles.some((profile) => profile.profile_ref === profileRef)) {
      return false;
    }
    await this.#write(
      current.profiles.filter((profile) => profile.profile_ref !== profileRef),
      current.rev,
    );
    return true;
  }

  async get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined> {
    return (await this.#load()).profiles.find(
      (profile) => profile.profile_ref === profileRef,
    );
  }

  async getEnabled(): Promise<ModelProviderProfile | undefined> {
    return (await this.#load()).profiles.find((profile) => profile.enabled);
  }

  async list(): Promise<ModelProviderProfile[]> {
    return [...(await this.#load()).profiles];
  }

  async save(profile: ModelProviderProfile): Promise<ModelProviderProfile> {
    const current = await this.#load();
    const existing = current.profiles.find(
      (candidate) => candidate.profile_ref === profile.profile_ref,
    );
    const validated = parseModelProviderProfile({
      ...profile,
      created_at: existing?.created_at ?? profile.created_at,
    });
    const next = current.profiles
      .filter((candidate) => candidate.profile_ref !== validated.profile_ref)
      .map((candidate) =>
        validated.enabled && candidate.enabled
          ? { ...candidate, enabled: false }
          : candidate,
      );
    next.push(validated);
    await this.#write(next, current.rev);
    return validated;
  }

  async setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile> {
    const current = await this.#load();
    const selected = current.profiles.find(
      (profile) => profile.profile_ref === profileRef,
    );
    if (selected === undefined) throw providerNotConfigured(profileRef);
    const next = current.profiles.map((profile) => ({
      ...profile,
      enabled: profile.profile_ref === profileRef,
    }));
    await this.#write(next, current.rev);
    return { ...selected, enabled: true };
  }

  async #load(): Promise<LoadedRegistry> {
    const record = await this.#truth.getRecord(this.#tenant, {
      kind: 'profile',
      recordKey: PROVIDER_PROFILE_TRUTH_RECORD_KEY,
    });
    if (record === undefined) return { profiles: [], rev: 0 };
    return decodeRegistryRecord(record, this.#tenant);
  }

  async #write(
    profiles: readonly ModelProviderProfile[],
    expectedRev: number,
  ): Promise<void> {
    const encoded = encodeRegistry(profiles);
    let written: TruthRecord;
    try {
      written = await this.#truth.writeSnapshot(this.#tenant, {
        kind: 'profile',
        recordKey: PROVIDER_PROFILE_TRUTH_RECORD_KEY,
        expectedRev,
        contentHash: hashBody(encoded),
        byteSize: BigInt(new TextEncoder().encode(encoded).byteLength),
        body: { kind: 'inline', body: encoded },
        label: 'BYOK model provider registry',
      });
    } catch (cause) {
      if (isCoreConflictError(cause, 'truth_revision_conflict')) {
        throw new ByokKeysError(
          'PROVIDER_PROFILE_CONFLICT',
          'Provider profiles changed since this operation read them',
          { cause },
        );
      }
      throw cause;
    }
    if (written.body.kind !== 'inline' || written.body.body !== encoded) {
      throw invalidTruth('TruthStore did not confirm the requested provider profile snapshot');
    }
    const confirmed = decodeRegistryRecord(written, this.#tenant);
    if (confirmed.rev !== expectedRev + 1) {
      throw invalidTruth('TruthStore confirmed an unexpected provider profile revision');
    }
  }
}

function encodeRegistry(profiles: readonly ModelProviderProfile[]): string {
  const normalized = profiles
    .map((profile) => parseModelProviderProfile(profile))
    .sort((left, right) => left.profile_ref.localeCompare(right.profile_ref));
  assertRegistryInvariants(normalized);
  const snapshot: ProviderRegistrySnapshotV1 = {
    schema_version: 1,
    profiles: normalized.map((profile) => ({
      adapter: profile.adapter,
      auth_mode: profile.auth_mode,
      base_url: profile.base_url,
      capabilities: profile.capabilities,
      created_at: profile.created_at,
      display_name: profile.display_name,
      enabled: profile.enabled,
      kind: profile.kind,
      model: profile.model,
      profile_ref: profile.profile_ref,
      provider_kind: profile.provider_kind,
      updated_at: profile.updated_at,
    })),
  };
  return JSON.stringify(snapshot);
}

function decodeRegistryRecord(
  record: TruthRecord,
  tenant: TenantId,
): LoadedRegistry {
  if (
    record.tenantId !== tenant ||
    record.kind !== 'profile' ||
    record.recordKey !== PROVIDER_PROFILE_TRUTH_RECORD_KEY ||
    !Number.isSafeInteger(record.rev) ||
    record.rev < 1
  ) {
    throw invalidTruth('TruthStore returned mismatched provider profile authority');
  }
  if (record.body.kind !== 'inline') {
    throw invalidTruth('Provider profiles must use an inline TruthStore body');
  }
  const bytes = new TextEncoder().encode(record.body.body);
  if (record.byteSize !== BigInt(bytes.byteLength)) {
    throw invalidTruth('Provider profile TruthStore byte size does not match its body');
  }
  if (record.contentHash !== hashBody(record.body.body)) {
    throw invalidTruth('Provider profile TruthStore hash does not match its body');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(record.body.body);
  } catch (cause) {
    throw invalidTruth('Provider profile TruthStore body is not valid JSON', cause);
  }
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ['profiles', 'schema_version'])) {
    throw invalidTruth('Provider profile TruthStore body has an unknown top-level field');
  }
  if (raw.schema_version !== 1 || !Array.isArray(raw.profiles)) {
    throw invalidTruth('Provider profile TruthStore body has an unsupported schema');
  }
  if (raw.profiles.length > MAX_PROVIDER_PROFILES) {
    throw invalidTruth('Provider profile TruthStore body exceeds the provider registry bound');
  }
  let profiles: ModelProviderProfile[];
  try {
    profiles = raw.profiles.map((candidate) => {
      if (!isPlainRecord(candidate) || !hasExactKeys(candidate, PROFILE_KEYS)) {
        throw invalidTruth('Provider profile TruthStore body contains an unknown profile field');
      }
      return parseModelProviderProfile(candidate);
    });
  } catch (cause) {
    if (cause instanceof ByokKeysError && cause.code === 'PROVIDER_TRUTH_INVALID') {
      throw cause;
    }
    throw invalidTruth('Provider profile TruthStore body contains an invalid profile', cause);
  }
  assertRegistryInvariants(profiles);
  if (record.body.body !== encodeRegistry(profiles)) {
    throw invalidTruth('Provider profile TruthStore body is not in canonical form');
  }
  return { profiles, rev: record.rev };
}

function assertRegistryInvariants(
  profiles: readonly ModelProviderProfile[],
): void {
  const seen = new Set<ProviderProfileRef>();
  let enabled = 0;
  for (const profile of profiles) {
    if (seen.has(profile.profile_ref)) {
      throw invalidTruth(`Provider profile ${profile.profile_ref} appears more than once`);
    }
    seen.add(profile.profile_ref);
    if (profile.enabled) enabled += 1;
  }
  if (enabled > 1) {
    throw invalidTruth('Provider profile TruthStore body enables more than one provider');
  }
}

function hashBody(body: string) {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  return contentHash(`sha256:${digest}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function invalidTruth(message: string, cause?: unknown): ByokKeysError {
  return new ByokKeysError('PROVIDER_TRUTH_INVALID', message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
