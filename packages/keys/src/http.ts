import { ByokKeysError } from './errors';
import { normalizeProviderUrl } from './url';

/** Injectable `fetch`. Defaults to `globalThis.fetch` at every call site. */
export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Response body ceiling, ported from `providers.ts:106`. */
export const PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/** Per-request timeout, ported from `providers.ts:107`. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Issue a provider request under the source's guards
 * (`providers.ts:1711-1743`): the URL is re-validated immediately before the
 * call, the caller's abort signal is chained, and an internal timeout aborts
 * with a distinguishable reason so a timeout maps to
 * `PROVIDER_REQUEST_TIMEOUT` rather than a bare `AbortError`. The returned
 * response owns the guarded body: consume or cancel it to release the guard;
 * otherwise the original deadline cancels it. Neither headers nor body reads
 * depend on the injected transport honoring its abort signal.
 */
export async function fetchWithProviderGuards(
  fetchImpl: ProviderFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  normalizeProviderUrl(url);
  signal.throwIfAborted();
  const controller = new AbortController();
  let ownedResponse: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  let cleanedUp = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // The header race may already be settled when body cancellation rejects this.
  void aborted.catch(() => {});
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  };
  const disposeBody = (reason: unknown) => {
    // Transfer ownership out before cancellation: observer, abort and await
    // continuation may all try to dispose, but only one owns the resource.
    const ownedReader = reader;
    const response = ownedResponse;
    reader = undefined;
    ownedResponse = undefined;
    // An injected cancel hook may itself stall or reject. Never await it.
    if (ownedReader) {
      void ownedReader.cancel(reason).catch(() => {});
      ownedReader.releaseLock();
    } else if (response) {
      void response.body?.cancel(reason).catch(() => {});
    }
  };
  const abort = (reason: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    rejectAbort(reason);
    bodyController?.error(reason);
    disposeBody(reason);
    controller.abort(reason);
  };
  const onAbort = () => abort(signal.reason);
  const timeout = setTimeout(() => abort(new ByokKeysError(
    'PROVIDER_REQUEST_TIMEOUT',
    'Provider request timed out',
  )), PROVIDER_TIMEOUT_MS);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const pending = Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal }));
    // Acquire ownership in the first response reaction, including when fetch
    // ignores abort. Keep it across the race's separate await continuation.
    void pending.then(response => {
      ownedResponse = response;
      if (finished) disposeBody(controller.signal.reason);
    }, () => {});
    const response = await Promise.race([pending, aborted]);
    if (finished) {
      disposeBody(controller.signal.reason);
      throw controller.signal.reason;
    }
    if (!response.body) {
      ownedResponse = undefined;
      finished = true;
      cleanup();
      return response;
    }
    reader = response.body.getReader();
    ownedResponse = undefined;
    // Keep reads demand-driven so bounded consumers can stop at the crossing
    // chunk without this wrapper prefetching another source chunk.
    const body = new ReadableStream<Uint8Array>({
      start(streamController) { bodyController = streamController; },
      async pull(streamController) {
        try {
          const chunk = await reader!.read();
          if (finished) return;
          if (chunk.done) {
            finished = true;
            cleanup();
            reader!.releaseLock();
            streamController.close();
          } else {
            streamController.enqueue(chunk.value);
          }
        } catch (error) {
          if (finished) return;
          finished = true;
          cleanup();
          reader!.releaseLock();
          streamController.error(error);
        }
      },
      cancel(reason) {
        if (finished) return;
        finished = true;
        cleanup();
        disposeBody(reason);
        controller.abort(reason);
      },
    }, { highWaterMark: 0 });
    const guarded = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Rewrapping transfers body ownership but must retain fetch metadata.
    for (const key of ['url', 'redirected', 'type'] as const) {
      Object.defineProperty(guarded, key, { value: response[key] });
    }
    return guarded;
  } catch (error) {
    finished = true;
    cleanup();
    disposeBody(error);
    throw error;
  }
}

/**
 * Read a JSON body with a size ceiling (`providers.ts:1825-1851`). The
 * `content-length` check is an early exit. Count actual transport body bytes
 * before decoding each chunk: headers may be absent, false, or compressed.
 * Cancel at the first chunk crossing the ceiling without waiting for EOF.
 */
export async function parseBoundedJsonResponse(
  response: Response,
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > PROVIDER_RESPONSE_MAX_BYTES
  ) {
    void response.body?.cancel().catch(() => {});
    throw new ByokKeysError(
      'PROVIDER_RESPONSE_TOO_LARGE',
      'Provider response exceeds the local safety limit',
    );
  }
  if (response.bodyUsed) throw new TypeError('Response body is already consumed');
  let text = '';
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Fetch exposes decompressed bytes. Do not decode or retain a chunk
        // that exceeds the remaining budget, even if no EOF ever arrives.
        if (value.byteLength > PROVIDER_RESPONSE_MAX_BYTES - bytes) {
          throw new ByokKeysError(
            'PROVIDER_RESPONSE_TOO_LARGE',
            'Provider response exceeds the local safety limit',
          );
        }
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      // Cancellation hooks are untrusted: release our lock and reject now.
      void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ByokKeysError(
      'PROVIDER_RESPONSE_INVALID',
      'Provider returned invalid JSON',
    );
  }
}

/**
 * Parse a model-provider response, mapping non-2xx to a classified error
 * (`providers.ts:1748-1769`). The source's `context` parameter only chose
 * between two error classes; this package has one, so the parameter is gone.
 */
export async function readModelProviderResponse(
  response: Response,
): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await parseBoundedJsonResponse(response);
  } catch (error) {
    if (
      !response.ok &&
      error instanceof ByokKeysError &&
      error.code === 'PROVIDER_RESPONSE_INVALID'
    ) {
      throw modelProviderHttpError(response.status, undefined);
    }
    throw error;
  }
  if (!response.ok) {
    throw modelProviderHttpError(response.status, payload);
  }
  return payload;
}

function modelProviderHttpError(
  status: number,
  payload: unknown,
): ByokKeysError {
  return new ByokKeysError(
    classifyModelProviderHttpError(status, payload),
    `Model provider request failed with HTTP ${status}`,
    { httpStatus: status },
  );
}

/**
 * Map an HTTP status plus error body onto a stable code
 * (`providers.ts:1783-1815`). Providers disagree on status codes for billing
 * and key problems, so the body text is inspected as well — the pattern lists
 * are verbatim from the source, including the Chinese-language variants the
 * source's providers actually return.
 */
export function classifyModelProviderHttpError(
  status: number,
  payload: unknown,
): string {
  const detail = safeProviderErrorText(payload);
  if (
    status === 402 ||
    /(?:insufficient[_ -]?(?:quota|balance|credit)|quota[_ -]?exceeded|billing|payment required|余额不足|额度不足|欠费|充值)/iu.test(
      detail,
    )
  ) {
    return 'MODEL_PROVIDER_BALANCE_INSUFFICIENT';
  }
  if (
    status === 401 ||
    status === 403 ||
    /(?:invalid[_ -]?api[_ -]?key|authentication|unauthori[sz]ed|forbidden|鉴权失败|密钥无效|令牌无效)/iu.test(
      detail,
    )
  ) {
    return 'MODEL_PROVIDER_AUTH_FAILED';
  }
  if (
    status === 404 ||
    /(?:model[_ -]?not[_ -]?found|model does not exist|unknown model|模型不存在|无权访问模型)/iu.test(
      detail,
    )
  ) {
    return 'MODEL_PROVIDER_MODEL_NOT_FOUND';
  }
  if (status === 429) return 'MODEL_PROVIDER_RATE_LIMITED';
  return 'MODEL_PROVIDER_HTTP_ERROR';
}

function safeProviderErrorText(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? '')
      .slice(0, 8_000)
      .toLowerCase();
  } catch {
    return '';
  }
}

/** Join a normalized base URL with an API path, idempotently (`providers.ts:1949-1953`). */
export function modelApiUrl(baseUrl: string, suffix: string): string {
  const normalized = normalizeProviderUrl(baseUrl);
  if (normalized.endsWith(`/${suffix}`)) return normalized;
  return `${normalized}/${suffix}`;
}

/**
 * Flatten a message content field to text (`providers.ts:1955-1971`). Both
 * dialects return either a string or an array of typed blocks.
 */
export function modelMessageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(objectValue)
      .filter(
        (item): item is Record<string, unknown> =>
          item !== undefined && typeof item.text === 'string',
      )
      .map((item) => item.text as string)
      .join('');
  }
  throw new ByokKeysError(
    'MODEL_RESPONSE_INVALID',
    'Model response did not contain text',
  );
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `providers.ts:2301-2308` — an empty completion does not prove a live key. */
export function assertLiveModelResponse(value: string): void {
  if (value.trim().length === 0) {
    throw new ByokKeysError(
      'MODEL_RESPONSE_INVALID',
      'Model provider returned an empty completion during connection validation',
    );
  }
}
