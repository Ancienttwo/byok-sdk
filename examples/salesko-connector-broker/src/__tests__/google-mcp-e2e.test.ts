import { InMemorySecretStore } from '@byok-sdk/keys';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { GmailConnectorBroker } from '../broker';
import { GoogleGmailReadProvider, GOOGLE_GMAIL_MESSAGES_ENDPOINT } from '../google-gmail-provider';
import {
  GOOGLE_GMAIL_PROFILE_ENDPOINT,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthAccessTokenSource,
  configureGoogleOAuthClient,
  googleOAuthRefreshSecretName,
  type GoogleFetch,
} from '../google-oauth';
import { GMAIL_SEARCH_TOOL_NAME, serveConnectorMcp } from '../mcp-server';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const CLIENT_SECRET = 'GOCSPX-e2e-client-secret';
const ACCESS_TOKEN = 'ya29.e2e-google-access-token';
const REFRESH_TOKEN = '1//e2e-google-refresh-token';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Google Gmail connector MCP end to end', () => {
  it('runs OS-store shape -> refresh -> Gmail metadata -> policy -> stdio MCP without token projection', async () => {
    const store = new InMemorySecretStore<string>();
    await configureGoogleOAuthClient(store, 'default', {
      clientId: '123456789012-e2e.apps.googleusercontent.com',
      clientSecret: CLIENT_SECRET,
    });
    await store.set(
      googleOAuthRefreshSecretName('default'),
      JSON.stringify({
        refreshToken: REFRESH_TOKEN,
        accountEmail: 'owner@salesko.dev',
        grantedScopes: [GOOGLE_GMAIL_READONLY_SCOPE],
        connectedAt: '2026-08-13T11:00:00.000Z',
      }),
    );
    const seen: string[] = [];
    const fetchImpl: GoogleFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      if (url.toString() === GOOGLE_TOKEN_ENDPOINT) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('client_secret')).toBe(CLIENT_SECRET);
        expect(form.get('refresh_token')).toBe(REFRESH_TOKEN);
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          expires_in: 3_600,
          scope: GOOGLE_GMAIL_READONLY_SCOPE,
          token_type: 'Bearer',
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
      if (url.toString() === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
        return jsonResponse({ emailAddress: 'owner@salesko.dev' });
      }
      if (url.origin + url.pathname === GOOGLE_GMAIL_MESSAGES_ENDPOINT) {
        return jsonResponse({ messages: [{ id: 'gmail-e2e-1', threadId: 'thread-e2e-1' }] });
      }
      if (url.pathname.endsWith('/messages/gmail-e2e-1')) {
        return jsonResponse({
          id: 'gmail-e2e-1',
          threadId: 'thread-e2e-1',
          internalDate: String(NOW - 60_000),
          snippet: 'must not leave the provider',
          payload: {
            headers: [
              { name: 'From', value: 'Ada Lead <ada@acme.com>' },
              { name: 'To', value: 'owner@salesko.dev' },
              { name: 'Subject', value: 'private subject' },
            ],
          },
        });
      }
      throw new Error(`unexpected URL ${url.toString()}`);
    });
    const broker = new GmailConnectorBroker({
      profileId: 'default',
      policy: { allowedDomains: ['acme.com'], maxResults: 5, maxAgeDays: 30 },
      tokenSource: new GoogleOAuthAccessTokenSource(store, {
        fetchImpl,
        clock: () => NOW,
      }),
      provider: new GoogleGmailReadProvider({ fetchImpl }),
      clock: () => NOW,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let bytes = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      bytes += chunk;
    });

    const serving = serveConnectorMcp(broker, { input, output });
    input.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: GMAIL_SEARCH_TOOL_NAME,
          arguments: { domains: ['acme.com'], limit: 2, newerThanDays: 7 },
        },
      })}\n`,
    );
    await serving;

    const response = JSON.parse(bytes) as Record<string, unknown>;
    expect(response).toMatchObject({ id: 1 });
    expect(bytes).toContain('ada@acme.com');
    expect(bytes).toContain('gmail-e2e-1');
    expect(bytes).not.toContain('private subject');
    expect(bytes).not.toContain('must not leave');
    expect(bytes).not.toContain(ACCESS_TOKEN);
    expect(bytes).not.toContain(REFRESH_TOKEN);
    expect(bytes).not.toContain(CLIENT_SECRET);
    expect(seen).toHaveLength(4);
    expect(seen.every((url) => !url.includes(ACCESS_TOKEN))).toBe(true);
    expect(seen.every((url) => !url.includes(REFRESH_TOKEN))).toBe(true);
  });
});
