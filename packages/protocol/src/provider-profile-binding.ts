import { z } from 'zod';

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

/** Hash of the normalized, non-secret local profile projection. */
export const ProviderProfileHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'provider profile hash must be lowercase sha256');

export const PROVIDER_MODEL_CAPABILITIES = ['image-input'] as const;
export const ProviderModelCapabilitySchema = z.enum(PROVIDER_MODEL_CAPABILITIES);
export type ProviderModelCapability = z.infer<typeof ProviderModelCapabilitySchema>;

/** Credential-free exact desired binding. Endpoint and auth material stay device-local. */
export const ProviderProfileBindingSchema = z
  .object({
    profileRef: ProviderProfileRefSchema,
    profileRevision: ProviderProfileRevisionSchema,
    profileHash: ProviderProfileHashSchema,
    requiredCapabilities: z.array(ProviderModelCapabilitySchema).max(8),
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (new Set(binding.requiredCapabilities).size !== binding.requiredCapabilities.length) {
      ctx.addIssue({ code: 'custom', path: ['requiredCapabilities'], message: 'duplicate provider capability' });
    }
  });
export type ProviderProfileBinding = z.infer<typeof ProviderProfileBindingSchema>;
