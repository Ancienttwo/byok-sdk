import {
  BOARD_STATUSES,
  isCoreConflictError,
  isCoreError,
  type BoardItem,
  type BoardListQuery,
  type BoardPage,
} from '@byok-sdk/core';
import type { Context } from 'hono';
import { z } from 'zod';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';

export const DEFAULT_BOARD_PAGE_LIMIT = 50;
export const DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS = 5_000;
export const DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS = 120_000;

export interface BoardRouteDeps extends DeviceRouteDeps {
  readonly pageLimit: number;
}

export interface BoardStreamRouteDeps extends BoardRouteDeps {
  readonly queryIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly reconciliationIntervalMs: number;
}

const ClaimBodySchema = z.object({ expectedStatus: z.enum(BOARD_STATUSES).optional() });
const StatusBodySchema = z.object({
  expectedStatus: z.enum(BOARD_STATUSES),
  status: z.enum(BOARD_STATUSES),
});

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boardQuery(c: Context, pageLimit: number): BoardListQuery | undefined {
  const afterSeq = parseNonNegativeInteger(c.req.query('since'));
  const limit = parsePositiveInteger(c.req.query('limit'), pageLimit);
  const statusRaw = c.req.query('status');
  if (afterSeq === undefined || limit === undefined || limit > pageLimit) return undefined;
  if (statusRaw !== undefined && !BOARD_STATUSES.includes(statusRaw as (typeof BOARD_STATUSES)[number])) {
    return undefined;
  }
  return {
    afterSeq,
    limit,
    ...(c.req.query('channel') === undefined ? {} : { channel: c.req.query('channel') }),
    ...(statusRaw === undefined ? {} : { status: statusRaw as (typeof BOARD_STATUSES)[number] }),
  };
}

export function boardListHandler(deps: BoardRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const query = boardQuery(c, deps.pageLimit);
    if (query === undefined) return c.json({ error: 'invalid board query' }, 400);
    return c.json(await authenticated.stores.board.list(query), 200);
  };
}

export function boardClaimHandler(deps: DeviceRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const parsed = ClaimBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid claim body' }, 400);
    const itemId = c.req.param('id');
    if (itemId === undefined || itemId.length === 0) return c.json({ error: 'invalid board item id' }, 400);
    try {
      const item = await authenticated.stores.board.claim({
        itemId,
        holderId: authenticated.device.deviceId,
        ...(parsed.data.expectedStatus === undefined
          ? {}
          : { expectedStatus: parsed.data.expectedStatus }),
      });
      return c.json(item, 200);
    } catch (caught) {
      return boardFailure(c, caught);
    }
  };
}

export function boardUnclaimHandler(deps: DeviceRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const itemId = c.req.param('id');
    if (itemId === undefined || itemId.length === 0) return c.json({ error: 'invalid board item id' }, 400);
    try {
      return c.json(
        await authenticated.stores.board.unclaim({
          itemId,
          holderId: authenticated.device.deviceId,
        }),
        200,
      );
    } catch (caught) {
      return boardFailure(c, caught);
    }
  };
}

export function boardStatusHandler(deps: DeviceRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const parsed = StatusBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'invalid status body' }, 400);
    const itemId = c.req.param('id');
    if (itemId === undefined || itemId.length === 0) return c.json({ error: 'invalid board item id' }, 400);
    if (parsed.data.status === 'done') {
      return c.json({ error: 'done requires host review acceptance' }, 403);
    }
    try {
      return c.json(
        await authenticated.stores.board.updateStatus({
          itemId,
          expectedStatus: parsed.data.expectedStatus,
          status: parsed.data.status,
          holderId: authenticated.device.deviceId,
        }),
        200,
      );
    } catch (caught) {
      return boardFailure(c, caught);
    }
  };
}

export function boardStreamHandler(deps: BoardStreamRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const firstAuth = await authenticateDevice(c, deps);
    if (firstAuth === undefined) return c.json({ error: 'unauthorized' }, 401);
    const query = boardQuery(c, deps.pageLimit);
    if (query === undefined) return c.json({ error: 'invalid board query' }, 400);

    const querySince = query.afterSeq ?? 0;
    const headerRaw = c.req.header('last-event-id');
    const headerSince = headerRaw === undefined ? undefined : parseNonNegativeInteger(headerRaw);
    if (headerRaw !== undefined && headerSince === undefined) {
      return c.json({ error: 'invalid Last-Event-ID' }, 400);
    }
    if (headerSince !== undefined && c.req.query('since') !== undefined && headerSince !== querySince) {
      return c.json({ error: 'conflicting stream cursors' }, 400);
    }

    let stopped = false;
    const stopController = new AbortController();
    const signal = c.req.raw.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => {
          stopped = true;
          stopController.abort();
          closeController(controller);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void pumpBoardStream(
          controller,
          c,
          deps,
          { ...query, afterSeq: headerSince ?? querySince },
          () => stopped || signal.aborted,
          stopController.signal,
        ).finally(() => {
          stopped = true;
          stopController.abort();
          signal.removeEventListener('abort', onAbort);
          closeController(controller);
        });
      },
      cancel() {
        stopped = true;
        stopController.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });
  };
}

async function pumpBoardStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  c: Context,
  deps: BoardStreamRouteDeps,
  initialQuery: BoardListQuery,
  isStopped: () => boolean,
  stopSignal: AbortSignal,
): Promise<void> {
  let cursor = initialQuery.afterSeq ?? 0;
  let lastHeartbeat = performance.now();
  let lastReconcile = performance.now();
  while (!isStopped()) {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return;

    const page = await authenticated.stores.board.list({ ...initialQuery, afterSeq: cursor });
    for (const item of page.items) {
      enqueue(controller, `event: board\nid: ${item.boardSeq}\ndata: ${JSON.stringify(item)}\n\n`);
      cursor = item.boardSeq;
    }
    if (page.hasMore) continue;

    const now = performance.now();
    if (now - lastReconcile >= deps.reconciliationIntervalMs) {
      enqueue(controller, `event: reconcile\ndata: ${JSON.stringify({ since: 0 })}\n\n`);
      lastReconcile = now;
    }
    if (now - lastHeartbeat >= deps.heartbeatIntervalMs) {
      enqueue(controller, ': heartbeat\n\n');
      lastHeartbeat = now;
    }
    await abortableSleep(deps.queryIntervalMs, stopSignal);
  }
}

function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, value: string): void {
  try {
    controller.enqueue(new TextEncoder().encode(value));
  } catch {
    // The request abort/cancel path owns closure. A closed controller is terminal.
  }
}

function closeController(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // Already closed by the peer or the pump.
  }
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function boardFailure(c: Context, caught: unknown): Response {
  if (isCoreConflictError<BoardItem>(caught)) {
    const holder = caught.current.assignee;
    return c.json(
      {
        error: caught.code,
        current: caught.current,
        observedAt: caught.observedAt,
        ...(holder === undefined ? {} : { holder: { ...holder, observedAt: caught.observedAt } }),
      },
      409,
    );
  }
  if (isCoreError(caught, 'board_item_not_found')) return c.json({ error: caught.code }, 404);
  if (isCoreError(caught, 'board_not_held')) return c.json({ error: caught.code }, 409);
  throw caught;
}

export type BoardPollResponse = BoardPage;
