import { parseDeviceAssertionEnvelope, type DeviceAssertionEnvelopeV1 } from '@byok-sdk/core';
import { connectControlClient } from '../bin/control-client';
import { ControlError, type AssertionIssueErrorCode, type AssertionIssueResult } from './control-protocol';
import { DeviceStore } from './store';

/**
 * Plan `device-assertion-broker`: the ONE public entry point a sibling local
 * process uses to obtain a device assertion from an already-running daemon.
 *
 * This module is the entire public surface of the control socket, and that is
 * deliberate. `connectControlClient`/`ControlClient` are NOT exported from the
 * package index and must not become exported: they can also `shutdown` the
 * daemon, resolve approvals, and subscribe to the raw task feed, and once any
 * of that is reachable from outside this package it is a compatibility surface
 * forever. A host that needs one specific capability gets one specific
 * function; `packages/client/src/__tests__/assertion-client.test.ts` pins that
 * the index exports nothing else. See also `bin/control-client.ts`'s own doc
 * comment for why connecting never throws.
 */

export interface RequestDeviceAssertionOptions {
  /** Same `productId` the daemon was configured with — selects which daemon's socket to dial. */
  productId: string;
  /** Same `storeDir` the daemon was configured with. Defaults to `~/.byok/<productId>`, exactly as the daemon's own default does. */
  storeDir?: string;
  /** The exact audience string, which must appear verbatim in the daemon's configured allowlist. */
  audience: string;
  /** Bound on the control-socket round trip, ms. Default 10s (the control client's own default). */
  timeoutMs?: number;
}

/**
 * The six refusals the daemon itself can answer with (see
 * `ASSERTION_ISSUE_ERROR_CODES`, `control-protocol.ts`) plus the two this
 * function can produce on its own:
 *
 * - `unavailable` — no reachable daemon control socket (not running, wrong
 *   `productId`/`storeDir`, or an unreadable control token). This is a local
 *   fact, NOT a statement about the device's pairing or revocation state.
 * - `bad_response` — a daemon answered, but with something that is not a
 *   well-formed assertion envelope. Fail-closed: a malformed envelope is never
 *   passed through to a caller who would then present it to a cloud.
 *
 * Typed as an open string union so an unrecognized wire code (a newer daemon
 * against an older caller) surfaces verbatim instead of being flattened into
 * something misleading.
 */
export type RequestDeviceAssertionErrorCode =
  | AssertionIssueErrorCode
  | 'unavailable'
  | 'bad_response'
  // `string & {}` keeps the six named codes as autocomplete suggestions while
  // still accepting any wire string verbatim — see this type's doc comment.
  | (string & {});

export type RequestDeviceAssertionResult =
  | { ok: true; assertion: DeviceAssertionEnvelopeV1; expiresAt: string }
  | { ok: false; code: RequestDeviceAssertionErrorCode; reason: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Asks a running daemon for one short-lived device assertion scoped to
 * `audience`.
 *
 * Never throws for an expected outcome — a missing daemon, a denied audience,
 * a revoked or unpaired device, and a daemon mid-shutdown all come back as
 * `{ok: false, code, reason}`, the same typed-result convention
 * `connectControlClient` already uses. The caller decides what to do about
 * each; nothing here retries, falls back, or degrades.
 *
 * What this function does NOT do, on purpose: cache the assertion, inspect the
 * claims to decide anything, or re-request on expiry. The assertion is
 * deliberately short-lived, and a cache here would be a second, unaudited copy
 * of a credential living outside the daemon that minted it.
 */
export async function requestDeviceAssertion(
  options: RequestDeviceAssertionOptions,
): Promise<RequestDeviceAssertionResult> {
  const storeDir = DeviceStore.resolveDir(options.productId, options.storeDir);
  const connected = await connectControlClient({
    storeDir,
    productId: options.productId,
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
  });
  if (!connected.ok) return { ok: false, code: 'unavailable', reason: connected.reason };

  try {
    const result = await connected.client.request<AssertionIssueResult>('assertion.issue', {
      audience: options.audience,
    });
    if (result === null || typeof result !== 'object' || typeof result.expiresAt !== 'string') {
      return { ok: false, code: 'bad_response', reason: 'daemon returned a malformed assertion.issue result' };
    }
    // Parsed, not trusted: the caller is about to present this to a cloud, so
    // a shape that could not possibly verify is caught here rather than there.
    const assertion = parseDeviceAssertionEnvelope(result.assertion);
    return { ok: true, assertion, expiresAt: result.expiresAt };
  } catch (err) {
    if (err instanceof ControlError) return { ok: false, code: err.code, reason: err.message };
    return { ok: false, code: 'bad_response', reason: errorMessage(err) };
  } finally {
    // One connection per call. Holding it open would keep a handle on a
    // privileged local socket for a credential that expires in two minutes.
    connected.client.close();
  }
}
