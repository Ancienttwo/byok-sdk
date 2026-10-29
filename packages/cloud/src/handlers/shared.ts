/**
 * The two things every device-facing handler starts from: a JSON body read
 * under that route's own byte ceiling, and admission — the bearer -> principal
 * -> tenant-closed-facade step plus one debit of the device's rate budget.
 *
 * Once {@link admitDeviceRequest} has answered, a handler holds a
 * `TenantStores` and a `DevicePrincipal` and never sees a `TenantId` again.
 */
import type { Context } from 'hono';
import type { DevicePrincipal } from '@byok-sdk/core';
import { authenticateBearer, type BearerAuthDeps } from '../auth/bearer';
import { tenantStoresFor, type CloudRootStores, type TenantStores } from '../tenant-stores';

/** Every error response on this surface is `{ error }` — the same shape the reference server uses. */
export interface ErrorBody {
  readonly error: string;
}

export interface BoundedJsonBodyResult {
  readonly body: unknown;
  readonly tooLarge: boolean;
}

/**
 * Read and parse one JSON request while retaining a hard byte ceiling before
 * JSON.parse. The declared length is only an early rejection; the stream is
 * still counted because chunked requests may omit Content-Length or lie about
 * it. Invalid JSON remains represented by `body: undefined` for the caller's
 * existing validation status.
 */
export async function readBoundedJsonBody(
  c: Context,
  maximum: number,
): Promise<BoundedJsonBodyResult> {
  const declaredLength = c.req.header('content-length');
  if (declaredLength !== undefined) {
    const parsedLength = parseContentLength(declaredLength);
    if (parsedLength !== undefined && parsedLength > BigInt(maximum)) {
      cancelBody(c.req.raw.body);
      return { body: undefined, tooLarge: true };
    }
  }

  const bytes = await readBoundedRawBody(c.req.raw.body, maximum);
  return {
    body: bytes === undefined || bytes === 'too_large' ? undefined : parseJsonBytes(bytes),
    tooLarge: bytes === 'too_large',
  };
}

/**
 * Count actual request bytes before retaining each chunk. Keep the bytes intact
 * for consumers that authenticate a raw-body hash before decoding JSON.
 * Content-Length policy belongs to the caller; it never replaces this ceiling.
 */
export async function readBoundedRawBody(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array | 'too_large' | undefined> {
  if (stream === null) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - total) {
        cancelBody(reader);
        return 'too_large';
      }
      if (value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Cancellation is a resource-release best effort that is never awaited before
 * rejecting an already oversized request. `ReadableStream.cancel()` is used
 * before a reader exists; `ReadableStreamDefaultReader.cancel()` owns the
 * same underlying request stream after an overflow has been observed.
 */
export function cancelBody(
  body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null,
): void {
  if (body === null) return;
  try {
    void Promise.resolve(body.cancel()).catch(() => {
      // An already over-limit request must remain a 413 even when its producer
      // cannot be cancelled (for example, a disconnected or misbehaving peer).
    });
  } catch {
    // An already over-limit request must remain a 413 even when its producer
    // cannot be cancelled (for example, a disconnected or misbehaving peer).
  }
}

function parseContentLength(value: string): bigint | undefined {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  try {
    return BigInt(normalized);
  } catch {
    return undefined;
  }
}

function parseJsonBytes(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

export interface DeviceRouteDeps {
  readonly bearer: BearerAuthDeps;
  readonly root: CloudRootStores;
}

export interface AuthenticatedDeviceContext {
  readonly device: DevicePrincipal;
  readonly stores: TenantStores;
}

/**
 * Admission for every device-class route except `POST /byok/messages`:
 * authenticate the bearer, then spend one `request` unit of the device's rate
 * budget. Answers the refusal itself — 401 for any credential failure (see
 * {@link authenticateDevice}), 429 with `Retry-After` when the budget is spent.
 */
export async function admitDeviceRequest(
  c: Context,
  deps: DeviceRouteDeps,
): Promise<AuthenticatedDeviceContext | Response> {
  const authenticated = await authenticateDevice(c, deps);
  if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
  const admission = await authenticated.stores.rateLimiter.consume(authenticated.device.deviceId, 'request');
  if (!admission.allowed) return rateLimited(c, admission.retryAfterMs);
  return authenticated;
}

/** A spent rate budget: 429 with `Retry-After` rounded up to whole seconds (at least 1). */
export function rateLimited(c: Context, retryAfterMs: number): Response {
  return c.json({ error: 'rate limit exceeded' }, 429, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
}

/**
 * Authentication alone, with no rate debit. Only two callers may skip the
 * debit: `POST /byok/messages`, whose envelopes each spend an `envelope` unit
 * at the inbound gate, and re-checks inside a request that was already
 * admitted (the board stream's pump). Every other device route admits through
 * {@link admitDeviceRequest}.
 *
 * `undefined` means "answer 401" — and it means that for a missing header, a
 * forged token, an expired token, a revoked device, a product mismatch, and a
 * token whose tenant does not own the device, indistinguishably.
 */
export async function authenticateDevice(
  c: Context,
  deps: DeviceRouteDeps,
): Promise<AuthenticatedDeviceContext | undefined> {
  const device = await authenticateBearer(c.req.header('authorization'), deps.bearer);
  if (device === undefined) return undefined;
  return { device, stores: tenantStoresFor(device, deps.root) };
}
