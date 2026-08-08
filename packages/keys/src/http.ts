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
 * `PROVIDER_REQUEST_TIMEOUT` rather than a bare `AbortError`.
 */
export async function fetchWithProviderGuards(
  fetchImpl: ProviderFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  normalizeProviderUrl(url);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeout = setTimeout(
    () => controller.abort('provider_timeout'),
    PROVIDER_TIMEOUT_MS,
  );
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (
      !signal.aborted &&
      controller.signal.aborted &&
      controller.signal.reason === 'provider_timeout'
    ) {
      throw new ByokKeysError(
        'PROVIDER_REQUEST_TIMEOUT',
        'Provider request timed out',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Read a JSON body with a size ceiling (`providers.ts:1825-1851`). The
 * `content-length` check is an early exit; the decoded-byte check is the one
 * that actually holds, since `content-length` is attacker-controlled.
 */
export async function parseBoundedJsonResponse(
  response: Response,
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > PROVIDER_RESPONSE_MAX_BYTES
  ) {
    throw new ByokKeysError(
      'PROVIDER_RESPONSE_TOO_LARGE',
      'Provider response exceeds the local safety limit',
    );
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > PROVIDER_RESPONSE_MAX_BYTES) {
    throw new ByokKeysError(
      'PROVIDER_RESPONSE_TOO_LARGE',
      'Provider response exceeds the local safety limit',
    );
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
