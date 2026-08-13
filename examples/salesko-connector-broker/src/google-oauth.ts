import type { SecretStore } from '@byok-sdk/keys';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import {
  ConnectorBrokerError,
  ConnectorProfileIdSchema,
  NormalizedEmailAddressSchema,
  type OAuthAccessTokenSource,
} from './broker';

export const GOOGLE_GMAIL_READONLY_SCOPE =
  'https://www.googleapis.com/auth/gmail.readonly' as const;
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_GMAIL_PROFILE_ENDPOINT =
  'https://gmail.googleapis.com/gmail/v1/users/me/profile';

const GOOGLE_CLIENT_SECRET_PREFIX = 'google-oauth-client-';
const GOOGLE_REFRESH_SECRET_PREFIX = 'google-oauth-refresh-';
const OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_MINIMUM_VALIDITY_MS = 30_000;
const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60_000;
const GOOGLE_CALLBACK_PATH = '/oauth/callback';
const MAX_DATE_MS = 8_640_000_000_000_000;

export type GoogleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const SecretTextSchema = z
  .string()
  .min(8)
  .max(1_536)
  .regex(/^[^\u0000-\u0020\u007f]+$/u);

export const GoogleOAuthClientCredentialSchema = z
  .object({
    clientId: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u),
    clientSecret: SecretTextSchema.max(512),
  })
  .strict();

export type GoogleOAuthClientCredential = z.infer<
  typeof GoogleOAuthClientCredentialSchema
>;

export const GoogleOAuthRefreshCredentialSchema = z
  .object({
    refreshToken: SecretTextSchema,
    accountEmail: NormalizedEmailAddressSchema,
    grantedScopes: z.tuple([z.literal(GOOGLE_GMAIL_READONLY_SCOPE)]),
    connectedAt: z.iso.datetime({ offset: true }),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type GoogleOAuthRefreshCredential = z.infer<
  typeof GoogleOAuthRefreshCredentialSchema
>;

export interface GoogleOAuthStatus {
  readonly client: 'missing' | 'invalid' | 'configured';
  readonly connection: 'missing' | 'invalid' | 'expired' | 'connected';
  readonly accountEmail?: string;
  readonly grantedScopes?: readonly [typeof GOOGLE_GMAIL_READONLY_SCOPE];
  readonly connectedAt?: string;
  readonly refreshTokenExpiresAt?: string;
}

export interface GoogleAuthorizationRequest {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly state: string;
}

export interface GoogleAuthorizationCode {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

const TokenExchangeResponseSchema = z
  .object({
    access_token: SecretTextSchema.max(2_048),
    expires_in: z.number().int().min(1).max(86_400),
    refresh_token: SecretTextSchema,
    refresh_token_expires_in: z.number().int().min(1).max(31_536_000).optional(),
    scope: z.string().min(1).max(2_048),
    token_type: z.literal('Bearer'),
  })
  .strict();

const TokenRefreshResponseSchema = z
  .object({
    access_token: SecretTextSchema.max(2_048),
    expires_in: z.number().int().min(1).max(86_400),
    scope: z.string().min(1).max(2_048).optional(),
    token_type: z.literal('Bearer'),
  })
  .strict();

const OAuthErrorResponseSchema = z
  .object({
    error: z.string().min(1).max(160),
    error_description: z.string().max(2_048).optional(),
  })
  .passthrough();

const GmailProfileResponseSchema = z
  .object({
    emailAddress: NormalizedEmailAddressSchema,
    historyId: z.string().optional(),
    messagesTotal: z.number().int().optional(),
    threadsTotal: z.number().int().optional(),
  })
  .passthrough();

function assertProfileId(profileId: string): string {
  const parsed = ConnectorProfileIdSchema.safeParse(profileId);
  if (!parsed.success) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'OAuth profile id is invalid');
  }
  return parsed.data;
}

export function googleOAuthClientSecretName(profileId: string): string {
  return `${GOOGLE_CLIENT_SECRET_PREFIX}${assertProfileId(profileId)}`;
}

export function googleOAuthRefreshSecretName(profileId: string): string {
  return `${GOOGLE_REFRESH_SECRET_PREFIX}${assertProfileId(profileId)}`;
}

async function readSecret(
  store: SecretStore<string>,
  name: string,
): Promise<string | undefined> {
  try {
    return await store.get(name);
  } catch {
    throw new ConnectorBrokerError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'Google OAuth credential store is unavailable',
    );
  }
}

async function writeSecret(
  store: SecretStore<string>,
  name: string,
  value: string,
): Promise<void> {
  try {
    await store.set(name, value);
  } catch {
    throw new ConnectorBrokerError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'Google OAuth credential store is unavailable',
    );
  }
}

async function deleteSecret(
  store: SecretStore<string>,
  name: string,
): Promise<boolean> {
  try {
    return await store.delete(name);
  } catch {
    throw new ConnectorBrokerError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'Google OAuth credential store is unavailable',
    );
  }
}

function parseStored<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readValidClock(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth clock is invalid');
  }
  return now;
}

async function requireClientCredential(
  store: SecretStore<string>,
  profileId: string,
): Promise<GoogleOAuthClientCredential> {
  const raw = await readSecret(store, googleOAuthClientSecretName(profileId));
  if (raw === undefined) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_MISSING',
      'Google OAuth client credential is not configured',
    );
  }
  const credential = parseStored(raw, GoogleOAuthClientCredentialSchema);
  if (!credential) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_INVALID',
      'Stored Google OAuth client credential is malformed',
    );
  }
  return credential;
}

async function requireRefreshCredential(
  store: SecretStore<string>,
  profileId: string,
  clock: () => number,
): Promise<GoogleOAuthRefreshCredential> {
  const raw = await readSecret(store, googleOAuthRefreshSecretName(profileId));
  if (raw === undefined) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_MISSING',
      'Google Gmail connection is not authorized',
    );
  }
  const credential = parseStored(raw, GoogleOAuthRefreshCredentialSchema);
  if (!credential) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_INVALID',
      'Stored Google Gmail connection is malformed',
    );
  }
  const now = readValidClock(clock);
  if (
    credential.refreshTokenExpiresAt !== undefined &&
    Date.parse(credential.refreshTokenExpiresAt) <= now
  ) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_EXPIRED',
      'Stored Google Gmail authorization has expired',
    );
  }
  return credential;
}

export async function configureGoogleOAuthClient(
  store: SecretStore<string>,
  profileId: string,
  input: unknown,
): Promise<void> {
  const parsed = GoogleOAuthClientCredentialSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_INVALID',
      'Google OAuth client credential input is invalid',
    );
  }
  const [existingClientRaw, existingRefreshRaw] = await Promise.all([
    readSecret(store, googleOAuthClientSecretName(profileId)),
    readSecret(store, googleOAuthRefreshSecretName(profileId)),
  ]);
  if (existingRefreshRaw !== undefined) {
    const existingClient = parseStored(
      existingClientRaw,
      GoogleOAuthClientCredentialSchema,
    );
    if (
      !existingClient ||
      existingClient.clientId !== parsed.data.clientId ||
      existingClient.clientSecret !== parsed.data.clientSecret
    ) {
      throw new ConnectorBrokerError(
        'CONFIG_INVALID',
        'Revoke or forget the existing Google Gmail connection before changing its OAuth client',
      );
    }
  }
  await writeSecret(
    store,
    googleOAuthClientSecretName(profileId),
    JSON.stringify(parsed.data),
  );
}

export async function readGoogleOAuthStatus(
  store: SecretStore<string>,
  profileId: string,
  options: { readonly clock?: () => number } = {},
): Promise<GoogleOAuthStatus> {
  const clock = options.clock ?? Date.now;
  const now = readValidClock(clock);
  const [rawClient, rawRefresh] = await Promise.all([
    readSecret(store, googleOAuthClientSecretName(profileId)),
    readSecret(store, googleOAuthRefreshSecretName(profileId)),
  ]);
  const client =
    rawClient === undefined
      ? 'missing'
      : parseStored(rawClient, GoogleOAuthClientCredentialSchema)
        ? 'configured'
        : 'invalid';
  if (rawRefresh === undefined) return { client, connection: 'missing' };
  const refresh = parseStored(rawRefresh, GoogleOAuthRefreshCredentialSchema);
  if (!refresh) return { client, connection: 'invalid' };
  const expired =
    refresh.refreshTokenExpiresAt !== undefined &&
    Date.parse(refresh.refreshTokenExpiresAt) <= now;
  return {
    client,
    connection: expired ? 'expired' : 'connected',
    accountEmail: refresh.accountEmail,
    grantedScopes: refresh.grantedScopes,
    connectedAt: refresh.connectedAt,
    ...(refresh.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: refresh.refreshTokenExpiresAt }
      : {}),
  };
}

function exactScope(scope: string): boolean {
  const values = scope.split(/\s+/u).filter(Boolean);
  return values.length === 1 && values[0] === GOOGLE_GMAIL_READONLY_SCOPE;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function validateRedirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth redirect URI is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== GOOGLE_CALLBACK_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port
  ) {
    throw new ConnectorBrokerError(
      'CONFIG_INVALID',
      'Google OAuth redirect URI must be the exact loopback callback',
    );
  }
  return url;
}

export function createGoogleAuthorizationRequest(options: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeVerifier?: string;
}): GoogleAuthorizationRequest {
  const client = GoogleOAuthClientCredentialSchema.shape.clientId.safeParse(
    options.clientId,
  );
  validateRedirectUri(options.redirectUri);
  if (!client.success) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth client id is invalid');
  }
  const state = options.state ?? base64Url(randomBytes(32));
  const codeVerifier = options.codeVerifier ?? base64Url(randomBytes(64));
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth PKCE verifier is invalid');
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(state)) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth state is invalid');
  }
  const codeChallenge = createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', client.data);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_GMAIL_READONLY_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    authorizationUrl: url.toString(),
    codeVerifier,
    redirectUri: options.redirectUri,
    state,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > OAUTH_RESPONSE_MAX_BYTES
  ) {
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google OAuth response exceeds the local byte limit',
    );
  }
  if (!response.body) {
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google OAuth response body is missing',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > OAUTH_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ConnectorBrokerError(
          'PROVIDER_RESPONSE_INVALID',
          'Google OAuth response exceeds the local byte limit',
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ConnectorBrokerError) throw error;
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google OAuth response body could not be read',
    );
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google OAuth response is not valid UTF-8',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google OAuth response is not valid JSON',
    );
  }
}

async function fetchWithDeadline(
  fetchImpl: GoogleFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new ConnectorBrokerError('PROVIDER_FAILED', 'Google OAuth request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function postToken(
  fetchImpl: GoogleFetch,
  fields: Readonly<Record<string, string>>,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetchWithDeadline(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await readBoundedJson(response);
  return { response, body };
}

async function fetchAccountEmail(
  fetchImpl: GoogleFetch,
  accessToken: string,
): Promise<string> {
  const response = await fetchWithDeadline(
    fetchImpl,
    GOOGLE_GMAIL_PROFILE_ENDPOINT,
    {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) {
    throw new ConnectorBrokerError('PROVIDER_FAILED', 'Google Gmail profile request failed');
  }
  const parsed = GmailProfileResponseSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) {
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google Gmail profile response is invalid',
    );
  }
  return parsed.data.emailAddress;
}

export async function exchangeGoogleAuthorizationCode(options: {
  readonly client: GoogleOAuthClientCredential;
  readonly authorization: GoogleAuthorizationCode;
  readonly fetchImpl?: GoogleFetch;
  readonly clock?: () => number;
}): Promise<GoogleOAuthRefreshCredential> {
  const client = GoogleOAuthClientCredentialSchema.safeParse(options.client);
  if (!client.success) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth client credential is invalid');
  }
  validateRedirectUri(options.authorization.redirectUri);
  if (
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(options.authorization.codeVerifier) ||
    typeof options.authorization.code !== 'string' ||
    options.authorization.code.length < 1 ||
    options.authorization.code.length > 4_096 ||
    /[\u0000\r\n]/u.test(options.authorization.code)
  ) {
    throw new ConnectorBrokerError('REQUEST_INVALID', 'Google OAuth authorization code is invalid');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const { response, body } = await postToken(fetchImpl, {
    client_id: client.data.clientId,
    client_secret: client.data.clientSecret,
    code: options.authorization.code,
    code_verifier: options.authorization.codeVerifier,
    redirect_uri: options.authorization.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!response.ok) {
    const error = OAuthErrorResponseSchema.safeParse(body);
    throw new ConnectorBrokerError(
      error.success && error.data.error === 'invalid_grant'
        ? 'CREDENTIAL_EXPIRED'
        : 'PROVIDER_FAILED',
      'Google OAuth authorization-code exchange failed',
    );
  }
  const token = TokenExchangeResponseSchema.safeParse(body);
  if (!token.success || !exactScope(token.data.scope)) {
    throw new ConnectorBrokerError(
      'PROVIDER_RESPONSE_INVALID',
      'Google OAuth token response did not grant exactly Gmail read-only access',
    );
  }
  const accountEmail = await fetchAccountEmail(
    fetchImpl,
    token.data.access_token,
  );
  const now = readValidClock(options.clock ?? Date.now);
  return {
    refreshToken: token.data.refresh_token,
    accountEmail,
    grantedScopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    connectedAt: new Date(now).toISOString(),
    ...(token.data.refresh_token_expires_in
      ? {
          refreshTokenExpiresAt: new Date(
            now + token.data.refresh_token_expires_in * 1_000,
          ).toISOString(),
        }
      : {}),
  };
}

function safeHtmlResponse(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Salesko Gmail</title><p>${message}</p>`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new ConnectorBrokerError('PROVIDER_FAILED', 'Google OAuth loopback listener failed');
  }
  return address.port;
}

export async function authorizeGoogleGmailWithLoopback(options: {
  readonly store: SecretStore<string>;
  readonly profileId: string;
  readonly fetchImpl?: GoogleFetch;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
  readonly onAuthorizationUrl: (url: string) => void | Promise<void>;
}): Promise<GoogleOAuthStatus> {
  const [client, existingRefreshRaw] = await Promise.all([
    requireClientCredential(options.store, options.profileId),
    readSecret(
      options.store,
      googleOAuthRefreshSecretName(options.profileId),
    ),
  ]);
  if (existingRefreshRaw !== undefined) {
    throw new ConnectorBrokerError(
      'CONFIG_INVALID',
      'Revoke or forget the existing Google Gmail connection before authorizing again',
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOPBACK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'Google OAuth callback timeout is invalid');
  }

  let expectedState = '';
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'");
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' || !request.url) {
      response.writeHead(404).end(safeHtmlResponse('Not found.'));
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== GOOGLE_CALLBACK_PATH) {
      response.writeHead(404).end(safeHtmlResponse('Not found.'));
      return;
    }
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || states[0] !== expectedState) {
      response.writeHead(400).end(safeHtmlResponse('Authorization state did not match.'));
      return;
    }
    if (settled) {
      response.writeHead(409).end(safeHtmlResponse('Authorization callback was already used.'));
      return;
    }
    const errors = url.searchParams.getAll('error');
    const codes = url.searchParams.getAll('code');
    const hasOneError = errors.length === 1;
    const hasOneCode = codes.length === 1;
    const code = hasOneCode ? codes[0] : undefined;
    settled = true;
    if (
      hasOneError === hasOneCode ||
      !code ||
      code.length > 4_096 ||
      /[\u0000\r\n]/u.test(code)
    ) {
      response.writeHead(400).end(safeHtmlResponse('Google authorization was not completed.'));
      rejectCode?.(
        new ConnectorBrokerError(
          'CREDENTIAL_MISSING',
          'Google Gmail authorization was denied or malformed',
        ),
      );
      return;
    }
    response
      .writeHead(200)
      .end(safeHtmlResponse('Authorization received. Return to the terminal for final status.'));
    resolveCode?.(code);
  });

  try {
    const port = await listenLoopback(server);
    const redirectUri = `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`;
    const authorization = createGoogleAuthorizationRequest({
      clientId: client.clientId,
      redirectUri,
    });
    expectedState = authorization.state;
    await options.onAuthorizationUrl(authorization.authorizationUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectCode?.(
        new ConnectorBrokerError(
          'CREDENTIAL_EXPIRED',
          'Google OAuth loopback callback timed out',
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    let code: string;
    try {
      code = await codePromise;
    } finally {
      clearTimeout(timer);
    }
    const refresh = await exchangeGoogleAuthorizationCode({
      client,
      authorization: {
        code,
        codeVerifier: authorization.codeVerifier,
        redirectUri,
      },
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    await writeSecret(
      options.store,
      googleOAuthRefreshSecretName(options.profileId),
      JSON.stringify(refresh),
    );
    return readGoogleOAuthStatus(options.store, options.profileId, {
      ...(options.clock ? { clock: options.clock } : {}),
    });
  } finally {
    await closeServer(server);
  }
}

interface CachedAccessToken {
  readonly accessToken: string;
  readonly clientId: string;
  readonly credentialFingerprint: string;
  readonly expiresAt: number;
}

function credentialFingerprint(
  client: GoogleOAuthClientCredential,
  refresh: GoogleOAuthRefreshCredential,
): string {
  return createHash('sha256')
    .update(client.clientId, 'utf8')
    .update('\0', 'utf8')
    .update(client.clientSecret, 'utf8')
    .update('\0', 'utf8')
    .update(refresh.refreshToken, 'utf8')
    .digest('base64url');
}

export class GoogleOAuthAccessTokenSource implements OAuthAccessTokenSource {
  readonly #clock: () => number;
  readonly #fetchImpl: GoogleFetch;
  #cache: CachedAccessToken | undefined;

  constructor(
    private readonly store: SecretStore<string>,
    options: { readonly fetchImpl?: GoogleFetch; readonly clock?: () => number } = {},
  ) {
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
  }

  async withAccessToken<T>(
    profileId: string,
    use: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let client: GoogleOAuthClientCredential;
    let refresh: GoogleOAuthRefreshCredential;
    try {
      [client, refresh] = await Promise.all([
        requireClientCredential(this.store, profileId),
        requireRefreshCredential(this.store, profileId, this.#clock),
      ]);
    } catch (error) {
      this.#cache = undefined;
      throw error;
    }
    const now = readValidClock(this.#clock);
    const fingerprint = credentialFingerprint(client, refresh);
    let accessToken: string;
    if (
      this.#cache &&
      this.#cache.clientId === client.clientId &&
      this.#cache.credentialFingerprint === fingerprint &&
      this.#cache.expiresAt > now + ACCESS_TOKEN_MINIMUM_VALIDITY_MS
    ) {
      accessToken = this.#cache.accessToken;
    } else {
      const { response, body } = await postToken(this.#fetchImpl, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refresh.refreshToken,
        grant_type: 'refresh_token',
      });
      if (!response.ok) {
        const oauthError = OAuthErrorResponseSchema.safeParse(body);
        this.#cache = undefined;
        throw new ConnectorBrokerError(
          oauthError.success && oauthError.data.error === 'invalid_grant'
            ? 'CREDENTIAL_EXPIRED'
            : 'PROVIDER_FAILED',
          oauthError.success && oauthError.data.error === 'invalid_grant'
            ? 'Stored Google Gmail authorization is no longer valid'
            : 'Google OAuth access-token refresh failed',
        );
      }
      const token = TokenRefreshResponseSchema.safeParse(body);
      if (!token.success || (token.data.scope !== undefined && !exactScope(token.data.scope))) {
        this.#cache = undefined;
        throw new ConnectorBrokerError(
          'PROVIDER_RESPONSE_INVALID',
          'Google OAuth refresh response is invalid',
        );
      }
      accessToken = token.data.access_token;
      this.#cache = {
        accessToken,
        clientId: client.clientId,
        credentialFingerprint: fingerprint,
        expiresAt: now + token.data.expires_in * 1_000,
      };
    }
    return use(accessToken);
  }
}

export async function revokeGoogleOAuthConnection(options: {
  readonly store: SecretStore<string>;
  readonly profileId: string;
  readonly fetchImpl?: GoogleFetch;
  readonly clock?: () => number;
}): Promise<boolean> {
  const raw = await readSecret(
    options.store,
    googleOAuthRefreshSecretName(options.profileId),
  );
  if (raw === undefined) return false;
  const refresh = parseStored(raw, GoogleOAuthRefreshCredentialSchema);
  if (!refresh) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_INVALID',
      'Stored Google Gmail connection is malformed',
    );
  }
  const now = readValidClock(options.clock ?? Date.now);
  if (
    refresh.refreshTokenExpiresAt !== undefined &&
    Date.parse(refresh.refreshTokenExpiresAt) <= now
  ) {
    throw new ConnectorBrokerError(
      'CREDENTIAL_EXPIRED',
      'Stored Google Gmail authorization has expired; forget it explicitly after external revocation',
    );
  }
  const response = await fetchWithDeadline(
    options.fetchImpl ?? globalThis.fetch,
    GOOGLE_REVOKE_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: refresh.refreshToken }).toString(),
    },
  );
  if (!response.ok) {
    throw new ConnectorBrokerError(
      'PROVIDER_FAILED',
      'Google OAuth revocation was not confirmed; local credential was preserved',
    );
  }
  return deleteSecret(
    options.store,
    googleOAuthRefreshSecretName(options.profileId),
  );
}

/** Local deletion only; it deliberately makes no claim about upstream revocation. */
export async function forgetGoogleOAuthConnection(
  store: SecretStore<string>,
  profileId: string,
): Promise<boolean> {
  return deleteSecret(store, googleOAuthRefreshSecretName(profileId));
}
