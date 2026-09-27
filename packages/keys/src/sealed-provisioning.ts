import {
  PROVIDER_PROVISIONING_MAX_TTL_MS,
  assertProviderProvisioningConfigDigest,
  openProviderProvisioningSecret,
  parseProviderProvisioningRequest,
  providerProvisioningRequestDigest,
  type ProviderProvisioningRequestV1,
} from '@byok-sdk/core';

import {
  type ProviderCustodyReceipt,
  type ProviderProvisioningBinding,
  type ProviderProvisioningRejection,
  type ProviderProvisioningResult,
  withConfigurationLock,
} from './custody';
import type { DeviceSealingEnrollment, DeviceSealingKey } from './device-sealing-key';
import { ByokKeysError } from './errors';
import { PiModelConfigSchema } from './pi-model-config';
import { modelProviderVendor } from './provider-catalog';
import { checkProviderKey, type ProviderKeyCheckOptions } from './provider-key-check';
import {
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  exactProviderProfileBinding,
  type ModelProviderProfile,
  type ProviderProfileRef,
} from './provider-profile';
import type { ProviderProfileStore } from './profile-store';
import { buildConfiguredProfile } from './registry';
import {
  type ModelProviderSecretName,
  type SecretStore,
  assertSharedSecretValue,
  modelProviderSecretName,
} from './secret-store';
import { normalizeProviderUrl } from './url';

/** Largest issuedAt-in-the-future a device tolerates (bounded clock skew, A9). */
export const PROVIDER_PROVISIONING_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The smaller of the two OS backends' secret ceilings (Windows Credential
 * Manager: 2560 UTF-8 bytes), so a too-large key is a deterministic rejection
 * on every platform instead of a store failure that leaves a pending marker.
 */
export const PROVIDER_PROVISIONING_SECRET_MAX_BYTES = 2560;

/** Persistence cut points of one applied operation, in order. */
export type ProviderProvisioningCutPoint = 'after-pending' | 'after-secret-write' | 'after-commit';

/** Test-only seam: invoked at each cut point so crash tests can kill the process there. */
export interface ProviderProvisioningFaultSeam {
  onCutPoint?(point: ProviderProvisioningCutPoint): void | Promise<void>;
}

export interface ApplySealedProviderProvisioningOptions {
  /** The untrusted request exactly as fetched from the Host. */
  readonly request: unknown;
  readonly profileStore: ProviderProfileStore;
  readonly secretStore: SecretStore<ModelProviderSecretName>;
  /** This device's current sealing key (`DeviceSealingKeyStore.loadOrCreate`). */
  readonly sealingKey: DeviceSealingKey;
  /** This device's current enrollment identity, supplied by the host. */
  readonly enrollment: DeviceSealingEnrollment;
  /** Host glue: the local provider profile ref a bot's agent id maps to. */
  readonly resolveProfileRef: (agentId: string) => ProviderProfileRef;
  /** Host glue: whether the agent is placed on this device right now. */
  readonly isPlacedHere: (agentId: string) => Promise<boolean>;
  readonly now: () => Date;
  /** When present, one bounded key check runs after an applied operation; otherwise `not_run`. */
  readonly keyCheck?: ProviderKeyCheckOptions;
  readonly faults?: ProviderProvisioningFaultSeam;
}

interface RequestFacts {
  readonly requestId: string;
  readonly operation: ProviderProvisioningRequestV1['header']['operation'];
  readonly operationGeneration: number;
}

function rejectedResult(
  facts: RequestFacts | undefined,
  profileRef: ProviderProfileRef | null,
  code: ProviderProvisioningRejection,
): ProviderProvisioningResult {
  return {
    requestId: facts?.requestId ?? null,
    operation: facts?.operation ?? null,
    operationGeneration: facts?.operationGeneration ?? null,
    outcome: 'rejected',
    code,
    profileRef,
    binding: null,
    secretConfigured: null,
    keyCheck: 'not_run',
  };
}

function bindingOf(profile: ModelProviderProfile): ProviderProvisioningBinding {
  const binding = exactProviderProfileBinding(profile, []);
  return {
    profileRef: binding.profileRef,
    profileRevision: binding.profileRevision,
    profileHash: binding.profileHash,
    modelId: binding.modelId,
  };
}

const SAFE_PASSTHROUGH_CODES = new Set([
  'PROVIDER_CONFIGURATION_BUSY',
  'PROVIDER_CONFIGURATION_PENDING',
  'PROVIDER_CUSTODY_STATE_INVALID',
  'PROVIDER_STORE_SCHEMA_STALE',
  'PROVIDER_STORE_UNAVAILABLE',
  'PROVIDER_PROFILE_INVALID',
]);

/**
 * Credential-store calls are wrapped so no OS error text, exit code, or cause
 * can reach a status, receipt, log, or thrown message.
 */
async function credentialStoreCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new ByokKeysError('PROVIDER_SECRET_STORE_FAILED', 'Provider credential store operation failed');
  }
}

type Decision =
  | { readonly kind: 'reject'; readonly code: ProviderProvisioningRejection }
  | {
    readonly kind: 'apply';
    readonly mutation: { readonly kind: 'save'; readonly profile: ModelProviderProfile } | { readonly kind: 'delete' } | { readonly kind: 'none' };
    readonly credential: { readonly kind: 'set'; readonly secret: string } | { readonly kind: 'delete' } | { readonly kind: 'keep' };
    readonly bindingProfile: ModelProviderProfile | undefined;
  };

/**
 * Apply one sealed provider provisioning request on the device (plan §3.4,
 * D4, D5, D8, A3, A4, A7, A9).
 *
 * Returns a credential-free result for every deterministic outcome — applied
 * or rejected with a closed-set code — and throws a `ByokKeysError` only for
 * transient infrastructure failures (lock busy, credential store failure),
 * which the host retries by keeping the notice undelivered.
 *
 * Order of checks: request schema; enrollment; sealing key id; placement;
 * config digest; HPKE open (authenticates every header field). Then, under
 * the configuration lock: a known request id returns its stored result (same
 * digest) or `request_conflict`; a generation at or below the profile's
 * watermark is `operation_generation_stale`. Every decision after that consumes the
 * generation and is recorded as a receipt: time window, catalog/pi_model,
 * expected provider triple, pending state, credential scope. An applied
 * operation marks pending, performs its credential-store step, then commits
 * profile + receipt + watermark and clears pending in one store transaction.
 */
export async function applySealedProviderProvisioning(
  options: ApplySealedProviderProvisioningOptions,
): Promise<ProviderProvisioningResult> {
  let request: ProviderProvisioningRequestV1;
  try {
    request = parseProviderProvisioningRequest(options.request);
  } catch {
    return rejectedResult(undefined, null, 'request_invalid');
  }
  const { header, sealed } = request;
  const facts: RequestFacts = {
    requestId: header.requestId,
    operation: header.operation,
    operationGeneration: header.operationGeneration,
  };

  if (header.tenantId !== options.enrollment.tenantId || header.deviceId !== options.enrollment.deviceId) {
    return rejectedResult(facts, null, 'enrollment_mismatch');
  }
  if (sealed !== undefined && (
    sealed.keyId !== options.sealingKey.keyId
    || options.sealingKey.enrollment.tenantId !== options.enrollment.tenantId
    || options.sealingKey.enrollment.deviceId !== options.enrollment.deviceId
  )) {
    return rejectedResult(facts, null, 'sealing_key_rotated');
  }
  if (!(await options.isPlacedHere(header.agentId))) {
    return rejectedResult(facts, null, 'agent_not_placed');
  }
  const refResult = ProviderProfileRefSchema.safeParse(options.resolveProfileRef(header.agentId));
  if (!refResult.success) {
    throw new ByokKeysError('PROVIDER_PROFILE_INVALID', 'Host profile ref resolver returned an invalid provider profile ref');
  }
  const profileRef = refResult.data;
  try {
    await assertProviderProvisioningConfigDigest(request);
  } catch {
    return rejectedResult(facts, profileRef, 'config_digest_mismatch');
  }
  let secret: string | undefined;
  if (sealed !== undefined) {
    try {
      secret = await openProviderProvisioningSecret({ request, recipient: options.sealingKey });
    } catch {
      return rejectedResult(facts, profileRef, 'seal_open_failed');
    }
  }
  const requestDigest = await providerProvisioningRequestDigest(request);
  const { profileStore: profiles, secretStore: secrets } = options;
  const secretName = modelProviderSecretName(profileRef);
  const fault = async (point: ProviderProvisioningCutPoint): Promise<void> => {
    await options.faults?.onCutPoint?.(point);
  };

  let replayed = false;
  let result: ProviderProvisioningResult;
  try {
    result = await withConfigurationLock(profiles, async () => {
      const receipt = await profiles.getReceipt(header.requestId);
      if (receipt !== undefined) {
        if (receipt.requestDigest !== requestDigest) return rejectedResult(facts, profileRef, 'request_conflict');
        replayed = true;
        return receipt.result;
      }
      const watermark = await profiles.getOperationWatermark(profileRef);
      if (watermark !== undefined && header.operationGeneration <= watermark) {
        return rejectedResult(facts, profileRef, 'operation_generation_stale');
      }

      // Every decision from here on consumes the generation and is recorded.
      const recordRejection = async (code: ProviderProvisioningRejection): Promise<ProviderProvisioningResult> => {
        const rejected = rejectedResult(facts, profileRef, code);
        await profiles.commitCustody({
          profileRef,
          mutation: { kind: 'none' },
          receipt: receiptOf(facts, profileRef, requestDigest, rejected),
          // A marker (this call's or an earlier one) means the credential
          // state is uncertain; a rejection never clears it.
          clearPending: false,
        });
        return rejected;
      };
      const decision = await decide(request, profileRef, secret, options);
      if (decision.kind === 'reject') return recordRejection(decision.code);
      if (decision.credential.kind !== 'keep' && !(await secrets.available())) {
        return recordRejection('secret_store_unavailable');
      }

      await profiles.markPending({
        profileRef,
        operation: header.operation,
        requestId: header.requestId,
        operationGeneration: header.operationGeneration,
        since: options.now().toISOString(),
      });
      await fault('after-pending');
      try {
        if (decision.credential.kind === 'set') {
          const value = decision.credential.secret;
          await credentialStoreCall(() => secrets.set(secretName, value));
        } else if (decision.credential.kind === 'delete') {
          await credentialStoreCall(() => secrets.delete(secretName));
        }
      } catch {
        // The OS write may or may not have happened: the marker stays, and
        // only a new key submission can resolve it.
        return recordRejection('secret_store_unavailable');
      }
      await fault('after-secret-write');
      const secretConfigured = decision.credential.kind === 'set'
        ? true
        : decision.credential.kind === 'delete'
          ? false
          : await credentialStoreCall(() => secrets.has(secretName));
      const applied: ProviderProvisioningResult = {
        ...facts,
        outcome: 'applied',
        code: null,
        profileRef,
        binding: decision.bindingProfile === undefined ? null : bindingOf(decision.bindingProfile),
        secretConfigured,
        keyCheck: 'not_run',
      };
      await profiles.commitCustody({
        profileRef,
        mutation: decision.mutation,
        receipt: receiptOf(facts, profileRef, requestDigest, applied),
        clearPending: true,
      });
      await fault('after-commit');
      return applied;
    });
  } catch (error) {
    if (error instanceof ByokKeysError && (SAFE_PASSTHROUGH_CODES.has(error.code) || error.code === 'PROVIDER_SECRET_STORE_FAILED')) {
      throw error;
    }
    throw new ByokKeysError('PROVIDER_CUSTODY_STATE_INVALID', 'Provider provisioning could not complete its local commit');
  } finally {
    secret = undefined;
  }

  if (
    options.keyCheck === undefined
    || replayed
    || result.outcome !== 'applied'
    || result.operation === 'delete'
    || result.binding === null
  ) {
    return result;
  }
  return runKeyCheck(result, profileRef, secretName, options);
}

function receiptOf(
  facts: RequestFacts,
  profileRef: ProviderProfileRef,
  requestDigest: string,
  result: ProviderProvisioningResult,
): ProviderCustodyReceipt {
  return {
    requestId: facts.requestId,
    profileRef,
    operationGeneration: facts.operationGeneration,
    requestDigest,
    result,
  };
}

async function decide(
  request: ProviderProvisioningRequestV1,
  profileRef: ProviderProfileRef,
  secret: string | undefined,
  options: ApplySealedProviderProvisioningOptions,
): Promise<Decision> {
  const { header, config } = request;
  const reject = (code: ProviderProvisioningRejection): Decision => ({ kind: 'reject', code });

  const now = options.now().getTime();
  const issuedAt = Date.parse(header.issuedAt);
  const expiresAt = Date.parse(header.expiresAt);
  const ttl = expiresAt - issuedAt;
  if (!(ttl > 0) || ttl > PROVIDER_PROVISIONING_MAX_TTL_MS) return reject('request_window_invalid');
  if (issuedAt > now + PROVIDER_PROVISIONING_MAX_CLOCK_SKEW_MS) return reject('request_not_yet_valid');
  if (now > expiresAt) return reject('request_expired');

  const vendor = config.operation === 'delete' ? undefined : modelProviderVendor(config.providerKind);
  if (config.operation !== 'delete' && vendor === undefined) return reject('provider_kind_unsupported');

  const current = await options.profileStore.get(profileRef);
  const pending = await options.profileStore.getPending(profileRef);
  const expected = header.expectedProfile;
  if (expected === null) {
    if (current !== undefined) return reject('profile_changed');
  } else {
    if (current === undefined) return reject('profile_changed');
    const binding = exactProviderProfileBinding(current, []);
    if (
      binding.profileRef !== expected.profileRef
      || binding.profileRevision !== expected.profileRevision
      || binding.profileHash !== expected.profileHash
    ) {
      return reject('profile_changed');
    }
  }
  if (pending !== undefined && pending.requestId === header.requestId) return reject('local_commit_interrupted');

  if (secret !== undefined) {
    try {
      assertSharedSecretValue(secret);
    } catch {
      return reject('secret_invalid');
    }
    if (new TextEncoder().encode(secret).byteLength > PROVIDER_PROVISIONING_SECRET_MAX_BYTES) return reject('secret_invalid');
  }

  switch (config.operation) {
    case 'delete':
      return {
        kind: 'apply',
        mutation: current === undefined ? { kind: 'none' } : { kind: 'delete' },
        credential: { kind: 'delete' },
        bindingProfile: undefined,
      };
    case 'replace_secret': {
      if (current === undefined) return reject('profile_not_found');
      if (!sameCredentialScope(current, config.providerKind, vendor!)) return reject('credential_scope_mismatch');
      return { kind: 'apply', mutation: { kind: 'none' }, credential: { kind: 'set', secret: secret! }, bindingProfile: current };
    }
    case 'configure':
    case 'update_model': {
      if (config.operation === 'update_model') {
        if (pending !== undefined) return reject('local_commit_interrupted');
        if (current === undefined) return reject('profile_not_found');
      }
      const piModel = PiModelConfigSchema.safeParse(config.piModel);
      if (!piModel.success) return reject('pi_model_invalid');
      const capabilities = ProviderModelCapabilitySchema.array().max(8).safeParse(config.capabilities);
      if (!capabilities.success) return reject('capabilities_invalid');
      let candidate: ModelProviderProfile;
      try {
        candidate = buildConfiguredProfile(current, {
          profile_ref: profileRef,
          provider_kind: config.providerKind as ModelProviderProfile['provider_kind'],
          adapter: vendor!.adapter,
          auth_mode: vendor!.auth_mode,
          base_url: vendor!.base_url,
          display_name: vendor!.display_name,
          model: config.modelId,
          pi_model: piModel.data,
          capabilities: capabilities.data,
          enabled: current?.enabled ?? false,
        }, options.now);
      } catch {
        return reject('pi_model_invalid');
      }
      if (config.operation === 'update_model') {
        // A7: the stored key stays only when the credential scope is exactly
        // unchanged — same kind, endpoint, auth mode and adapter as the old
        // record, whatever the catalog says today.
        if (!sameCredentialScope(current!, config.providerKind, candidate)) return reject('credential_scope_mismatch');
        return { kind: 'apply', mutation: { kind: 'save', profile: candidate }, credential: { kind: 'keep' }, bindingProfile: candidate };
      }
      return { kind: 'apply', mutation: { kind: 'save', profile: candidate }, credential: { kind: 'set', secret: secret! }, bindingProfile: candidate };
    }
  }
}

/** Exact credential scope equality between a stored record and a catalog-derived target. */
function sameCredentialScope(
  current: ModelProviderProfile,
  providerKind: string,
  target: { readonly base_url: string; readonly adapter: string; readonly auth_mode: string },
): boolean {
  let targetUrl: string;
  try {
    // Profiles persist normalized URLs; compare in the same form.
    targetUrl = normalizeProviderUrl(target.base_url);
  } catch {
    return false;
  }
  return current.provider_kind === providerKind
    && current.base_url === targetUrl
    && current.adapter === target.adapter
    && current.auth_mode === target.auth_mode
    && current.auth_mode !== 'none';
}

async function runKeyCheck(
  result: ProviderProvisioningResult,
  profileRef: ProviderProfileRef,
  secretName: ModelProviderSecretName,
  options: ApplySealedProviderProvisioningOptions,
): Promise<ProviderProvisioningResult> {
  const generation = result.operationGeneration!;
  const binding = result.binding!;
  const snapshot = await withConfigurationLock(options.profileStore, async () => {
    if ((await options.profileStore.getOperationWatermark(profileRef)) !== generation) return undefined;
    if ((await options.profileStore.getPending(profileRef)) !== undefined) return undefined;
    const profile = await options.profileStore.get(profileRef);
    if (profile === undefined) return undefined;
    const current = bindingOf(profile);
    if (current.profileRevision !== binding.profileRevision || current.profileHash !== binding.profileHash) return undefined;
    const key = await credentialStoreCall(() => options.secretStore.get(secretName));
    return key === undefined ? undefined : { profile, key };
  });
  if (snapshot === undefined) return result;
  const outcome = await checkProviderKey(snapshot.profile, snapshot.key, options.keyCheck);
  const recorded = await withConfigurationLock(options.profileStore, () =>
    options.profileStore.recordKeyCheck(result.requestId!, generation, outcome));
  return recorded ? { ...result, keyCheck: outcome } : result;
}
