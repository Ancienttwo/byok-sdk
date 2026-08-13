import { describe, expect, it, vi } from 'vitest';
import { GoogleGmailReadProvider, GOOGLE_GMAIL_MESSAGES_ENDPOINT } from '../google-gmail-provider';
import { GOOGLE_GMAIL_PROFILE_ENDPOINT, type GoogleFetch } from '../google-oauth';

const ACCESS_TOKEN = 'ya29.google-access-token-reference';
const NOW = Date.parse('2026-08-13T12:00:00.000Z');

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function message(
  id: string,
  options: {
    from: string;
    to?: string;
    cc?: string;
    internalDate?: number;
    extraHeaders?: Array<{ name: string; value: string }>;
  },
): unknown {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(options.internalDate ?? NOW - 60_000),
    snippet: `private snippet for ${id}`,
    payload: {
      headers: [
        { name: 'From', value: options.from },
        ...(options.to ? [{ name: 'To', value: options.to }] : []),
        ...(options.cc ? [{ name: 'Cc', value: options.cc }] : []),
        { name: 'Subject', value: `private subject for ${id}` },
        ...(options.extraHeaders ?? []),
      ],
    },
  };
}

describe('Google Gmail read-only provider', () => {
  it('rejects direct-call search-operator injection before any provider I/O', async () => {
    const fetchImpl: GoogleFetch = vi.fn();
    const provider = new GoogleGmailReadProvider({ fetchImpl });

    await expect(
      provider.searchCorrespondence({
        accessToken: ACCESS_TOKEN,
        domains: ['acme.com} OR from:attacker.example'] as readonly string[],
        limit: 1,
        newerThanDays: 30,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Google Gmail search input is invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses metadata-only Gmail calls and projects exact-domain inbound/outbound correspondence', async () => {
    const seen: Array<{ url: URL; authorization: string | null }> = [];
    const messages = new Map<string, unknown>([
      [
        'm-inbound',
        message('m-inbound', {
          from: '"Ada Lead" <ada@acme.com>',
          to: 'Salesko Owner <owner@salesko.dev>',
        }),
      ],
      [
        'm-outbound',
        message('m-outbound', {
          from: 'Salesko Owner <owner@salesko.dev>',
          to: '"Bob, Buyer" <bob@acme.com>, other@outside.example',
        }),
      ],
      [
        'm-cc',
        message('m-cc', {
          from: 'owner@salesko.dev',
          to: 'other@outside.example',
          cc: 'Carol <carol@acme.com>',
        }),
      ],
      [
        'm-outside',
        message('m-outside', {
          from: 'attacker@notacme.com',
          to: 'owner@salesko.dev',
        }),
      ],
    ]);
    const fetchImpl: GoogleFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.toString() === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
        return jsonResponse({ emailAddress: 'owner@salesko.dev' });
      }
      if (url.origin + url.pathname === GOOGLE_GMAIL_MESSAGES_ENDPOINT) {
        return jsonResponse({
          messages: [...messages.keys()].map((id) => ({ id, threadId: `thread-${id}` })),
          resultSizeEstimate: messages.size,
        });
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const value = messages.get(id);
      if (!value) return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse(value);
    });
    const provider = new GoogleGmailReadProvider({ fetchImpl });
    const result = await provider.searchCorrespondence({
      accessToken: ACCESS_TOKEN,
      domains: ['acme.com'],
      limit: 5,
      newerThanDays: 7,
      signal: new AbortController().signal,
    });

    expect(result).toEqual([
      {
        messageId: 'm-inbound',
        threadId: 'thread-m-inbound',
        correspondent: { email: 'ada@acme.com', displayName: 'Ada Lead' },
        direction: 'inbound',
        occurredAt: new Date(NOW - 60_000).toISOString(),
      },
      {
        messageId: 'm-outbound',
        threadId: 'thread-m-outbound',
        correspondent: { email: 'bob@acme.com', displayName: 'Bob, Buyer' },
        direction: 'outbound',
        occurredAt: new Date(NOW - 60_000).toISOString(),
      },
      {
        messageId: 'm-cc',
        threadId: 'thread-m-cc',
        correspondent: { email: 'carol@acme.com', displayName: 'Carol' },
        direction: 'outbound',
        occurredAt: new Date(NOW - 60_000).toISOString(),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private subject');
    expect(JSON.stringify(result)).not.toContain('private snippet');
    expect(seen.every((request) => request.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    expect(seen.every((request) => !request.url.toString().includes(ACCESS_TOKEN))).toBe(true);

    const listRequest = seen.find(
      (request) => request.url.origin + request.url.pathname === GOOGLE_GMAIL_MESSAGES_ENDPOINT,
    );
    expect(listRequest?.url.searchParams.get('q')).toBe(
      'newer_than:7d {from:acme.com to:acme.com}',
    );
    expect(listRequest?.url.searchParams.get('maxResults')).toBe('20');
    expect(listRequest?.url.searchParams.get('includeSpamTrash')).toBe('false');
    expect(listRequest?.url.searchParams.get('fields')).toBe('messages/id');
    const getRequests = seen.filter(
      (request) => request.url.pathname.includes('/messages/') && request.url.pathname !== '/gmail/v1/users/me/messages',
    );
    expect(getRequests).toHaveLength(4);
    for (const request of getRequests) {
      expect(request.url.searchParams.get('format')).toBe('metadata');
      expect(request.url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Cc']);
      expect(request.url.searchParams.get('fields')).toBe(
        'id,threadId,internalDate,payload/headers',
      );
    }
  });

  it('rejects duplicate list ids and mismatched messages.get ids', async () => {
    const duplicateProvider = new GoogleGmailReadProvider({
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.toString() === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
          return jsonResponse({ emailAddress: 'owner@salesko.dev' });
        }
        return jsonResponse({ messages: [{ id: 'm1' }, { id: 'm1' }] });
      },
    });
    const request = {
      accessToken: ACCESS_TOKEN,
      domains: ['acme.com'],
      limit: 1,
      newerThanDays: 30,
      signal: new AbortController().signal,
    } as const;
    await expect(duplicateProvider.searchCorrespondence(request)).rejects.toThrow(
      'duplicate message ids',
    );

    const mismatchedProvider = new GoogleGmailReadProvider({
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.toString() === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
          return jsonResponse({ emailAddress: 'owner@salesko.dev' });
        }
        if (url.origin + url.pathname === GOOGLE_GMAIL_MESSAGES_ENDPOINT) {
          return jsonResponse({ messages: [{ id: 'm1' }] });
        }
        return jsonResponse(
          message('different-id', {
            from: 'lead@acme.com',
            to: 'owner@salesko.dev',
          }),
        );
      },
    });
    await expect(mismatchedProvider.searchCorrespondence(request)).rejects.toThrow(
      'mismatched message id',
    );
  });

  it('stops fetching metadata once the requested result limit is satisfied', async () => {
    const requestedMessages: string[] = [];
    const fetchImpl: GoogleFetch = async (input) => {
      const url = new URL(String(input));
      if (url.toString() === GOOGLE_GMAIL_PROFILE_ENDPOINT) {
        return jsonResponse({ emailAddress: 'owner@salesko.dev' });
      }
      if (url.origin + url.pathname === GOOGLE_GMAIL_MESSAGES_ENDPOINT) {
        return jsonResponse({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      requestedMessages.push(id);
      return jsonResponse(
        message(id, { from: `${id}@acme.com`, to: 'owner@salesko.dev' }),
      );
    };
    const provider = new GoogleGmailReadProvider({ fetchImpl });

    const result = await provider.searchCorrespondence({
      accessToken: ACCESS_TOKEN,
      domains: ['acme.com'],
      limit: 1,
      newerThanDays: 30,
      signal: new AbortController().signal,
    });

    expect(result).toHaveLength(1);
    expect(requestedMessages).toEqual(['m1']);
  });

  it('rejects an oversized provider response before JSON projection', async () => {
    const fetchImpl: GoogleFetch = async () =>
      jsonResponse(
        { emailAddress: 'owner@salesko.dev' },
        200,
        { 'content-length': String(129 * 1024) },
      );
    const provider = new GoogleGmailReadProvider({ fetchImpl });

    await expect(
      provider.searchCorrespondence({
        accessToken: ACCESS_TOKEN,
        domains: ['acme.com'],
        limit: 1,
        newerThanDays: 30,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Gmail response exceeds the local byte limit');
  });

  it('passes the broker abort signal to every Gmail fetch', async () => {
    const controller = new AbortController();
    const fetchImpl: GoogleFetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const provider = new GoogleGmailReadProvider({ fetchImpl });
    const pending = provider.searchCorrespondence({
      accessToken: ACCESS_TOKEN,
      domains: ['acme.com'],
      limit: 1,
      newerThanDays: 30,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('Gmail API request failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
