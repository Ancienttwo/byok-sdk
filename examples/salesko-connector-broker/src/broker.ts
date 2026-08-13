import type { SecretStore } from '@byok-sdk/keys';
import { z } from 'zod';

export const CONNECTOR_BROKER_ERROR_CODES = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  CREDENTIAL_INVALID: 'CREDENTIAL_INVALID',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  CREDENTIAL_STORE_UNAVAILABLE: 'CREDENTIAL_STORE_UNAVAILABLE',
  REQUEST_INVALID: 'REQUEST_INVALID',
  DOMAIN_NOT_ALLOWED: 'DOMAIN_NOT_ALLOWED',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID',
  PROVIDER_POLICY_VIOLATION: 'PROVIDER_POLICY_VIOLATION',
} as const;

export type ConnectorBrokerErrorCode =
  (typeof CONNECTOR_BROKER_ERROR_CODES)[keyof typeof CONNECTOR_BROKER_ERROR_CODES];

/** Safe, bounded errors suitable for an MCP response. Raw provider errors are never attached. */
export class ConnectorBrokerError extends Error {
  constructor(
    public readonly code: ConnectorBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorBrokerError';
  }
}

const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u;

export const ConnectorProfileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROFILE_ID_PATTERN, 'profile ids must be lowercase logical identifiers');

function isValidDomain(value: string): boolean {
  if (value !== value.trim() || value !== value.toLowerCase() || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

export const EmailDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .refine(isValidDomain, 'email domains must be normalized lowercase DNS names');

function addDuplicateIssues(values: readonly string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      ctx.addIssue({ code: 'custom', path: [index], message: 'duplicate values are not allowed' });
    }
    seen.add(value);
  }
}

const DomainListSchema = z
  .array(EmailDomainSchema)
  .min(1)
  .max(16)
  .superRefine(addDuplicateIssues);

export const GmailConnectorPolicySchema = z
  .object({
    allowedDomains: z.array(EmailDomainSchema).min(1).max(64).superRefine(addDuplicateIssues),
    maxResults: z.number().int().min(1).max(25).default(10),
    maxAgeDays: z.number().int().min(1).max(365).default(90),
    providerTimeoutMs: z.number().int().min(250).max(60_000).default(10_000),
  })
  .strict();

export type GmailConnectorPolicyInput = z.input<typeof GmailConnectorPolicySchema>;
export type GmailConnectorPolicy = z.output<typeof GmailConnectorPolicySchema>;

export const GmailSearchInputSchema = z
  .object({
    domains: DomainListSchema,
    limit: z.number().int().min(1).max(25).optional(),
    newerThanDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export type GmailSearchInput = z.infer<typeof GmailSearchInputSchema>;

export const OAuthCredentialSchema = z
  .object({
    // Leaves room for the JSON envelope under Windows Credential Manager's
    // smaller byte ceiling instead of defining a macOS-only valid shape.
    accessToken: z.string().min(16).max(2_048).regex(/^[^\u0000-\u0020\u007f]+$/u),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

const OPAQUE_ID_SCHEMA = z.string().min(1).max(160).regex(/^[^\u0000\r\n]+$/u);
const DISPLAY_NAME_SCHEMA = z.string().min(1).max(160).regex(/^[^\u0000\r\n]+$/u);

function normalizedEmailDomain(value: string): string | undefined {
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator !== value.indexOf('@') || separator > 64) return undefined;
  const domain = value.slice(separator + 1);
  return isValidDomain(domain) ? domain : undefined;
}

export const NormalizedEmailAddressSchema = z
  .string()
  .min(3)
  .max(320)
  .refine((value) => normalizedEmailDomain(value) !== undefined, 'email addresses must have one normalized domain');

export const GmailCorrespondenceSchema = z
  .object({
    messageId: OPAQUE_ID_SCHEMA,
    threadId: OPAQUE_ID_SCHEMA.optional(),
    correspondent: z
      .object({
        email: NormalizedEmailAddressSchema,
        displayName: DISPLAY_NAME_SCHEMA.optional(),
      })
      .strict(),
    direction: z.enum(['inbound', 'outbound']),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type GmailCorrespondence = z.infer<typeof GmailCorrespondenceSchema>;

export interface GmailProviderSearchInput {
  /** Secret, process-local authority. Implementations must never log or return it. */
  readonly accessToken: string;
  readonly domains: readonly string[];
  readonly limit: number;
  readonly newerThanDays: number;
  /** Aborted when the broker's local provider deadline expires. */
  readonly signal: AbortSignal;
}

/**
 * Host-owned Gmail API seam. The broker owns credential/policy/output gates;
 * a downstream Salesko composition owns Google OAuth acquisition and API I/O.
 */
export interface GmailReadProvider {
  searchCorrespondence(input: GmailProviderSearchInput): Promise<unknown>;
}

export interface OAuthAccessTokenSource {
  withAccessToken<T>(profileId: string, use: (accessToken: string) => Promise<T>): Promise<T>;
}

export interface OAuthCredentialStatus {
  readonly state: 'missing' | 'invalid' | 'expired' | 'valid';
  readonly expiresAt?: string;
}

export const DEFAULT_MINIMUM_TOKEN_VALIDITY_MS = 30_000;
const GMAIL_OAUTH_SECRET_PREFIX = 'gmail-oauth-';

export function gmailOAuthSecretName(profileId: string): string {
  const parsed = ConnectorProfileIdSchema.safeParse(profileId);
  if (!parsed.success) throw new ConnectorBrokerError('CONFIG_INVALID', 'OAuth profile id is invalid');
  return `${GMAIL_OAUTH_SECRET_PREFIX}${parsed.data}`;
}

function resolveMinimumValidity(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MINIMUM_TOKEN_VALIDITY_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'minimum token validity must be a non-negative integer');
  }
  return resolved;
}

function parseStoredCredential(raw: string): OAuthCredential | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = OAuthCredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function provisionOAuthCredential(
  store: SecretStore<string>,
  profileId: string,
  credentialInput: unknown,
  options: { readonly clock?: () => number; readonly minimumValidityMs?: number } = {},
): Promise<void> {
  const parsed = OAuthCredentialSchema.safeParse(credentialInput);
  if (!parsed.success) {
    throw new ConnectorBrokerError('CREDENTIAL_INVALID', 'OAuth credential input is invalid');
  }
  const clock = options.clock ?? Date.now;
  const minimumValidityMs = resolveMinimumValidity(options.minimumValidityMs);
  if (Date.parse(parsed.data.expiresAt) <= clock() + minimumValidityMs) {
    throw new ConnectorBrokerError('CREDENTIAL_EXPIRED', 'OAuth credential is already expired or too close to expiry');
  }
  try {
    await store.set(gmailOAuthSecretName(profileId), JSON.stringify(parsed.data));
  } catch {
    throw new ConnectorBrokerError('CREDENTIAL_STORE_UNAVAILABLE', 'OAuth credential store is unavailable');
  }
}

export async function revokeOAuthCredential(store: SecretStore<string>, profileId: string): Promise<boolean> {
  try {
    return await store.delete(gmailOAuthSecretName(profileId));
  } catch {
    throw new ConnectorBrokerError('CREDENTIAL_STORE_UNAVAILABLE', 'OAuth credential store is unavailable');
  }
}

export async function readOAuthCredentialStatus(
  store: SecretStore<string>,
  profileId: string,
  options: { readonly clock?: () => number; readonly minimumValidityMs?: number } = {},
): Promise<OAuthCredentialStatus> {
  let raw: string | undefined;
  try {
    raw = await store.get(gmailOAuthSecretName(profileId));
  } catch {
    throw new ConnectorBrokerError('CREDENTIAL_STORE_UNAVAILABLE', 'OAuth credential store is unavailable');
  }
  if (raw === undefined) return { state: 'missing' };
  const credential = parseStoredCredential(raw);
  if (!credential) return { state: 'invalid' };
  const clock = options.clock ?? Date.now;
  const minimumValidityMs = resolveMinimumValidity(options.minimumValidityMs);
  return Date.parse(credential.expiresAt) <= clock() + minimumValidityMs
    ? { state: 'expired', expiresAt: credential.expiresAt }
    : { state: 'valid', expiresAt: credential.expiresAt };
}

export class SecretStoreOAuthAccessTokenSource implements OAuthAccessTokenSource {
  readonly #clock: () => number;
  readonly #minimumValidityMs: number;

  constructor(
    private readonly store: SecretStore<string>,
    options: { readonly clock?: () => number; readonly minimumValidityMs?: number } = {},
  ) {
    this.#clock = options.clock ?? Date.now;
    this.#minimumValidityMs = resolveMinimumValidity(options.minimumValidityMs);
  }

  async withAccessToken<T>(profileId: string, use: (accessToken: string) => Promise<T>): Promise<T> {
    let raw: string | undefined;
    try {
      raw = await this.store.get(gmailOAuthSecretName(profileId));
    } catch {
      throw new ConnectorBrokerError('CREDENTIAL_STORE_UNAVAILABLE', 'OAuth credential store is unavailable');
    }
    if (raw === undefined) {
      throw new ConnectorBrokerError('CREDENTIAL_MISSING', 'OAuth credential is not provisioned for this profile');
    }
    const credential = parseStoredCredential(raw);
    if (!credential) {
      throw new ConnectorBrokerError('CREDENTIAL_INVALID', 'Stored OAuth credential is malformed');
    }
    if (Date.parse(credential.expiresAt) <= this.#clock() + this.#minimumValidityMs) {
      throw new ConnectorBrokerError('CREDENTIAL_EXPIRED', 'Stored OAuth credential is expired or too close to expiry');
    }
    return use(credential.accessToken);
  }
}

export interface GmailSearchResult {
  readonly source: 'gmail';
  readonly domains: readonly string[];
  readonly correspondences: readonly GmailCorrespondence[];
}

export interface GmailConnectorBrokerOptions {
  readonly profileId: string;
  readonly policy: GmailConnectorPolicyInput;
  readonly tokenSource: OAuthAccessTokenSource;
  readonly provider: GmailReadProvider;
  readonly clock?: () => number;
}

function projectProviderResponse(options: {
  readonly providerValue: unknown;
  readonly limit: number;
  readonly requestedDomains: readonly string[];
  readonly oldestAllowedAt: number;
  readonly accessToken: string;
}): GmailSearchResult {
  if (!Array.isArray(options.providerValue) || options.providerValue.length > options.limit) {
    throw new ConnectorBrokerError('PROVIDER_RESPONSE_INVALID', 'Gmail provider returned an invalid response');
  }
  const response = z.array(GmailCorrespondenceSchema).safeParse(options.providerValue);
  if (!response.success) {
    throw new ConnectorBrokerError('PROVIDER_RESPONSE_INVALID', 'Gmail provider returned an invalid response');
  }
  const requestedDomains = new Set(options.requestedDomains);
  for (const item of response.data) {
    const projectedStrings = [
      item.messageId,
      item.threadId,
      item.correspondent.email,
      item.correspondent.displayName,
      item.direction,
      item.occurredAt,
    ];
    if (projectedStrings.some((value) => value?.includes(options.accessToken))) {
      throw new ConnectorBrokerError(
        'PROVIDER_POLICY_VIOLATION',
        'Gmail provider returned credential material in a projected field',
      );
    }
    const domain = normalizedEmailDomain(item.correspondent.email);
    if (domain === undefined || !requestedDomains.has(domain)) {
      throw new ConnectorBrokerError(
        'PROVIDER_POLICY_VIOLATION',
        'Gmail provider returned correspondence outside the requested domains',
      );
    }
    if (Date.parse(item.occurredAt) < options.oldestAllowedAt) {
      throw new ConnectorBrokerError(
        'PROVIDER_POLICY_VIOLATION',
        'Gmail provider returned correspondence outside the requested age bound',
      );
    }
  }

  return Object.freeze({
    source: 'gmail',
    domains: options.requestedDomains,
    correspondences: Object.freeze(
      response.data.map((item) =>
        Object.freeze({
          ...item,
          correspondent: Object.freeze({ ...item.correspondent }),
        }),
      ),
    ),
  });
}

/** Read-only broker: explicit domains in, bounded correspondence metadata out. */
export class GmailConnectorBroker {
  readonly #allowedDomains: ReadonlySet<string>;
  readonly #clock: () => number;
  readonly #policy: GmailConnectorPolicy;
  readonly #profileId: string;
  readonly #provider: GmailReadProvider;
  readonly #tokenSource: OAuthAccessTokenSource;

  constructor(options: GmailConnectorBrokerOptions) {
    const policy = GmailConnectorPolicySchema.safeParse(options.policy);
    const profile = ConnectorProfileIdSchema.safeParse(options.profileId);
    if (!policy.success || !profile.success) {
      throw new ConnectorBrokerError('CONFIG_INVALID', 'Gmail connector broker configuration is invalid');
    }
    if (
      !options.provider ||
      typeof options.provider.searchCorrespondence !== 'function' ||
      !options.tokenSource ||
      typeof options.tokenSource.withAccessToken !== 'function' ||
      (options.clock !== undefined && typeof options.clock !== 'function')
    ) {
      throw new ConnectorBrokerError('CONFIG_INVALID', 'Gmail connector broker dependencies are invalid');
    }
    this.#policy = policy.data;
    this.#allowedDomains = new Set(policy.data.allowedDomains);
    this.#clock = options.clock ?? Date.now;
    this.#profileId = profile.data;
    this.#provider = options.provider;
    this.#tokenSource = options.tokenSource;
  }

  async search(inputValue: unknown): Promise<GmailSearchResult> {
    const parsed = GmailSearchInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      throw new ConnectorBrokerError('REQUEST_INVALID', 'Gmail search arguments are invalid');
    }
    const requestedDomainValues = Object.freeze([...parsed.data.domains]);
    for (const domain of requestedDomainValues) {
      if (!this.#allowedDomains.has(domain)) {
        throw new ConnectorBrokerError('DOMAIN_NOT_ALLOWED', 'Gmail search requested a domain outside local policy');
      }
    }

    const limit = parsed.data.limit ?? this.#policy.maxResults;
    const newerThanDays = parsed.data.newerThanDays ?? this.#policy.maxAgeDays;
    if (limit > this.#policy.maxResults || newerThanDays > this.#policy.maxAgeDays) {
      throw new ConnectorBrokerError('REQUEST_INVALID', 'Gmail search exceeds the local result or age bound');
    }
    const requestStartedAt = this.#clock();
    if (!Number.isSafeInteger(requestStartedAt) || requestStartedAt < 0) {
      throw new ConnectorBrokerError('CONFIG_INVALID', 'Gmail connector broker clock is invalid');
    }
    const oldestAllowedAt = requestStartedAt - newerThanDays * 86_400_000;

    return this.#tokenSource.withAccessToken(this.#profileId, async (accessToken) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('provider deadline exceeded'));
        }, this.#policy.providerTimeoutMs);
        timer.unref?.();
      });
      let providerValue: unknown;
      try {
        providerValue = await Promise.race([
          this.#provider.searchCorrespondence({
            accessToken,
            domains: requestedDomainValues,
            limit,
            newerThanDays,
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch {
        throw new ConnectorBrokerError('PROVIDER_FAILED', 'Gmail provider request failed');
      } finally {
        if (timer) clearTimeout(timer);
      }
      return projectProviderResponse({
        providerValue,
        limit,
        requestedDomains: requestedDomainValues,
        oldestAllowedAt,
        accessToken,
      });
    });
  }
}
