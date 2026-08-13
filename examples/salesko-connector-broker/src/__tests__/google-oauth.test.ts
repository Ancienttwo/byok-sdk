import { InMemorySecretStore } from '@byok-sdk/keys';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_GMAIL_PROFILE_ENDPOINT,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthAccessTokenSource,
  authorizeGoogleGmailWithLoopback,
  configureGoogleOAuthClient,
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  forgetGoogleOAuthConnection,
  googleOAuthClientSecretName,
  googleOAuthRefreshSecretName,
  readGoogleOAuthStatus,
  revokeGoogleOAuthConnection,
  type GoogleFetch,
  type GoogleOAuthRefreshCredential,
} from '../google-oauth';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const CLIENT = {
  clientId: '123456789012-reference.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-reference-client-secret',
};
const ACCESS_TOKEN = 'ya29.google-access-token-reference';
const REFRESH_TOKEN = '1//google-refresh-token-reference';
const REFRESH: GoogleOAuthRefreshCredential = {
  refreshToken: REFRESH_TOKEN,
  accountEmail: 'owner@example.com',
  grantedScopes: [GOOGLE_GMAIL_READONLY_SCOPE],
  connectedAt: '2026-08-13T12:00:00.000Z',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seedConnection(store: InMemorySecretStore<string>): Promise<void> {
  await configureGoogleOAuthClient(store, 'default', CLIENT);
  await store.set(googleOAuthRefreshSecretName('default'), JSON.stringify(REFRESH));
}

describe('Google Gmail OAuth lifecycle', () => {
  it('stores client configuration in the secret store and exposes only safe status', async () => {
    const store = new InMemorySecretStore<string>();
    expect(await readGoogleOAuthStatus(store, 'default', { clock: () => NOW })).toEqual({
      client: 'missing',
      connection: 'missing',
    });

    await configureGoogleOAuthClient(store, 'default', CLIENT);
    const raw = await store.get(googleOAuthClientSecretName('default'));
    expect(raw).toContain(CLIENT.clientSecret);
    const status = await readGoogleOAuthStatus(store, 'default', { clock: () => NOW });
    expect(status).toEqual({ client: 'configured', connection: 'missing' });
    expect(JSON.stringify(status)).not.toContain(CLIENT.clientId);
    expect(JSON.stringify(status)).not.toContain(CLIENT.clientSecret);
  });

  it('does not strand a refresh token under a different OAuth client', async () => {
    const store = new InMemorySecretStore<string>();
    await seedConnection(store);

    await expect(
      configureGoogleOAuthClient(store, 'default', {
        clientId: '999999999999-different.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-different-client-secret',
      }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: 'Revoke or forget the existing Google Gmail connection before changing its OAuth client',
    });
    expect(await store.get(googleOAuthClientSecretName('default'))).toBe(
      JSON.stringify(CLIENT),
    );

    const fetchImpl: GoogleFetch = vi.fn();
    const onAuthorizationUrl = vi.fn();
    await expect(
      authorizeGoogleGmailWithLoopback({
        store,
        profileId: 'default',
        fetchImpl,
        onAuthorizationUrl,
      }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: 'Revoke or forget the existing Google Gmail connection before authorizing again',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('builds one exact read-only PKCE authorization request on a loopback callback', () => {
    const codeVerifier = 'A'.repeat(64);
    const state = 'state_abcdefghijklmnopqrstuvwxyz0123456789';
    const request = createGoogleAuthorizationRequest({
      clientId: CLIENT.clientId,
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      state,
      codeVerifier,
    });
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: 'offline',
      client_id: CLIENT.clientId,
      code_challenge_method: 'S256',
      include_granted_scopes: 'false',
      prompt: 'consent',
      redirect_uri: 'http://127.0.0.1:49152/oauth/callback',
      response_type: 'code',
      scope: GOOGLE_GMAIL_READONLY_SCOPE,
      state,
    });
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
    );
    expect(request.authorizationUrl).not.toContain(CLIENT.clientSecret);
  });

  it('exchanges a PKCE code, proves the Gmail account, and returns only a refresh credential', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: GoogleFetch = vi.fn(async (input, init) => {
      const url = String(input);
      seen.push({ url, ...(init ? { init } : {}) });
      if (url === GOOGLE_TOKEN_ENDPOINT) {
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          expires_in: 3_600,
          refresh_token: REFRESH_TOKEN,
          scope: GOOGLE_GMAIL_READONLY_SCOPE,
          token_type: 'Bearer',
        });
      }
      if (url === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
        return jsonResponse({ emailAddress: 'owner@example.com' });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await exchangeGoogleAuthorizationCode({
      client: CLIENT,
      authorization: {
        code: 'authorization-code',
        codeVerifier: 'B'.repeat(64),
        redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      },
      fetchImpl,
      clock: () => NOW,
    });

    expect(result).toEqual(REFRESH);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(seen[0]?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(seen[0]?.url).not.toContain('authorization-code');
    const form = new URLSearchParams(String(seen[0]?.init?.body));
    expect(form.get('client_secret')).toBe(CLIENT.clientSecret);
    expect(form.get('code_verifier')).toBe('B'.repeat(64));
  });

  it('refreshes process-local access once, rechecks stored authority, and never returns either token in status', async () => {
    const store = new InMemorySecretStore<string>();
    await seedConnection(store);
    const get = vi.spyOn(store, 'get');
    const fetchImpl: GoogleFetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('refresh_token')).toBe(REFRESH_TOKEN);
      return jsonResponse({
        access_token: ACCESS_TOKEN,
        expires_in: 3_600,
        scope: GOOGLE_GMAIL_READONLY_SCOPE,
        token_type: 'Bearer',
      });
    });
    const source = new GoogleOAuthAccessTokenSource(store, {
      fetchImpl,
      clock: () => NOW,
    });

    await expect(source.withAccessToken('default', async (token) => `used:${token}`)).resolves.toBe(
      `used:${ACCESS_TOKEN}`,
    );
    await expect(source.withAccessToken('default', async () => 'cached')).resolves.toBe('cached');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(4);
    const status = await readGoogleOAuthStatus(store, 'default', { clock: () => NOW });
    expect(status).toMatchObject({
      client: 'configured',
      connection: 'connected',
      accountEmail: 'owner@example.com',
    });
    expect(JSON.stringify(status)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(status)).not.toContain(REFRESH_TOKEN);

    await store.delete(googleOAuthRefreshSecretName('default'));
    const useCached = vi.fn(async () => 'must not run');
    await expect(source.withAccessToken('default', useCached)).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
    expect(useCached).not.toHaveBeenCalled();
  });

  it('maps invalid_grant to a safe expired state without echoing Google details', async () => {
    const store = new InMemorySecretStore<string>();
    await seedConnection(store);
    const source = new GoogleOAuthAccessTokenSource(store, {
      fetchImpl: async () =>
        jsonResponse(
          { error: 'invalid_grant', error_description: `revoked ${REFRESH_TOKEN}` },
          400,
        ),
      clock: () => NOW,
    });

    const failure = await source
      .withAccessToken('default', async () => 'unreachable')
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'CREDENTIAL_EXPIRED',
      message: 'Stored Google Gmail authorization is no longer valid',
    });
    expect(JSON.stringify(failure)).not.toContain(REFRESH_TOKEN);
  });

  it('preserves the local credential unless upstream revoke succeeds, with explicit local forget', async () => {
    const store = new InMemorySecretStore<string>();
    await seedConnection(store);
    await expect(
      revokeGoogleOAuthConnection({
        store,
        profileId: 'default',
        fetchImpl: async () => jsonResponse({ error: 'server_error' }, 500),
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(await store.has(googleOAuthRefreshSecretName('default'))).toBe(true);

    const revokeFetch: GoogleFetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(GOOGLE_REVOKE_ENDPOINT);
      expect(String(input)).not.toContain(REFRESH_TOKEN);
      expect(new URLSearchParams(String(init?.body)).get('token')).toBe(REFRESH_TOKEN);
      return new Response(null, { status: 200 });
    });
    await expect(
      revokeGoogleOAuthConnection({
        store,
        profileId: 'default',
        fetchImpl: revokeFetch,
        clock: () => NOW,
      }),
    ).resolves.toBe(true);
    expect(await store.has(googleOAuthRefreshSecretName('default'))).toBe(false);

    await store.set(googleOAuthRefreshSecretName('default'), JSON.stringify(REFRESH));
    await expect(forgetGoogleOAuthConnection(store, 'default')).resolves.toBe(true);
  });

  it('completes a real loopback state/PKCE flow and persists only the refresh credential', async () => {
    const store = new InMemorySecretStore<string>();
    await configureGoogleOAuthClient(store, 'default', CLIENT);
    const fetchImpl: GoogleFetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === GOOGLE_TOKEN_ENDPOINT) {
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          expires_in: 3_600,
          refresh_token: REFRESH_TOKEN,
          scope: GOOGLE_GMAIL_READONLY_SCOPE,
          token_type: 'Bearer',
        });
      }
      if (url === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
        return jsonResponse({ emailAddress: 'owner@example.com' });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const callbackStatuses: number[] = [];
    const status = await authorizeGoogleGmailWithLoopback({
      store,
      profileId: 'default',
      fetchImpl,
      clock: () => NOW,
      timeoutMs: 2_000,
      async onAuthorizationUrl(authorizationUrl) {
        const authorization = new URL(authorizationUrl);
        const redirectUri = authorization.searchParams.get('redirect_uri');
        const state = authorization.searchParams.get('state');
        if (!redirectUri || !state) throw new Error('missing loopback fields');
        const wrong = await fetch(`${redirectUri}?state=wrong_state_value_abcdefghijklmnopqrstuvwxyz&code=ignored`);
        callbackStatuses.push(wrong.status);
        const ambiguous = await fetch(
          `${redirectUri}?state=${encodeURIComponent(state)}&state=${encodeURIComponent(state)}&code=ignored`,
        );
        callbackStatuses.push(ambiguous.status);
        const accepted = await fetch(
          `${redirectUri}?state=${encodeURIComponent(state)}&code=loopback-code`,
        );
        callbackStatuses.push(accepted.status);
      },
    });

    expect(callbackStatuses).toEqual([400, 400, 200]);
    expect(status).toMatchObject({
      client: 'configured',
      connection: 'connected',
      accountEmail: 'owner@example.com',
    });
    const raw = await store.get(googleOAuthRefreshSecretName('default'));
    expect(raw).toContain(REFRESH_TOKEN);
    expect(raw).not.toContain(ACCESS_TOKEN);
  });
});
