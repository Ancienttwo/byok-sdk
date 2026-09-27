import { z } from 'zod';
import {
  ProviderModelCapabilitySchema,
  ProviderProfileBindingSchema,
  ProviderProfileRefSchema,
} from './provider-profile-binding';

/**
 * Sealed provider provisioning — the wire half.
 *
 * A Host provisions a device-local provider profile (and its API key) without
 * the key ever crossing this SDK's wire. The ciphertext, its configuration and
 * the device's pull of both travel over the HOST's own authenticated device
 * routes; this package defines only:
 *
 * - the task-free server -> daemon notice `provider.provisioning.available`,
 *   whose payload is exactly `{ requestId }` (see `messages.ts`);
 * - the device capability that gates that notice;
 * - the credential-free completion a device reports and the durable readback a
 *   Host returns for it;
 * - the device-proof operation name a device signs when it registers its
 *   provider-secret sealing key.
 *
 * Notice-and-fetch is the point: the daemon journals mailbox rows before they
 * are acknowledged and a mailbox never deletes an unacknowledged row, so a
 * ciphertext carried inside the envelope would outlive the provisioning window
 * in two places. The strict one-field payload makes that unrepresentable.
 *
 * Audiences, route paths and product names are Host vocabulary and stay out of
 * this package.
 */

/** Device capability required before a Host may enqueue `provider.provisioning.available`. */
export const PROVIDER_PROVISIONING_CAPABILITY = 'provider-provisioning.v1' as const;

/**
 * Device-proof `operation` for the signed claim that registers the device's
 * provider-secret sealing public key (`{ keyId, epoch, publicJwk }`).
 */
export const PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION = 'provider-secret-sealing-key.register' as const;

/**
 * Server -> daemon: a provisioning request is waiting for this device.
 *
 * `.strict()` and exactly one field. There is deliberately no configuration,
 * no ciphertext, no provider identity and no Agent identity: the device fetches
 * all of that from the Host under its own device authentication, so a mailbox
 * row or journal line never holds more than an opaque request id.
 */
export const ProviderProvisioningAvailablePayloadSchema = z
  .object({
    requestId: z.uuid(),
  })
  .strict();
export type ProviderProvisioningAvailablePayload = z.infer<typeof ProviderProvisioningAvailablePayloadSchema>;

export const PROVIDER_PROVISIONING_OPERATIONS = ['configure', 'update_model', 'replace_secret', 'delete'] as const;
export const ProviderProvisioningOperationSchema = z.enum(PROVIDER_PROVISIONING_OPERATIONS);
export type ProviderProvisioningOperation = z.infer<typeof ProviderProvisioningOperationSchema>;

/** PostgreSQL BIGINT maximum, carried as decimal text to avoid JavaScript precision loss. */
export const PROVIDER_PROVISIONING_OPERATION_GENERATION_MAXIMUM = '9223372036854775807' as const;

/**
 * Non-secret, monotonic per-profile operation generation. It is bound into the
 * sealed request's associated data and into the device's local state, so an
 * older generation is always refused. Canonical positive decimal text.
 */
export const ProviderProvisioningOperationGenerationSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u, 'operationGeneration must be a canonical positive decimal string')
  .refine(
    (value) =>
      value.length < PROVIDER_PROVISIONING_OPERATION_GENERATION_MAXIMUM.length ||
      value <= PROVIDER_PROVISIONING_OPERATION_GENERATION_MAXIMUM,
    `operationGeneration must not exceed ${PROVIDER_PROVISIONING_OPERATION_GENERATION_MAXIMUM}`,
  );
export type ProviderProvisioningOperationGeneration = z.infer<typeof ProviderProvisioningOperationGenerationSchema>;

/**
 * SHA-256 of the canonical non-secret operation the device evaluated. Two
 * completions for one request id are the same result only when this digest
 * (and the rest of the completion) is identical.
 */
export const ProviderProvisioningOperationDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'operationDigest must be lowercase sha256');
export type ProviderProvisioningOperationDigest = z.infer<typeof ProviderProvisioningOperationDigestSchema>;

/**
 * Closed rejection set. Codes name a failed check, never a value: no plaintext,
 * no ciphertext, no OS error detail.
 *
 * `request_expired` and `sealing_key_rotated` may also be decided by the Host
 * before the device ever completes the request (see
 * {@link PROVIDER_PROVISIONING_HOST_TERMINAL_CODES}).
 */
export const PROVIDER_PROVISIONING_REJECTION_CODES = [
  'request_expired',
  'request_window_invalid',
  'sealing_key_rotated',
  'enrollment_mismatch',
  'agent_not_placed',
  'config_digest_mismatch',
  'operation_generation_stale',
  'profile_changed',
  'profile_not_found',
  'credential_scope_mismatch',
  'provider_kind_unsupported',
  'pi_model_invalid',
  'seal_open_failed',
  'secret_invalid',
  'local_commit_interrupted',
  'secret_store_unavailable',
] as const;
export const ProviderProvisioningRejectionCodeSchema = z.enum(PROVIDER_PROVISIONING_REJECTION_CODES);
export type ProviderProvisioningRejectionCode = z.infer<typeof ProviderProvisioningRejectionCodeSchema>;

/** Rejections a Host may record on its own authority, without a device completion. */
export const PROVIDER_PROVISIONING_HOST_TERMINAL_CODES = ['request_expired', 'sealing_key_rotated'] as const satisfies
  readonly ProviderProvisioningRejectionCode[];

/**
 * Credential-free projection of the device's provider status after an applied
 * operation. It reports WHETHER a secret is configured, never the secret, and
 * carries no endpoint or auth material: those stay device-local.
 */
export const ProviderProvisioningProviderStatusSchema = z
  .object({
    profileRef: ProviderProfileRefSchema,
    providerKind: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'providerKind must be a lowercase portable identifier'),
    modelId: z.string().min(1).max(160).regex(/^[^\u0000\r\n]+$/u),
    capabilities: z.array(ProviderModelCapabilitySchema).max(8),
    secretConfigured: z.boolean(),
  })
  .strict()
  .superRefine((status, ctx) => {
    if (new Set(status.capabilities).size !== status.capabilities.length) {
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'duplicate provider capability' });
    }
  });
export type ProviderProvisioningProviderStatus = z.infer<typeof ProviderProvisioningProviderStatusSchema>;

/**
 * Closed outcome set of the device's one post-apply check of the stored key
 * against its vendor. It is a HINT for the Host UI, never a readiness input:
 * a saved key is not a validated key, and a network failure does not block
 * provisioning.
 *
 * - `credential_rejected`: the vendor explicitly refused the credential.
 * - `rate_limited`, `quota_or_billing`, `model_not_permitted`: the credential
 *   was accepted but the call could not be served for that reason.
 * - `unreachable`, `timeout`: no vendor answer within the device's bounds.
 * - `not_run`: no check was made (for example `delete`, or an endpoint without
 *   credential auth).
 *
 * No vendor text, status body or error detail crosses this boundary.
 */
export const PROVIDER_PROVISIONING_KEY_CHECK_RESULTS = [
  'ok',
  'credential_rejected',
  'rate_limited',
  'quota_or_billing',
  'model_not_permitted',
  'unreachable',
  'timeout',
  'not_run',
] as const;
export const ProviderProvisioningKeyCheckResultSchema = z.enum(PROVIDER_PROVISIONING_KEY_CHECK_RESULTS);
export type ProviderProvisioningKeyCheckResult = z.infer<typeof ProviderProvisioningKeyCheckResultSchema>;

export const ProviderProvisioningKeyCheckSchema = z
  .object({
    result: ProviderProvisioningKeyCheckResultSchema,
  })
  .strict();
export type ProviderProvisioningKeyCheck = z.infer<typeof ProviderProvisioningKeyCheckSchema>;

const completionIdentity = {
  requestId: z.uuid(),
  operation: ProviderProvisioningOperationSchema,
  operationGeneration: ProviderProvisioningOperationGenerationSchema,
  operationDigest: ProviderProvisioningOperationDigestSchema,
} as const;

const AppliedCompletionSchema = z
  .object({
    outcome: z.literal('applied'),
    ...completionIdentity,
    providerStatus: ProviderProvisioningProviderStatusSchema.nullable(),
    binding: ProviderProfileBindingSchema.nullable(),
    keyCheck: ProviderProvisioningKeyCheckSchema,
  })
  .strict();

const RejectedCompletionSchema = z
  .object({
    outcome: z.literal('rejected'),
    ...completionIdentity,
    code: ProviderProvisioningRejectionCodeSchema,
  })
  .strict();

/**
 * The terminal, credential-free result of one provisioning request, reported
 * by the device to the Host.
 *
 * `applied` carries the post-operation status and exact binding — both absent
 * (`null`) for `delete` and only for `delete`. `configure` and
 * `replace_secret` write a secret, so an applied result for either must report
 * `secretConfigured: true`. `replace_secret` leaves the profile revision and
 * hash unchanged; the binding it reports is the same exact binding as before.
 * Every applied result carries the required `keyCheck` hint; a `delete` has no
 * key left to check and must report `not_run`.
 */
export const ProviderProvisioningCompletionSchema = z
  .discriminatedUnion('outcome', [AppliedCompletionSchema, RejectedCompletionSchema])
  .superRefine((completion, ctx) => {
    if (completion.outcome !== 'applied') return;
    const { operation, providerStatus, binding } = completion;
    if (operation === 'delete') {
      if (completion.keyCheck.result !== 'not_run') {
        ctx.addIssue({ code: 'custom', path: ['keyCheck', 'result'], message: 'an applied delete must report keyCheck not_run' });
      }
      if (providerStatus !== null) {
        ctx.addIssue({ code: 'custom', path: ['providerStatus'], message: 'an applied delete reports no provider status' });
      }
      if (binding !== null) {
        ctx.addIssue({ code: 'custom', path: ['binding'], message: 'an applied delete reports no binding' });
      }
      return;
    }
    if (providerStatus === null) {
      ctx.addIssue({ code: 'custom', path: ['providerStatus'], message: `an applied ${operation} must report provider status` });
    }
    if (binding === null) {
      ctx.addIssue({ code: 'custom', path: ['binding'], message: `an applied ${operation} must report its exact binding` });
    }
    if (providerStatus === null || binding === null) return;
    if (providerStatus.profileRef !== binding.profileRef) {
      ctx.addIssue({ code: 'custom', path: ['binding', 'profileRef'], message: 'binding profileRef must equal providerStatus profileRef' });
    }
    if (providerStatus.modelId !== binding.modelId) {
      ctx.addIssue({ code: 'custom', path: ['binding', 'modelId'], message: 'binding modelId must equal providerStatus modelId' });
    }
    if ((operation === 'configure' || operation === 'replace_secret') && !providerStatus.secretConfigured) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerStatus', 'secretConfigured'],
        message: `an applied ${operation} must report a configured secret`,
      });
    }
  });
export type ProviderProvisioningCompletion = z.infer<typeof ProviderProvisioningCompletionSchema>;

/**
 * How the Host's durable record relates to the completion it was handed:
 *
 * - `recorded`: this completion became the request's first terminal fact.
 * - `idempotent`: an identical completion (same operation digest and result)
 *   was already recorded; the stored result is returned and nothing is
 *   rewritten.
 * - `conflict`: a different completion (different operation digest or result)
 *   is already recorded; the stored one is returned unchanged.
 * - `host_terminal`: the Host had already terminated the request on its own
 *   authority ({@link PROVIDER_PROVISIONING_HOST_TERMINAL_CODES}), for example
 *   because it expired before the device fetched it.
 */
export const PROVIDER_PROVISIONING_DISPOSITIONS = ['recorded', 'idempotent', 'conflict', 'host_terminal'] as const;
export const ProviderProvisioningDispositionSchema = z.enum(PROVIDER_PROVISIONING_DISPOSITIONS);
export type ProviderProvisioningDisposition = z.infer<typeof ProviderProvisioningDispositionSchema>;

/**
 * The Host's durable terminal readback for one provisioning request.
 *
 * `completion` is the terminal fact the Host has STORED, which on `conflict`
 * is not the one the device submitted. Every readback is terminal — there is
 * no `pending` — so a daemon that holds one may acknowledge the notice: an
 * expired, rotated, rejected or conflicting request is a deterministic end
 * state that no redelivery can change.
 */
export const ProviderProvisioningReadbackSchema = z
  .object({
    tenantId: z.string().min(1),
    deviceId: z.string().min(1),
    requestId: z.uuid(),
    disposition: ProviderProvisioningDispositionSchema,
    completion: ProviderProvisioningCompletionSchema,
    completedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((readback, ctx) => {
    if (readback.completion.requestId !== readback.requestId) {
      ctx.addIssue({ code: 'custom', path: ['completion', 'requestId'], message: 'completion requestId must equal readback requestId' });
    }
    if (
      readback.disposition === 'host_terminal' &&
      (readback.completion.outcome !== 'rejected' ||
        !(PROVIDER_PROVISIONING_HOST_TERMINAL_CODES as readonly string[]).includes(readback.completion.code))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion'],
        message: `a host_terminal readback must carry a rejected completion with one of: ${PROVIDER_PROVISIONING_HOST_TERMINAL_CODES.join(', ')}`,
      });
    }
  });
export type ProviderProvisioningReadback = z.infer<typeof ProviderProvisioningReadbackSchema>;
