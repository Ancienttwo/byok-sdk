/**
 * Auth v2 (docs/protocol.md §6): pair, challenge, token.
 *
 * Byte-for-byte the same request/response DTOs the daemon already speaks,
 * because they come from `@byok-sdk/protocol` rather than from a hosted copy of
 * them. The behavior differences a hosted surface DOES make are two, both
 * narrowing:
 *
 * - a pairing code that is unknown, expired, or already used gets one 401 with
 *   one message (the reference server names the reason);
 * - an unknown device and a revoked device were already indistinguishable on
 *   the reference server, and stay so here.
 */
import type { Context } from 'hono';
import {
  ChallengeRequestSchema,
  PairRequestSchema,
  TokenRequestSchema,
  type ChallengeResponse,
  type PairResponse,
  type TokenResponse,
} from '@byok-sdk/protocol';
import type { AuthPlane } from '../auth/plane';
import { readJsonBody } from './shared';

export interface AuthRouteDeps {
  readonly auth: AuthPlane;
}

export function pairHandler(deps: AuthRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const parsed = PairRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'pairingCode, deviceName, and devicePublicKey are required strings' }, 400);
    }

    const device = await deps.auth.redeemAndRegister(parsed.data);
    if (device === undefined) return c.json({ error: 'invalid pairing code' }, 401);

    const { accessToken, expiresAt } = await deps.auth.mintAccessToken(device);
    const response: PairResponse = { deviceId: device.deviceId, accessToken, refreshHint: expiresAt };
    return c.json(response, 200);
  };
}

export function challengeHandler(deps: AuthRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const parsed = ChallengeRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'deviceId is required' }, 400);

    // Pre-tenant by construction: `ChallengeRequest` is the pinned wire
    // contract and carries only a deviceId, so the ROW is what tells this
    // deployment which tenant the device belongs to.
    const device = await deps.auth.resolveDevice(parsed.data.deviceId);
    if (device === undefined) return c.json({ error: 'unknown or revoked device' }, 401);

    const response: ChallengeResponse = { nonce: await deps.auth.issueNonce(device) };
    return c.json(response, 200);
  };
}

export function tokenHandler(deps: AuthRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const parsed = TokenRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'deviceId, nonce, and signature are required' }, 400);
    const { deviceId, nonce, signature } = parsed.data;

    const device = await deps.auth.resolveDevice(deviceId);
    if (device === undefined) return c.json({ error: 'unknown or revoked device' }, 401);

    if (!(await deps.auth.validateNonce(device, nonce))) {
      return c.json({ error: 'invalid, expired, or already-used nonce' }, 401);
    }
    // Domain-separated (`byok-nonce-v1\n`, `auth/verify.ts`): a raw signature
    // over the bare nonce is invalid here, with no second accepted form.
    if (!(await deps.auth.verifySignature(device, nonce, signature))) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    // Burn the nonce only on a fully verified success (§6.2) — an invalid
    // signature attempt does not consume the legitimate device's nonce.
    await deps.auth.consumeNonce(device, nonce);

    const { accessToken, expiresAt } = await deps.auth.mintAccessToken(device);
    const response: TokenResponse = { accessToken, expiresAt };
    return c.json(response, 200);
  };
}
