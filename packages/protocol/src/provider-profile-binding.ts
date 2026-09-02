import { z } from 'zod';

/** Daemon capability required before an exact local provider profile may be offered. */
export const PROVIDER_PROFILE_BINDING_CAPABILITY = 'provider-profile-binding' as const;

/** Opaque, portable local profile identity. It is one logical id, never a path. */
export const ProviderProfileRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u, 'provider profile refs must be lowercase portable identifiers');
export type ProviderProfileRef = z.infer<typeof ProviderProfileRefSchema>;

/** Monotonic local profile revision represented canonically on the wire. */
export const ProviderProfileRevisionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u, 'provider profile revision must be canonical decimal');
export type ProviderProfileRevision = z.infer<typeof ProviderProfileRevisionSchema>;

/** Hash of the normalized, non-secret local profile projection. */
export const ProviderProfileHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'provider profile hash must be lowercase sha256');
export type ProviderProfileHash = z.infer<typeof ProviderProfileHashSchema>;

export const PROVIDER_MODEL_CAPABILITIES = ['image-input'] as const;
export const ProviderModelCapabilitySchema = z.enum(PROVIDER_MODEL_CAPABILITIES);
export type ProviderModelCapability = z.infer<typeof ProviderModelCapabilitySchema>;

/** Credential-free exact desired binding. Endpoint and auth material stay device-local. */
export const ProviderProfileBindingSchema = z
  .object({
    profileRef: ProviderProfileRefSchema,
    profileRevision: ProviderProfileRevisionSchema,
    profileHash: ProviderProfileHashSchema,
    modelId: z.string().min(1).max(160).regex(/^[^\u0000\r\n]+$/u),
    requiredCapabilities: z.array(ProviderModelCapabilitySchema).max(8),
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (new Set(binding.requiredCapabilities).size !== binding.requiredCapabilities.length) {
      ctx.addIssue({ code: 'custom', path: ['requiredCapabilities'], message: 'duplicate provider capability' });
    }
  });
export type ProviderProfileBinding = z.infer<typeof ProviderProfileBindingSchema>;
