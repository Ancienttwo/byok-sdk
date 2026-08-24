import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import {
  connectFakeDaemon,
  nextEnvelope,
  startServer,
  stopServer,
  testPairingClaims,
} from './test-support';

const PRODUCT_ID = 'strict-agent-only-test';

describe('strict-agent-only producer scheduling defence', () => {
  let server: HttpServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.terminate());
    if (server) await stopServer(server);
    server = undefined;
  });

  it('rejects an explicit legacy dispatch before TaskStore/outbox mutation', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const strict = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['strict-agent-only', 'agent-home-contract'],
    });
    sockets.push(strict.ws);

    await expect(byok.dispatch({ deviceId: strict.deviceId, instruction: 'legacy' })).rejects.toThrow(/strict-agent-only/i);
    expect(byok.tasks.list()).toEqual([]);
  });

  it('skips strict devices in implicit legacy selection but admits Agent offers to them', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const strictCode = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const regularCode = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const strict = await connectFakeDaemon(started.baseUrl, started.port, strictCode.code, {
      productId: PRODUCT_ID,
      capabilities: ['strict-agent-only', 'agent-home-contract'],
    });
    const regular = await connectFakeDaemon(started.baseUrl, started.port, regularCode.code, { productId: PRODUCT_ID, capabilities: [] });
    sockets.push(strict.ws, regular.ws);

    const legacy = await byok.dispatch({ instruction: 'implicit legacy' });
    expect(byok.tasks.get(legacy.taskId)?.deviceId).toBe(regular.deviceId);
    await expect(nextEnvelope(regular.ws)).resolves.toMatchObject({ type: 'task.offer' });

    const agent = await byok.dispatch({
      deviceId: strict.deviceId,
      instruction: 'Agent work',
      agentRef: { agentId: 'agent-1', profileRevision: 'r1' },
    });
    expect(byok.tasks.get(agent.taskId)?.deviceId).toBe(strict.deviceId);
    await expect(nextEnvelope(strict.ws)).resolves.toMatchObject({ type: 'task.offer_for_agent' });
  });
});
