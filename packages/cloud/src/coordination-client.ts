import {
  BOARD_STATUSES,
  assertCapability,
  hasCapability,
  type CapabilityDeclaration,
} from '@byok-sdk/core';
import { BYOK_BOARD_PATH, BYOK_BOARD_STREAM_PATH } from '@byok-sdk/protocol';
import { z } from 'zod';
import { CLOUD_CAPABILITIES } from './capabilities';

const BoardFeedItemSchema = z.object({
  tenantId: z.string(),
  itemId: z.string(),
  channel: z.string(),
  title: z.string(),
  status: z.enum(BOARD_STATUSES),
  assignee: z
    .object({ holderId: z.string(), heldSince: z.string() })
    .optional(),
  boardSeq: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const BoardFeedPageSchema = z.object({
  items: z.array(BoardFeedItemSchema),
  nextSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type BoardFeedItem = z.infer<typeof BoardFeedItemSchema>;
export type BoardFeedPage = z.infer<typeof BoardFeedPageSchema>;
export type BoardFeedMode = 'sse' | 'poll';
export type BoardFeedRead =
  | { readonly type: 'board'; readonly item: BoardFeedItem }
  | { readonly type: 'reconcile' }
  | { readonly type: 'poll'; readonly page: BoardFeedPage };

export class BoardFeedRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BoardFeedRetryableError';
  }
}

export class BoardFeedStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardFeedStoppedError';
  }
}

export interface BoardFeedClientOptions {
  readonly baseUrl: string | URL;
  readonly accessToken: string;
  readonly capabilities: CapabilityDeclaration;
  readonly fetch?: typeof globalThis.fetch;
  readonly idleWatchdogMs?: number;
}

/**
 * One board feed consumer with a declaration-fixed transport.
 *
 * The mode is selected once from ADR-010 data. A temporary SSE 5xx or idle
 * watchdog expiry raises {@link BoardFeedRetryableError}; it never mutates the
 * mode to polling. A caller retries the same instance and therefore the same
 * declared transport. Polling exists only when `board.sse` was absent from the
 * declaration in the first place.
 */
export class BoardFeedClient {
  readonly mode: BoardFeedMode;
  readonly #base: URL;
  readonly #accessToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #idleWatchdogMs: number;

  constructor(options: BoardFeedClientOptions) {
    assertCapability(options.capabilities, CLOUD_CAPABILITIES.boardCoordination);
    this.mode = hasCapability(options.capabilities, CLOUD_CAPABILITIES.boardSse) ? 'sse' : 'poll';
    this.#base = new URL(options.baseUrl);
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#idleWatchdogMs = options.idleWatchdogMs ?? 30_000;
  }

  async readOnce(afterSeq: number, signal?: AbortSignal): Promise<BoardFeedRead> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new TypeError('afterSeq must be a non-negative safe integer.');
    }
    return this.mode === 'sse'
      ? this.#readSseOnce(afterSeq, signal)
      : this.#readPollOnce(afterSeq, signal);
  }

  async #readPollOnce(afterSeq: number, signal?: AbortSignal): Promise<BoardFeedRead> {
    const url = new URL(BYOK_BOARD_PATH, this.#base);
    url.searchParams.set('since', String(afterSeq));
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${this.#accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    });
    assertBoardResponse(response, 'poll');
    return { type: 'poll', page: BoardFeedPageSchema.parse(await response.json()) };
  }

  async #readSseOnce(afterSeq: number, signal?: AbortSignal): Promise<BoardFeedRead> {
    const url = new URL(BYOK_BOARD_STREAM_PATH, this.#base);
    const response = await this.#fetch(url, {
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${this.#accessToken}`,
        'last-event-id': String(afterSeq),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    assertBoardResponse(response, 'SSE');
    if (response.body === null) throw new BoardFeedRetryableError('Board SSE response had no body.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const chunk = await readWithWatchdog(reader, this.#idleWatchdogMs);
        if (chunk.done) throw new BoardFeedRetryableError('Board SSE ended before the next event.');
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseFrame(frame);
          if (parsed !== undefined) return parsed;
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function assertBoardResponse(response: Response, transport: 'poll' | 'SSE'): void {
  if (response.status === 401) {
    throw new BoardFeedStoppedError('Board credential is no longer valid.');
  }
  if (response.ok) return;
  if (response.status >= 500) {
    throw new BoardFeedRetryableError(`Board ${transport} failed with HTTP ${response.status}.`);
  }
  throw new BoardFeedStoppedError(
    `Board ${transport} failed permanently with HTTP ${response.status}.`,
  );
}

async function readWithWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BoardFeedRetryableError('Board SSE idle watchdog expired.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseSseFrame(frame: string): BoardFeedRead | undefined {
  if (frame.length === 0 || frame.startsWith(':')) return undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trimStart();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (event === 'reconcile') return { type: 'reconcile' };
  if (event !== 'board') return undefined;
  if (data.length === 0) throw new SyntaxError('Board SSE board event had no data.');
  return { type: 'board', item: BoardFeedItemSchema.parse(JSON.parse(data.join('\n'))) };
}
