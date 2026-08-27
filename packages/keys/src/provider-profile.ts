import { z } from 'zod';

import { ByokKeysError } from './errors';
import { normalizeProviderUrl } from './url';

/**
 * Opaque, portable identity of one locally configured provider profile.
 *
 * This is the profile's primary key: it is a local logical id, never a path,
 * and several profiles may share one {@link MODEL_PROVIDER_KINDS} kind (two
 * independent `custom` endpoints, for example). It replaces the former
 * `MODEL_PROVIDER_IDS` primary key, which conflated instance identity with
 * provider kind and therefore allowed exactly one profile per kind.
 *
 * `@byok-sdk/protocol` declares the same lexical rule for the wire form in
 * `provider-profile-binding.ts`. The two definitions are deliberately parallel
 * rather than shared: the release graph (`scripts/release/check-package-graph.mjs`)
 * forbids `@byok-sdk/keys` from depending on any dispatch package, so the
 * device-local authority cannot import the wire authority. This mirrors how
 * `packages/protocol/src/blob.ts`'s `CONTENT_HASH_RE` restates
 * `packages/core/src/blob.ts`'s content-hash format across the same boundary.
 */
export const PROVIDER_PROFILE_REF_PATTERN =
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;

export const ProviderProfileRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    PROVIDER_PROFILE_REF_PATTERN,
    'provider profile refs must be lowercase portable identifiers',
  );

export type ProviderProfileRef = z.infer<typeof ProviderProfileRefSchema>;

/**
 * Provider kinds this package knows how to address — the surviving half of the
 * former `MODEL_PROVIDER_IDS`. A kind says *what dialect family and vendor
 * shape* a profile is; {@link ProviderProfileRefSchema} says *which* profile.
 * Ported from `aip-main-open@c6a5385` `providers.ts:30-36`
 * (`LOCAL_MODEL_PROVIDER_IDS`).
 */
export const MODEL_PROVIDER_KINDS = [
  'openai',
  'deepseek',
  'anthropic',
  'custom',
] as const;

export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

/**
 * Bounded model capabilities a profile may declare. A capability is explicit
 * local configuration, never inferred from the model name or the base URL.
 */
export const PROVIDER_MODEL_CAPABILITIES = ['image-input'] as const;

export const ProviderModelCapabilitySchema = z.enum(PROVIDER_MODEL_CAPABILITIES);

export type ProviderModelCapability = z.infer<
  typeof ProviderModelCapabilitySchema
>;

/** Auth modes a provider profile can request (`providers.ts:29`). */
export const PROVIDER_AUTH_MODES = ['bearer', 'x_api_key', 'none'] as const;

export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

/**
 * Wire dialects. The source's `market_data` / `mcp_http` branch stays in
 * aip-main-open — this package ports the model branch only
 * (`providers.ts:38-61`, second union member).
 */
export const MODEL_PROVIDER_ADAPTERS = ['openai_compatible', 'anthropic'] as const;

export type ModelProviderAdapter = (typeof MODEL_PROVIDER_ADAPTERS)[number];

/**
 * Marker attached to schema issues so {@link parseModelProviderProfile} can
 * reproduce the source's distinct error codes: the URL guard reports
 * `PROVIDER_URL_INVALID`, everything else reports `PROVIDER_PROFILE_INVALID`.
 */
interface ProfileIssueParams {
  byokCode: string;
}

function boundedString(field: string, maximumLength: number) {
  return z
    .string()
    .superRefine((value, ctx) => {
      if (
        value.trim().length === 0 ||
        value.length > maximumLength ||
        /[\u0000\r\n]/u.test(value)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `Provider ${field} is invalid`,
        });
      }
    })
    .transform((value) => value.trim());
}

function isoTimestamp(field: string) {
  return boundedString(field, 64).superRefine((value, ctx) => {
    if (!Number.isFinite(Date.parse(value))) {
      ctx.addIssue({
        code: 'custom',
        message: `Provider ${field} must be an ISO timestamp`,
      });
    }
  });
}

const providerBaseUrl = z
  .string()
  .superRefine((value, ctx) => {
    try {
      normalizeProviderUrl(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message:
          error instanceof Error ? error.message : 'Provider base URL is invalid',
        params: {
          byokCode:
            error instanceof ByokKeysError ? error.code : 'PROVIDER_URL_INVALID',
        } satisfies ProfileIssueParams,
      });
    }
  })
  .transform((value) => normalizeProviderUrl(value));

/**
 * A model provider profile: everything needed to address a provider except the
 * secret itself, which lives in the OS credential store.
 *
 * The adapter/auth-mode legality rules are the ones `normalizeProviderProfile`
 * enforced imperatively at `providers.ts:1522-1543`, moved into the schema so
 * there is one validation authority rather than a schema plus a normalizer.
 */
export const ModelProviderProfileSchema = z
  .object({
    adapter: z.enum(MODEL_PROVIDER_ADAPTERS),
    auth_mode: z.enum(PROVIDER_AUTH_MODES),
    base_url: providerBaseUrl,
    capabilities: z.array(ProviderModelCapabilitySchema).max(8),
    created_at: isoTimestamp('created_at'),
    display_name: boundedString('display_name', 100),
    enabled: z.boolean(),
    kind: z.literal('model'),
    model: boundedString('model', 160),
    profile_ref: ProviderProfileRefSchema,
    provider_kind: z.enum(MODEL_PROVIDER_KINDS),
    updated_at: isoTimestamp('updated_at'),
  })
  .superRefine((profile, ctx) => {
    if (new Set(profile.capabilities).size !== profile.capabilities.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provider capabilities cannot repeat',
        path: ['capabilities'],
      });
    }
    if (profile.adapter === 'anthropic' && profile.auth_mode !== 'x_api_key') {
      ctx.addIssue({
        code: 'custom',
        message: 'Anthropic requires x_api_key authentication',
        path: ['auth_mode'],
      });
    }
    if (
      profile.adapter === 'openai_compatible' &&
      profile.auth_mode === 'x_api_key'
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'OpenAI-compatible providers support bearer or no authentication',
        path: ['auth_mode'],
      });
    }
    if (Date.parse(profile.updated_at) < Date.parse(profile.created_at)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provider updated_at cannot precede created_at',
        path: ['updated_at'],
      });
    }
  });

/** Validated, normalized profile. */
export type ModelProviderProfile = z.infer<typeof ModelProviderProfileSchema>;

/** Pre-normalization shape callers may hand in. */
export type ModelProviderProfileInput = z.input<typeof ModelProviderProfileSchema>;

/**
 * Parse and normalize a profile, or throw {@link ByokKeysError}. Replaces the
 * source's `normalizeProviderProfile` (`providers.ts:1489-1556`) for the model
 * branch, preserving its error codes.
 */
export function parseModelProviderProfile(value: unknown): ModelProviderProfile {
  const result = ModelProviderProfileSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const params = (issue as { params?: Partial<ProfileIssueParams> } | undefined)
    ?.params;
  throw new ByokKeysError(
    params?.byokCode ?? 'PROVIDER_PROFILE_INVALID',
    issue?.message ?? 'Provider profile is invalid',
    { cause: result.error },
  );
}
