/**
 * The request side of the `proof` route class: read the raw body under a byte
 * cap, then authenticate the device proof header against that exact body.
 * The proof binds the body hash, so the body is read before authentication.
 */
import { DEVICE_PROOF_HEADER } from '@byok-sdk/core';
import type { Context } from 'hono';
import {
  authenticateDeviceProof,
  type AuthenticatedDeviceProof,
  type DeviceProofAuthDeps,
} from '../auth/device-proof';
import { cancelBody, readBoundedRawBody } from './shared';

export const MAX_DEVICE_PROOF_HEADER_BYTES = 16 * 1024;

/** The raw request body, `'too_large'` over `maximum`, or `undefined` for an unreadable body. */
export async function readProofRequestBody(
  c: Context,
  maximum: number,
): Promise<Uint8Array | 'too_large' | undefined> {
  const length = c.req.header('content-length');
  if (length !== undefined) {
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
    if (parsed > maximum) {
      cancelBody(c.req.raw.body);
      return 'too_large';
    }
  }
  try {
    return await readBoundedRawBody(c.req.raw.body, maximum);
  } catch {
    return undefined;
  }
}

/** `undefined` means "answer 401", for every refused proof alike. */
export async function authenticateProofRequest(
  c: Context,
  deps: DeviceProofAuthDeps,
  request: { readonly body: Uint8Array; readonly operation: string; readonly resource: string },
): Promise<AuthenticatedDeviceProof | undefined> {
  const proof = decodeProofHeader(c.req.header(DEVICE_PROOF_HEADER));
  if (proof === undefined) return undefined;
  const url = new URL(c.req.url);
  return authenticateDeviceProof(
    proof,
    {
      method: c.req.method,
      path: `${url.pathname}${url.search}`,
      operation: request.operation,
      resource: request.resource,
      body: request.body,
    },
    deps,
  );
}

function decodeProofHeader(value: string | undefined): unknown | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_DEVICE_PROOF_HEADER_BYTES) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
