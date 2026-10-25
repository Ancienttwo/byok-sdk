import { createHash } from 'node:crypto';

import { ByokKeysError } from './errors';
import {
  parseModelProviderProfile,
  type ModelProviderProfile,
  type ProviderModelCapability,
  type ProviderProfileRef,
} from './provider-profile';

export interface ExactProviderProfileBinding {
  profileRef: ProviderProfileRef;
  profileRevision: string;
  profileHash: string;
  modelId: string;
  requiredCapabilities: readonly ProviderModelCapability[];
}

/**
 * Derive the credential-free wire identity from the normalized local record.
 * `updated_at` is the persisted monotonic revision authority; the hash covers
 * the complete normalized non-secret record with capability order
 * canonicalized. Secret values are not accepted by this type and therefore
 * cannot enter the digest or any mismatch message.
 */
export function exactProviderProfileBinding(
  profileInput: ModelProviderProfile,
  requiredCapabilities: readonly ProviderModelCapability[] = profileInput.capabilities,
): ExactProviderProfileBinding {
  const profile = parseModelProviderProfile(profileInput);
  const revision = Date.parse(profile.updated_at);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      'Provider updated_at cannot be represented as a canonical revision',
    );
  }
  const normalizedCapabilities = [...profile.capabilities].sort();
  const canonical = JSON.stringify({
    adapter: profile.adapter,
    auth_mode: profile.auth_mode,
    base_url: profile.base_url,
    capabilities: normalizedCapabilities,
    kind: profile.kind,
    model: profile.model,
    ...(profile.pi_model === undefined ? {} : { pi_model: profile.pi_model }),
    profile_ref: profile.profile_ref,
    provider_kind: profile.provider_kind,
  });
  return {
    profileRef: profile.profile_ref,
    profileRevision: String(revision),
    profileHash: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    modelId: profile.model,
    requiredCapabilities: [...requiredCapabilities],
  };
}

/** Fail closed unless every offered binding field matches local authority. */
export function assertExactProviderProfileBinding(
  profile: ModelProviderProfile,
  expected: ExactProviderProfileBinding,
): void {
  if (new Set(expected.requiredCapabilities).size !== expected.requiredCapabilities.length) {
    throw new Error('provider profile required capabilities must be unique');
  }
  const actual = exactProviderProfileBinding(profile, expected.requiredCapabilities);
  if (actual.profileRef !== expected.profileRef) throw new Error('provider profile ref mismatch');
  if (actual.profileRevision !== expected.profileRevision) throw new Error('provider profile revision mismatch');
  if (actual.profileHash !== expected.profileHash) throw new Error('provider profile hash mismatch');
  if (actual.modelId !== expected.modelId) throw new Error('provider profile model mismatch');
  const supported = new Set(profile.capabilities);
  const unsupported = expected.requiredCapabilities.find((capability) => !supported.has(capability));
  if (unsupported !== undefined) throw new Error(`provider profile does not support required capability ${unsupported}`);
}
