/**
 * The two things every device-facing handler starts from: a tolerant JSON body
 * read, and the bearer -> principal -> tenant-closed-facade step.
 *
 * Once {@link authenticateDevice} has answered, a handler holds a
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

export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
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
      return { body: undefined, tooLarge: true };
    }
  }

  const stream = c.req.raw.body;
  if (stream === null) return { body: undefined, tooLarge: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - total) {
        try {
          await reader.cancel();
        } catch {
          // The request is already over the ceiling; cancellation failure does
          // not make it safe to parse or retain the body.
        }
        return { body: undefined, tooLarge: true };
      }
      if (value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return { body: undefined, tooLarge: false };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: parseJsonBytes(bytes), tooLarge: false };
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
