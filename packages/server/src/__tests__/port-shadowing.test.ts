import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { startServer, stopServer } from './test-support';

/**
 * Guards the fixture invariant that a test server binds the exact address its
 * own URLs dial. A hostname-less `serve({ port: 0 })` binds the IPv6 wildcard
 * `::`, which coexists with a foreign process already holding the more
 * specific `127.0.0.1:<port>` — so on a busy machine the drawn ephemeral port
 * is answered by that stranger, and every fixture URL (all `127.0.0.1`) talks
 * to it instead of to byok. That surfaced as an intermittent
 * `pairing failed: 401 Unauthorized` from `pairFakeDaemon`. Binding what we
 * dial turns the collision into a loud `EADDRINUSE` at startup.
 */
describe('test-server fixture binding (bind and dial must agree on address family)', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of cleanup.splice(0)) await stop();
  });

  it('binds 127.0.0.1 — the exact address every fixture URL dials', async () => {
    const byok = createByokServer({ productId: 'acme' });
    const started = await startServer(byok);
    cleanup.push(() => stopServer(started.server));

    const addr = started.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(started.baseUrl).toBe(`http://${addr.address}:${addr.port}`);
  });
});
