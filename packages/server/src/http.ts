import { Hono, type Context } from 'hono';
import {
  ChallengeRequestSchema,
  CreateBlobRequestSchema,
  MessagesSendRequestSchema,
  PairRequestSchema,
  TokenRequestSchema,
  type BlobDownloadUrlResponse,
  type ChallengeResponse,
  type CreateBlobResponse,
  type EventsPollResponse,
  type MessagesSendResponse,
  type PairResponse,
  type TokenResponse,
} from '@byok/protocol';
import { authenticateBearer, mintAccessToken, verifyEd25519Signature, type AuthDeps, type NonceStore } from './auth';
import type { BlobStore } from './blob-store';
import type { ConnectionHub } from './hub';
import { generateDeviceId } from './ids';
import { PairingCodeInvalidError, type PairingManager } from './pairing';

export interface HttpDeps extends AuthDeps {
  pairing: PairingManager;
  nonces: NonceStore;
  blobStore: BlobStore;
  hub: ConnectionHub;
  /** Per-product blob size ceiling in bytes (§7). */
  maxBlobSizeBytes: number;
  /** How long `GET /byok/events` holds an empty poll open before returning, ms (§8). */
  longPollHoldMs: number;
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * The HTTP half of the pinned wire contract: pairing, token renewal, blob
 * flows, and the long-poll events fallback (docs/protocol.md §6-§8). WS
 * upgrade handling lives in `ws-server.ts` (raw Node `http.Server` upgrade,
 * not routable through Hono's fetch handler).
 */
export function buildHonoApp(deps: HttpDeps): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------
  // Auth v2 (§6)
  // -------------------------------------------------------------------

  app.post('/byok/pair', async (c) => {
    const parsed = PairRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'pairingCode, deviceName, and devicePublicKey are required strings' }, 400);
    }
    const { pairingCode, deviceName, devicePublicKey } = parsed.data;

    try {
      deps.pairing.redeemPairingCode(pairingCode);
    } catch (err) {
      if (err instanceof PairingCodeInvalidError) {
        return c.json({ error: err.message }, 401);
      }
      throw err;
    }

    const deviceId = generateDeviceId();
    deps.devices.register(deviceId, deviceName, devicePublicKey);
    const { accessToken, expiresAt } = await mintAccessToken(deps.tokenSigner, deviceId);

    const response: PairResponse = { deviceId, accessToken, refreshHint: expiresAt };
    return c.json(response, 200);
  });

  app.post('/byok/challenge', async (c) => {
    const parsed = ChallengeRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'deviceId is required' }, 400);
    const { deviceId } = parsed.data;

    if (deps.devices.isRevokedOrUnknown(deviceId)) {
      return c.json({ error: 'unknown or revoked device' }, 401);
    }

    const nonce = deps.nonces.issue(deviceId);
    const response: ChallengeResponse = { nonce };
    return c.json(response, 200);
  });

  app.post('/byok/token', async (c) => {
    const parsed = TokenRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'deviceId, nonce, and signature are required' }, 400);
    const { deviceId, nonce, signature } = parsed.data;

    const device = deps.devices.get(deviceId);
    if (!device || device.revoked) {
      return c.json({ error: 'unknown or revoked device' }, 401);
    }
    if (!deps.nonces.validate(deviceId, nonce)) {
      return c.json({ error: 'invalid, expired, or already-used nonce' }, 401);
    }
    if (!verifyEd25519Signature(device.devicePublicKey, nonce, signature)) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    // Only burn the nonce on a fully-verified success (§6.2) — an invalid
    // signature attempt doesn't consume the legitimate device's nonce.
    deps.nonces.markUsed(nonce);

    const { accessToken, expiresAt } = await mintAccessToken(deps.tokenSigner, deviceId);
    const response: TokenResponse = { accessToken, expiresAt };
    return c.json(response, 200);
  });

  // -------------------------------------------------------------------
  // Blob flows (§7) — POST/GET are bearer-authed; the two `/content`
  // routes are pre-signed (HMAC `sig`+`exp`), not bearer-authed, since
  // they're meant to be hit directly (e.g. from a browser) without a JWT.
  // -------------------------------------------------------------------

  app.post('/byok/blobs', async (c) => {
    const deviceId = await authenticateBearer(c.req.header('authorization'), deps);
    if (!deviceId) return c.json({ error: 'unauthorized' }, 401);

    const parsed = CreateBlobRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'size, contentType, and contentHash are required' }, 400);
    if (parsed.data.size > deps.maxBlobSizeBytes) {
      return c.json({ error: `blob exceeds max size of ${deps.maxBlobSizeBytes} bytes` }, 413);
    }

    const { blobId, uploadUrl } = await deps.blobStore.createUpload(parsed.data);
    const response: CreateBlobResponse = { blobId, uploadUrl };
    return c.json(response, 200);
  });

  app.get('/byok/blobs/:id/url', async (c) => {
    const deviceId = await authenticateBearer(c.req.header('authorization'), deps);
    if (!deviceId) return c.json({ error: 'unauthorized' }, 401);

    const downloadUrl = await deps.blobStore.getDownloadUrl(c.req.param('id'));
    if (!downloadUrl) return c.json({ error: 'blob not found' }, 404);

    const response: BlobDownloadUrlResponse = { downloadUrl };
    return c.json(response, 200);
  });

  app.put('/byok/blobs/:id/content', async (c) => {
    const blobId = c.req.param('id');
    const { sig, exp } = signedUrlParams(c.req.query('sig'), c.req.query('exp'));
    if (!sig || exp === undefined || !deps.blobStore.verifySignedUrl(blobId, 'put', sig, exp)) {
      return c.json({ error: 'invalid or expired signature' }, 401);
    }

    const data = Buffer.from(await c.req.arrayBuffer());
    const result = await deps.blobStore.writeContent(blobId, data);
    if (!result.ok) return c.json({ error: result.reason }, 422);
    return c.body(null, 204);
  });

  app.get('/byok/blobs/:id/content', async (c) => {
    const blobId = c.req.param('id');
    const { sig, exp } = signedUrlParams(c.req.query('sig'), c.req.query('exp'));
    if (!sig || exp === undefined || !deps.blobStore.verifySignedUrl(blobId, 'get', sig, exp)) {
      return c.json({ error: 'invalid or expired signature' }, 401);
    }

    const content = await deps.blobStore.readContent(blobId);
    if (!content) return c.json({ error: 'blob not found' }, 404);
    return c.body(new Uint8Array(content.data), 200, { 'content-type': content.contentType });
  });

  // -------------------------------------------------------------------
  // Long-poll fallback (§8)
  // -------------------------------------------------------------------

  app.get('/byok/events', async (c) => {
    const deviceId = await authenticateBearer(c.req.header('authorization'), deps);
    if (!deviceId) return c.json({ error: 'unauthorized' }, 401);

    const cursorRaw = c.req.query('cursor');
    let cursor = 0;
    if (cursorRaw !== undefined) {
      const parsedCursor = Number(cursorRaw);
      if (!Number.isInteger(parsedCursor)) return c.json({ error: 'invalid cursor' }, 400);
      cursor = parsedCursor;
    }

    const result = await deps.hub.pollEvents(deviceId, cursor, deps.longPollHoldMs);
    const response: EventsPollResponse = result;
    return c.json(response, 200);
  });

  // -------------------------------------------------------------------
  // Finding F6: daemon->server send while long-polling (§8). A device
  // long-polling for S->D traffic has no live WS to carry its own outbound
  // envelopes — this batches them over authed HTTP instead. Each envelope is
  // routed through the exact same inbound path a WS connection's messages
  // get (`hub.handleEnvelope`), so claim/progress/complete/etc. behave
  // identically regardless of which transport carried them.
  // -------------------------------------------------------------------

  app.post('/byok/messages', async (c) => {
    const deviceId = await authenticateBearer(c.req.header('authorization'), deps);
    if (!deviceId) return c.json({ error: 'unauthorized' }, 401);

    const parsed = MessagesSendRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'messages must be an array of envelopes' }, 400);

    for (const envelope of parsed.data.messages) {
      deps.hub.handleEnvelope(deviceId, envelope);
    }

    const response: MessagesSendResponse = { accepted: parsed.data.messages.length };
    return c.json(response, 200);
  });

  return app;
}

function signedUrlParams(sig: string | undefined, expRaw: string | undefined): { sig?: string; exp?: number } {
  if (!sig || expRaw === undefined) return {};
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return {};
  return { sig, exp };
}
