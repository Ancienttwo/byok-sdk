import { describe, expect, it, vi } from 'vitest';
import {
  ConnectorBrokerError,
  GmailConnectorBroker,
  type GmailProviderSearchInput,
  type GmailReadProvider,
  type OAuthAccessTokenSource,
} from '../broker';
import { createSaleskoConnectorSecretStore } from '../platform-store';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const ACCESS_TOKEN = 'ya29.local-secret-token';

function makeBroker(
  provider: GmailReadProvider,
  tokenSource: OAuthAccessTokenSource = {
    withAccessToken: async (_profileId, use) => use(ACCESS_TOKEN),
  },
): GmailConnectorBroker {
  return new GmailConnectorBroker({
    profileId: 'default',
    policy: { allowedDomains: ['acme.com'], maxResults: 5, maxAgeDays: 30 },
    tokenSource,
    provider,
    clock: () => NOW,
  });
}

describe('Salesko Gmail connector broker', () => {
  it('keeps OAuth local, applies exact domain policy, and returns only bounded metadata', async () => {
    const calls: GmailProviderSearchInput[] = [];
    const provider: GmailReadProvider = {
      async searchCorrespondence(input) {
        calls.push(input);
        return [
          {
            messageId: 'msg-1',
            threadId: 'thread-1',
            correspondent: { email: 'ada@acme.com', displayName: 'Ada Lead' },
            direction: 'inbound',
            occurredAt: '2026-08-13T11:30:00.000Z',
          },
        ];
      },
    };

    const result = await makeBroker(provider).search({
      domains: ['acme.com'],
      limit: 2,
      newerThanDays: 7,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      accessToken: ACCESS_TOKEN,
      domains: ['acme.com'],
      limit: 2,
      newerThanDays: 7,
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      source: 'gmail',
      domains: ['acme.com'],
      correspondences: [
        {
          messageId: 'msg-1',
          threadId: 'thread-1',
          correspondent: { email: 'ada@acme.com', displayName: 'Ada Lead' },
          direction: 'inbound',
          occurredAt: '2026-08-13T11:30:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it('rejects a domain outside local policy before reading credentials or calling the provider', async () => {
    const withAccessToken = vi.fn();
    const provider = { searchCorrespondence: vi.fn() } satisfies GmailReadProvider;
    const broker = makeBroker(provider, { withAccessToken });

    await expect(broker.search({ domains: ['outside.example'] })).rejects.toMatchObject({
      code: 'DOMAIN_NOT_ALLOWED',
    });
    expect(withAccessToken).not.toHaveBeenCalled();
    expect(provider.searchCorrespondence).not.toHaveBeenCalled();
  });

  it('fails closed on expired credentials and never calls the provider', async () => {
    const provider = { searchCorrespondence: vi.fn() } satisfies GmailReadProvider;
    const tokenSource: OAuthAccessTokenSource = {
      withAccessToken: async () => {
        throw new ConnectorBrokerError('CREDENTIAL_EXPIRED', 'OAuth credential expired');
      },
    };

    await expect(makeBroker(provider, tokenSource).search({ domains: ['acme.com'] })).rejects.toMatchObject({
      code: 'CREDENTIAL_EXPIRED',
    });
    expect(provider.searchCorrespondence).not.toHaveBeenCalled();
  });

  it('rejects provider over-return and out-of-domain data instead of truncating or filtering', async () => {
    const item = (index: number, email = `lead${index}@acme.com`) => ({
      messageId: `msg-${index}`,
      correspondent: { email },
      direction: 'inbound',
      occurredAt: '2026-08-13T11:30:00.000Z',
    });

    const tooMany = makeBroker({
      searchCorrespondence: async () => [item(1), item(2), item(3)],
    });
    await expect(tooMany.search({ domains: ['acme.com'], limit: 2 })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_INVALID',
    });

    const outside = makeBroker({
      searchCorrespondence: async () => [item(1, 'lead@outside.example')],
    });
    await expect(outside.search({ domains: ['acme.com'] })).rejects.toMatchObject({
      code: 'PROVIDER_POLICY_VIOLATION',
    });

    const mutationAttempt = makeBroker({
      searchCorrespondence: async (input) => {
        try {
          (input.domains as string[]).push('outside.example');
        } catch {
          // The broker passes a frozen snapshot; keep going to prove its policy
          // check also uses an independent pre-provider authority.
        }
        return [item(1, 'lead@outside.example')];
      },
    });
    await expect(mutationAttempt.search({ domains: ['acme.com'] })).rejects.toMatchObject({
      code: 'PROVIDER_POLICY_VIOLATION',
    });
  });

  it('rejects correspondence outside the requested age bound instead of filtering it', async () => {
    const broker = makeBroker({
      searchCorrespondence: async () => [
        {
          messageId: 'old-message',
          correspondent: { email: 'lead@acme.com' },
          direction: 'inbound',
          occurredAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });

    await expect(broker.search({ domains: ['acme.com'], newerThanDays: 30 })).rejects.toMatchObject({
      code: 'PROVIDER_POLICY_VIOLATION',
    });
  });

  it('does not expose provider errors or raw provider fields', async () => {
    const failing = makeBroker({
      searchCorrespondence: async () => {
        throw new Error(`Bearer ${ACCESS_TOKEN}`);
      },
    });
    const failure = await failing.search({ domains: ['acme.com'] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectorBrokerError);
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED', message: 'Gmail provider request failed' });
    expect(JSON.stringify(failure)).not.toContain(ACCESS_TOKEN);

    const raw = makeBroker({
      searchCorrespondence: async () => [
        {
          messageId: 'msg-1',
          correspondent: { email: 'ada@acme.com' },
          direction: 'inbound',
          occurredAt: '2026-08-13T11:30:00.000Z',
          rawBody: `private ${ACCESS_TOKEN}`,
        },
      ],
    });
    const rawFailure = await raw.search({ domains: ['acme.com'] }).catch((error: unknown) => error);
    expect(rawFailure).toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
    expect(JSON.stringify(rawFailure)).not.toContain(ACCESS_TOKEN);

    const projectedField = makeBroker({
      searchCorrespondence: async () => [
        {
          messageId: `message-${ACCESS_TOKEN}`,
          correspondent: { email: 'ada@acme.com' },
          direction: 'inbound',
          occurredAt: '2026-08-13T11:30:00.000Z',
        },
      ],
    });
    const projectedFailure = await projectedField
      .search({ domains: ['acme.com'] })
      .catch((error: unknown) => error);
    expect(projectedFailure).toMatchObject({
      code: 'PROVIDER_POLICY_VIOLATION',
      message: 'Gmail provider returned credential material in a projected field',
    });
    expect(JSON.stringify(projectedFailure)).not.toContain(ACCESS_TOKEN);
  });

  it('aborts a provider call at the local deadline', async () => {
    const provider: GmailReadProvider = {
      searchCorrespondence: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
    const broker = new GmailConnectorBroker({
      profileId: 'default',
      policy: {
        allowedDomains: ['acme.com'],
        maxResults: 5,
        maxAgeDays: 30,
        providerTimeoutMs: 250,
      },
      tokenSource: {
        withAccessToken: async (_profileId, use) => use(ACCESS_TOKEN),
      },
      provider,
      clock: () => NOW,
    });

    await expect(broker.search({ domains: ['acme.com'] })).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      message: 'Gmail provider request failed',
    });
  });

  it('has no Linux plaintext credential fallback', () => {
    expect(() => createSaleskoConnectorSecretStore('linux')).toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_STORE_UNAVAILABLE' }),
    );
    expect(createSaleskoConnectorSecretStore('darwin').providerLabel).toBe('macOS Keychain');
    expect(createSaleskoConnectorSecretStore('win32').providerLabel).toBe('Windows Credential Manager');
  });
});
