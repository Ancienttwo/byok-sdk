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

const PRODUCT_ID = 'acme';

describe('dispatchSelection authority', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('derives the requested runtime and carries the exact BYOK selection in task.offer', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['dispatch-selection'],
    });
    ws = daemon.ws;

    const dispatchSelection = {
      lane: 'byok' as const,
      runtimeId: 'pi' as const,
      providerId: 'openai',
      modelId: 'gpt-5.2',
    };
    const handle = await byok.dispatch({ instruction: 'use exact target', dispatchSelection });
    const offer = await nextEnvelope(ws);

    expect(byok.tasks.get(handle.taskId)?.runtime).toBe('pi');
    expect(offer.type).toBe('task.offer');
    if (offer.type !== 'task.offer') throw new Error('unreachable');
    expect(offer.payload.runtime).toBe('pi');
    expect(offer.payload.dispatchSelection).toEqual(dispatchSelection);
  });

  it('rejects a contradictory legacy runtime before creating or offering a task', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['dispatch-selection'],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({
        instruction: 'contradictory target',
        runtime: 'claude',
        dispatchSelection: {
          lane: 'byok',
          runtimeId: 'pi',
          providerId: 'openai',
          modelId: 'gpt-5.2',
        },
      }),
    ).rejects.toThrow(/does not match dispatchSelection\.runtimeId pi/);
  });

  it('runtime-validates a JavaScript caller selection before any task is created', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['dispatch-selection'],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({
        instruction: 'malformed target',
        dispatchSelection: {
          lane: 'subscription',
          runtimeId: 'pi',
          providerId: null,
          modelId: 'gpt-5.2',
        } as never,
      }),
    ).rejects.toThrow();
  });

  it('refuses to send a selection to an older v1 daemon that would strip the additive field', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: [],
    });
    ws = daemon.ws;

    await expect(byok.dispatch({
      instruction: 'must not degrade to runtime-only dispatch',
      dispatchSelection: {
        lane: 'subscription',
        runtimeId: 'codex',
        providerId: null,
        modelId: 'gpt-5.6-sol',
      },
    })).rejects.toThrow(/did not advertise dispatch-selection capability/);
    expect(byok.tasks.list()).toHaveLength(0);
  });
});
