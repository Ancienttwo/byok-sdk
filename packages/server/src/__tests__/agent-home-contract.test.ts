import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { SqliteTaskStore } from '../sqlite-task-store';
import {
  connectFakeDaemon,
  nextEnvelope,
  pairFakeDaemon,
  send,
  startServer,
  stopServer,
  testPairingClaims,
  waitForTaskEvent,
} from './test-support';

const PRODUCT_ID = 'acme';
const agentRef = { agentId: 'agent-1', profileRevision: 'profile-r7' } as const;

describe('agent-home-contract reference server', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('rejects before task creation when an old daemon omits the capability', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID, capabilities: [] });
    ws = daemon.ws;

    await expect(
      byok.dispatch({ deviceId: daemon.deviceId, instruction: 'agent work', agentRef }),
    ).rejects.toThrow(/agent-home-contract/);
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('sends task.offer_for_agent and persists the exact AgentRef', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    ws = daemon.ws;

    const handle = await byok.dispatch({ deviceId: daemon.deviceId, instruction: 'agent work', agentRef });
    const envelope = await nextEnvelope(ws);
    expect(envelope.type).toBe('task.offer_for_agent');
    if (envelope.type !== 'task.offer_for_agent') throw new Error('unreachable');
    expect(envelope.payload.agentRef).toEqual(agentRef);
    expect(byok.tasks.get(handle.taskId)?.agentRef).toEqual(agentRef);
  });

  it('admits Agent dispatch after an authenticated long-poll conn.hello snapshot', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await pairFakeDaemon(started.baseUrl, code);
    const hello = createEnvelope('conn.hello', {
      protocolVersions: [1],
      capabilities: ['agent-home-contract'],
      deviceId: daemon.deviceId,
      productId: PRODUCT_ID,
    });

    const response = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages: [hello] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    await expect(
      byok.dispatch({ deviceId: daemon.deviceId, instruction: 'agent over long-poll', agentRef }),
    ).resolves.toMatchObject({ taskId: expect.any(String) });
  });

  it('fails closed on claim and terminal AgentRef mismatches', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    ws = daemon.ws;

    const claimMismatch = await byok.dispatch({ deviceId: daemon.deviceId, instruction: 'claim mismatch', agentRef });
    await nextEnvelope(ws);
    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: { ...agentRef, profileRevision: 'wrong' } }, { taskId: claimMismatch.taskId }));
    await waitForTaskEvent(claimMismatch, (event) => event.kind === 'state' && event.state === 'Failed');
    expect(byok.tasks.get(claimMismatch.taskId)?.result).toMatchObject({ state: 'Failed', retryable: false });

    const terminalMismatch = await byok.dispatch({ deviceId: daemon.deviceId, instruction: 'terminal mismatch', agentRef });
    await nextEnvelope(ws);
    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef }, { taskId: terminalMismatch.taskId }));
    send(ws, createEnvelope('task.started', {}, { taskId: terminalMismatch.taskId }));
    await waitForTaskEvent(terminalMismatch, (event) => event.kind === 'state' && event.state === 'Running');
    send(
      ws,
      createEnvelope(
        'task.complete',
        { summary: 'done', sessionRef: 'sess-1', agentRef: { ...agentRef, profileRevision: 'wrong' } },
        { taskId: terminalMismatch.taskId },
      ),
    );
    await waitForTaskEvent(terminalMismatch, (event) => event.kind === 'state' && event.state === 'Failed');
    expect(byok.tasks.get(terminalMismatch.taskId)?.result).toMatchObject({ state: 'Failed', retryable: false });
  });

  it('reads an AgentRef back after SQLite restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byok-agent-home-'));
    const path = join(dir, 'tasks.sqlite');
    try {
      const first = new SqliteTaskStore({ path });
      first.create({ taskId: 'task-restart', instruction: 'persist', policy: { mode: 'auto' }, deviceId: 'dev-1', agentRef });
      first.close();
      const second = new SqliteTaskStore({ path });
      expect(second.get('task-restart')?.agentRef).toEqual(agentRef);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
