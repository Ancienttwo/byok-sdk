import { InMemorySecretStore } from '@byok-sdk/keys';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  GmailConnectorBroker,
  SecretStoreOAuthAccessTokenSource,
  provisionOAuthCredential,
  type GmailReadProvider,
} from '../broker';
import { GMAIL_SEARCH_TOOL_NAME, MAX_MCP_REQUEST_BYTES, serveConnectorMcp } from '../mcp-server';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const ACCESS_TOKEN = 'ya29.mcp-local-secret';

describe('Salesko connector stdio MCP end to end', () => {
  it('runs initialize -> tools/list -> tools/call through custody, policy, provider, and redacted output', async () => {
    const store = new InMemorySecretStore<string>();
    await provisionOAuthCredential(
      store,
      'default',
      { accessToken: ACCESS_TOKEN, expiresAt: '2026-08-13T13:00:00.000Z' },
      { clock: () => NOW },
    );
    const searchCorrespondence = vi.fn(async () => [
      {
        messageId: 'gmail-message-1',
        correspondent: { email: 'ada@acme.com', displayName: 'Ada Lead' },
        direction: 'outbound',
        occurredAt: '2026-08-13T11:00:00.000Z',
      },
    ]);
    const provider = { searchCorrespondence } satisfies GmailReadProvider;
    const broker = new GmailConnectorBroker({
      profileId: 'default',
      policy: { allowedDomains: ['acme.com'], maxResults: 5, maxAgeDays: 30 },
      tokenSource: new SecretStoreOAuthAccessTokenSource(store, { clock: () => NOW }),
      provider,
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
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: GMAIL_SEARCH_TOOL_NAME, arguments: { domains: ['acme.com'] } },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: GMAIL_SEARCH_TOOL_NAME,
          arguments: { domains: ['acme.com'], limit: 2, newerThanDays: 7 },
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: GMAIL_SEARCH_TOOL_NAME, arguments: { domains: ['outside.example'] } },
      })}\n`,
    );
    input.end();
    await serving;

    const responses = bytes
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25' } });
    expect(JSON.stringify(responses[1])).toContain(GMAIL_SEARCH_TOOL_NAME);
    expect(JSON.stringify(responses[2])).toContain('ada@acme.com');
    expect(responses[3]).toMatchObject({
      id: 4,
      error: { data: { brokerCode: 'DOMAIN_NOT_ALLOWED' } },
    });
    expect(searchCorrespondence).toHaveBeenCalledTimes(1);
    expect(searchCorrespondence).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: ACCESS_TOKEN,
        domains: ['acme.com'],
        limit: 2,
        newerThanDays: 7,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(bytes).not.toContain(ACCESS_TOKEN);
  });

  it('discards an oversized NDJSON line before JSON parsing or broker execution', async () => {
    const provider = { searchCorrespondence: vi.fn() } satisfies GmailReadProvider;
    const broker = new GmailConnectorBroker({
      profileId: 'default',
      policy: { allowedDomains: ['acme.com'] },
      tokenSource: {
        withAccessToken: async () => {
          throw new Error('must not be reached');
        },
      },
      provider,
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
    input.end(`${'x'.repeat(MAX_MCP_REQUEST_BYTES + 1)}\n`);
    await serving;

    expect(JSON.parse(bytes)).toMatchObject({
      id: null,
      error: { code: -32600, message: 'JSON-RPC request exceeds the byte limit' },
    });
    expect(provider.searchCorrespondence).not.toHaveBeenCalled();
  });
});
