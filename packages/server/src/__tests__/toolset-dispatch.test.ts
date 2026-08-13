import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { connectFakeDaemon, nextEnvelope, startServer, stopServer, testPairingClaims } from './test-support';

const PRODUCT_ID = 'acme';

describe('logical MCP toolset dispatch', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('sends the distinct fail-closed offer type and persists only logical ids', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['toolset-selection'],
      configuredToolsets: ['crm.readonly', 'salesko'],
      runtimes: [
        {
          id: 'claude',
          capabilities: { mcpToolsets: true, permissionModes: ['auto'] },
        },
      ],
    });
    ws = daemon.ws;

    const handle = await byok.dispatch({
      instruction: 'find qualified leads',
      runtime: 'claude',
      policy: { mode: 'auto' },
      requiredToolsets: ['salesko'],
    });
    const offer = await nextEnvelope(ws);

    expect(offer.type).toBe('task.offer_with_toolsets');
    if (offer.type !== 'task.offer_with_toolsets') throw new Error('unreachable');
    expect(offer.payload.requiredToolsets).toEqual(['salesko']);
    expect(JSON.stringify(offer)).not.toMatch(/command|args|secret/i);
    expect(byok.tasks.get(handle.taskId)?.requiredToolsets).toEqual(['salesko']);
  });

  it('rejects before task creation when the device did not advertise toolset-selection', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: [],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'must use Salesko',
        requiredToolsets: ['salesko'],
      }),
    ).rejects.toThrow(/did not advertise toolset-selection/);
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('rejects before task creation when the device inventory is unknown', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['toolset-selection'],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'must use Salesko',
        requiredToolsets: ['salesko'],
      }),
    ).rejects.toThrow(/did not advertise its configured toolset inventory/);
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('rejects before task creation when the device is missing a required id', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['toolset-selection'],
      configuredToolsets: ['crm.readonly'],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'must use Salesko',
        requiredToolsets: ['salesko'],
      }),
    ).rejects.toThrow(/missing required MCP toolset/);
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('runtime-validates malformed and duplicate ids before task creation', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['toolset-selection'],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({ instruction: 'x', requiredToolsets: ['Salesko'] as never }),
    ).rejects.toThrow();
    await expect(
      byok.dispatch({ instruction: 'x', requiredToolsets: ['salesko', 'salesko'] }),
    ).rejects.toThrow();
    expect(byok.tasks.list()).toHaveLength(0);
  });
});
