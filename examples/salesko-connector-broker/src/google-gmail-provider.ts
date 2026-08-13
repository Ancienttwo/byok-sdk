import emailAddresses from 'email-addresses';
import { z } from 'zod';
import {
  EmailDomainSchema,
  GmailCorrespondenceSchema,
  NormalizedEmailAddressSchema,
  type GmailCorrespondence,
  type GmailProviderSearchInput,
  type GmailReadProvider,
} from './broker';
import {
  GOOGLE_GMAIL_PROFILE_ENDPOINT,
  type GoogleFetch,
} from './google-oauth';

export const GOOGLE_GMAIL_MESSAGES_ENDPOINT =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages';

const GMAIL_LIST_RESPONSE_MAX_BYTES = 256 * 1024;
const GMAIL_MESSAGE_RESPONSE_MAX_BYTES = 128 * 1024;
const GMAIL_MAX_CANDIDATE_MESSAGES = 100;

const GoogleGmailSearchSchema = z
  .object({
    accessToken: z.string().min(16).max(2_048).regex(/^[^\u0000-\u0020\u007f]+$/u),
    domains: z.array(EmailDomainSchema).min(1).max(16),
    limit: z.number().int().min(1).max(25),
    newerThanDays: z.number().int().min(1).max(365),
    signal: z.instanceof(AbortSignal),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, domain] of value.domains.entries()) {
      if (seen.has(domain)) {
        ctx.addIssue({ code: 'custom', path: ['domains', index], message: 'duplicate domain' });
      }
      seen.add(domain);
    }
  });

const GmailProfileSchema = z
  .object({ emailAddress: NormalizedEmailAddressSchema })
  .passthrough();

const GmailMessageRefSchema = z
  .object({
    id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u),
    threadId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  })
  .passthrough();

const GmailListResponseSchema = z
  .object({
    messages: z.array(GmailMessageRefSchema).max(GMAIL_MAX_CANDIDATE_MESSAGES).optional(),
    nextPageToken: z.string().max(2_048).optional(),
    resultSizeEstimate: z.number().int().min(0).optional(),
  })
  .passthrough();

const GmailHeaderSchema = z
  .object({
    name: z.string().min(1).max(160),
    value: z.string().min(1).max(8_192),
  })
  .passthrough();

const GmailMessageSchema = z
  .object({
    id: GmailMessageRefSchema.shape.id,
    threadId: GmailMessageRefSchema.shape.threadId,
    internalDate: z.string().regex(/^\d{1,16}$/u),
    payload: z
      .object({ headers: z.array(GmailHeaderSchema).max(256) })
      .passthrough(),
  })
  .passthrough();

interface ParsedMailbox {
  readonly address: string;
  readonly displayName?: string;
  readonly domain: string;
}

export interface GoogleGmailReadProviderOptions {
  readonly fetchImpl?: GoogleFetch;
}

async function readBoundedJson(
  response: Response,
  byteLimit: number,
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > byteLimit) {
    throw new Error('Gmail response exceeds the local byte limit');
  }
  if (!response.body) throw new Error('Gmail response body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > byteLimit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Gmail response exceeds the local byte limit');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Gmail response exceeds the local byte limit') {
      throw error;
    }
    throw new Error('Gmail response body could not be read');
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error('Gmail response is not valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gmail response is not valid JSON');
  }
}

async function getJson(
  fetchImpl: GoogleFetch,
  url: URL | string,
  accessToken: string,
  signal: AbortSignal,
  byteLimit: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch {
    throw new Error('Gmail API request failed');
  }
  if (!response.ok) throw new Error(`Gmail API request failed with HTTP ${response.status}`);
  return readBoundedJson(response, byteLimit);
}

function normalizeMailbox(
  mailbox: emailAddresses.ParsedMailbox,
): ParsedMailbox | undefined {
  const domain = mailbox.domain.toLowerCase();
  if (!EmailDomainSchema.safeParse(domain).success) return undefined;
  const address = `${mailbox.local}@${domain}`;
  if (!NormalizedEmailAddressSchema.safeParse(address).success) return undefined;
  const displayName = mailbox.name?.trim();
  const safeDisplayName =
    displayName &&
    displayName.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(displayName)
      ? displayName
      : undefined;
  return { address, domain, ...(safeDisplayName ? { displayName: safeDisplayName } : {}) };
}

function parseMailboxes(value: string | undefined): ParsedMailbox[] {
  if (!value || Buffer.byteLength(value, 'utf8') > 8_192) return [];
  let parsed:
    | Array<emailAddresses.ParsedMailbox | emailAddresses.ParsedGroup>
    | null;
  try {
    parsed = emailAddresses.parseAddressList({
      input: value,
      partial: false,
      rejectTLD: true,
      rfc6532: false,
      strict: true,
    });
  } catch {
    return [];
  }
  if (!parsed) return [];
  const mailboxes: emailAddresses.ParsedMailbox[] = [];
  for (const item of parsed) {
    if (item.type === 'mailbox') mailboxes.push(item);
    else mailboxes.push(...item.addresses);
  }
  return mailboxes
    .map(normalizeMailbox)
    .filter((mailbox): mailbox is ParsedMailbox => mailbox !== undefined);
}

function headerValue(
  headers: readonly z.infer<typeof GmailHeaderSchema>[],
  name: string,
): string | undefined {
  const matches = headers.filter(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  );
  return matches.length === 1 ? matches[0]?.value : undefined;
}

function projectMessage(
  value: unknown,
  expectedMessageId: string,
  accountEmail: string,
  requestedDomains: ReadonlySet<string>,
): GmailCorrespondence | undefined {
  const parsed = GmailMessageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.id !== expectedMessageId) {
    throw new Error('Gmail messages.get returned a mismatched message id');
  }
  const from = parseMailboxes(headerValue(parsed.data.payload.headers, 'From'));
  if (from.length !== 1) return undefined;
  const sender = from[0];
  if (!sender) return undefined;
  const normalizedAccount = accountEmail.toLowerCase();
  let correspondent: ParsedMailbox | undefined;
  let direction: 'inbound' | 'outbound';
  if (sender.address.toLowerCase() === normalizedAccount) {
    const recipients = [
      ...parseMailboxes(headerValue(parsed.data.payload.headers, 'To')),
      ...parseMailboxes(headerValue(parsed.data.payload.headers, 'Cc')),
    ];
    correspondent = recipients.find((mailbox) => requestedDomains.has(mailbox.domain));
    direction = 'outbound';
  } else {
    if (!requestedDomains.has(sender.domain)) return undefined;
    correspondent = sender;
    direction = 'inbound';
  }
  if (!correspondent) return undefined;
  const internalDateMs = Number(parsed.data.internalDate);
  if (!Number.isSafeInteger(internalDateMs) || internalDateMs < 0) return undefined;
  const occurredDate = new Date(internalDateMs);
  if (!Number.isFinite(occurredDate.getTime())) return undefined;
  const occurredAt = occurredDate.toISOString();
  const projected = {
    messageId: parsed.data.id,
    ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}),
    correspondent: {
      email: correspondent.address,
      ...(correspondent.displayName ? { displayName: correspondent.displayName } : {}),
    },
    direction,
    occurredAt,
  };
  const result = GmailCorrespondenceSchema.safeParse(projected);
  return result.success ? result.data : undefined;
}

function gmailQuery(domains: readonly string[], newerThanDays: number): string {
  const domainTerms = domains.flatMap((domain) => [
    `from:${domain}`,
    `to:${domain}`,
  ]);
  return `newer_than:${newerThanDays}d {${domainTerms.join(' ')}}`;
}

/**
 * Real read-only Gmail REST adapter. It requests message metadata only and
 * projects one exact-domain correspondent per message; bodies, snippets and
 * subjects never enter the returned value.
 */
export class GoogleGmailReadProvider implements GmailReadProvider {
  readonly #fetchImpl: GoogleFetch;

  constructor(options: GoogleGmailReadProviderOptions = {}) {
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') {
      throw new Error('Google Gmail fetch implementation is invalid');
    }
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async searchCorrespondence(input: GmailProviderSearchInput): Promise<unknown> {
    const validated = GoogleGmailSearchSchema.safeParse(input);
    if (!validated.success) throw new Error('Google Gmail search input is invalid');
    const request = validated.data;
    const profile = GmailProfileSchema.safeParse(
      await getJson(
        this.#fetchImpl,
        GOOGLE_GMAIL_PROFILE_ENDPOINT,
        request.accessToken,
        request.signal,
        GMAIL_MESSAGE_RESPONSE_MAX_BYTES,
      ),
    );
    if (!profile.success) throw new Error('Gmail profile response is invalid');

    const maxCandidates = Math.min(
      GMAIL_MAX_CANDIDATE_MESSAGES,
      Math.max(20, request.limit * 4),
    );
    const listUrl = new URL(GOOGLE_GMAIL_MESSAGES_ENDPOINT);
    listUrl.searchParams.set('q', gmailQuery(request.domains, request.newerThanDays));
    listUrl.searchParams.set('maxResults', String(maxCandidates));
    listUrl.searchParams.set('includeSpamTrash', 'false');
    listUrl.searchParams.set('fields', 'messages/id');
    const listed = GmailListResponseSchema.safeParse(
      await getJson(
        this.#fetchImpl,
        listUrl,
        request.accessToken,
        request.signal,
        GMAIL_LIST_RESPONSE_MAX_BYTES,
      ),
    );
    if (!listed.success) throw new Error('Gmail messages.list response is invalid');

    const references = listed.data.messages ?? [];
    if (new Set(references.map((reference) => reference.id)).size !== references.length) {
      throw new Error('Gmail messages.list returned duplicate message ids');
    }
    const requestedDomains = new Set(request.domains);
    const results: GmailCorrespondence[] = [];
    for (const reference of references) {
      if (results.length >= request.limit) break;
      const messageUrl = new URL(
        `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(reference.id)}`,
      );
      messageUrl.searchParams.set('format', 'metadata');
      messageUrl.searchParams.append('metadataHeaders', 'From');
      messageUrl.searchParams.append('metadataHeaders', 'To');
      messageUrl.searchParams.append('metadataHeaders', 'Cc');
      messageUrl.searchParams.set(
        'fields',
        'id,threadId,internalDate,payload/headers',
      );
      const message = await getJson(
        this.#fetchImpl,
        messageUrl,
        request.accessToken,
        request.signal,
        GMAIL_MESSAGE_RESPONSE_MAX_BYTES,
      );
      const projected = projectMessage(
        message,
        reference.id,
        profile.data.emailAddress,
        requestedDomains,
      );
      if (projected) results.push(projected);
    }
    return results;
  }
}
