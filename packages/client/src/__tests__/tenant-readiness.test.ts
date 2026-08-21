import { describe, expect, it } from 'vitest';
import type { AuthManager } from '../daemon/auth-manager';
import { PresencePublisher } from '../daemon/presence-publisher';

function auth(): AuthManager {
  return {
    getValidAccessToken: async () => 'token',
    handleUnauthorized: async () => 'token',
  } as unknown as AuthManager;
}

describe('U3 first-hop presence identity', () => {
  it('carries the same frozen release/runtime facts as conn.hello', async () => {
    const bodies: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    const publisher = new PresencePublisher({
      serverUrl: 'https://example.test',
      auth: auth(),
      intervalMs: 30_000,
      clientVersion: '0.4.2',
      runtimes: [
        {
          id: 'pi',
          version: '1.0.0',
          authPresent: true,
          capabilities: { steer: true, permissionModes: ['acceptEdits'] },
        },
      ],
    });
    publisher.start();
    await Promise.resolve();

    expect(bodies).toEqual([
      {
        level: 'online',
        clientVersion: '0.4.2',
        runtimes: [{ id: 'pi', version: '1.0.0', authPresent: true }],
      },
    ]);
    publisher.stop();
    globalThis.fetch = originalFetch;
  });
});
