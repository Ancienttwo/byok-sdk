import { Hono } from 'hono';
import { PairingCodeInvalidError, type PairingManager } from './pairing';

interface PairRequestBody {
  pairingCode?: unknown;
  deviceName?: unknown;
}

/**
 * The HTTP half of the pinned wire contract: `POST /byok/pair`. WS upgrade
 * handling lives in `ws-server.ts` (raw Node `http.Server` upgrade, not
 * routable through Hono's fetch handler).
 */
export function buildHonoApp(deps: { pairing: PairingManager }): Hono {
  const app = new Hono();

  app.post('/byok/pair', async (c) => {
    let body: PairRequestBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const { pairingCode, deviceName } = body;
    if (typeof pairingCode !== 'string' || typeof deviceName !== 'string') {
      return c.json({ error: 'pairingCode and deviceName are required strings' }, 400);
    }

    try {
      const { deviceId, deviceToken } = deps.pairing.redeemPairingCode(pairingCode, deviceName);
      return c.json({ deviceId, deviceToken }, 200);
    } catch (err) {
      if (err instanceof PairingCodeInvalidError) {
        return c.json({ error: err.message }, 401);
      }
      throw err;
    }
  });

  return app;
}
