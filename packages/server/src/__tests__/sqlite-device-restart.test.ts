import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createByokServer, createHmacTokenSigner } from '../index';
import { isSqliteAvailable } from '../sqlite-support';
import { pairFakeDaemon, startServer, stopServer } from './test-support';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;

describeSqlite('SQLite device enrollment across server restart', () => {
  it('renews the original enrollment without re-pairing and preserves revocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byok-device-restart-'));
    const options = {
      productId: 'sqlite-device-restart',
      storage: { kind: 'sqlite' as const, path: join(root, 'server.sqlite') },
      tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
    };
    let instance = createByokServer(options);
    let http = await startServer(instance);
    try {
      const code = await instance.pairing.createPairingCode({ productId: options.productId });
      const enrollment = await pairFakeDaemon(http.baseUrl, code.code);
      await stopServer(http.server);
      await instance.close();
      instance = createByokServer(options);
      http = await startServer(instance);
      expect(await instance.machines.list()).toEqual([
        expect.objectContaining({ deviceId: enrollment.deviceId, connected: false }),
      ]);
      const challenge = await fetch(`${http.baseUrl}/byok/challenge`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: enrollment.deviceId }),
      });
      expect(challenge.status).toBe(200);
      const { nonce } = await challenge.json() as { nonce: string };
      const token = await fetch(`${http.baseUrl}/byok/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: enrollment.deviceId, nonce, signature: enrollment.identity.signNonce(nonce) }),
      });
      expect(token.status).toBe(200);
      await instance.devices.revoke(enrollment.deviceId);
      await stopServer(http.server);
      await instance.close();
      instance = createByokServer(options);
      http = await startServer(instance);
      expect(await instance.machines.list()).toEqual([]);
      const revoked = await fetch(`${http.baseUrl}/byok/challenge`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: enrollment.deviceId }),
      });
      expect(revoked.status).toBe(401);
    } finally {
      await stopServer(http.server);
      await instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
