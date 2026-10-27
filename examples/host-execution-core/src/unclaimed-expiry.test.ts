// Contract probe: cancel first, then read attempt to distinguish the two states.
// The owner accepts interruption of an execution that wins a racing claim.
// The fake runtime holds an execution open. SQLite, HTTP, claim and cancel are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer } from '@byok-sdk/server';
import { createDaemonWithAdapters, type AgentEgressPolicy } from '@byok-sdk/client';
import { expect, it, vi } from 'vitest';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';

it('distinguishes pre-claim cancellation from claimed cancellation through attempt readback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'k4-'));
  const productId = 'k4-expiry-probe';
  const policy: AgentEgressPolicy = {
    policyRevision: 'probe-v1',
    activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
    reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
    transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
  };
  const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') } });
  const http = serve({ fetch: server.hono.fetch, port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  const adapter = new BotStubAdapter();
  const deviceCredentials = new InMemoryDeviceCredentialStore();
  const config = {
    productId, productName: 'K4 probe', localAgentRelease: { version: '0.0.0-probe' },
    serverUrl: `http://127.0.0.1:${address.port}`,
    storeDir: path.join(root, 'sdk'), agentHome: { hostStorageRoot: path.join(root, 'homes') },
    agentEgress: { policy },
  };
  let daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials });
  let releaseInterrupt: (() => void) | undefined;
  try {
    const pairing = await server.pairing.createPairingCode({ productId });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await waitForReady(daemon);
    await daemon.stop(); // Registered and advertised, but no process can claim.

    const input = (taskId: string) => ({ taskId, deviceId, payload: {
      instruction: 'Hold this execution until cancelled.', runtime: 'pi' as const,
      agentRef: { agentId: 'probe-agent', profileRevision: '1' }, egressPolicy: policy,
      terminalProjection: { mode: 'none' as const },
    } });
    await server.executions.submit(input('cancel-before-claim'));
    expect((await server.tasks.offer('cancel-before-claim'))?.delivered).toBe(true);
    expect(await server.tasks.deviceTerminal('cancel-before-claim')).toBeUndefined();
    expect(await server.tasks.cancel('cancel-before-claim', 'waiting limit')).toBeUndefined();
    expect(await server.tasks.attempt('cancel-before-claim')).toMatchObject({ status: 'cancelled' });
    expect((await server.tasks.attempt('cancel-before-claim'))?.claimedRuntime).toBeUndefined();
    // Successful pre-claim cancellation has no device terminal to settle from.
    expect(await server.tasks.deviceTerminal('cancel-before-claim')).toBeUndefined();

    const submitted = await server.executions.submit(input('claim-before-cancel'));
    expect(submitted.attempt.ownerDeviceId).toBeUndefined();
    const beforeClaim = await server.tasks.offer('claim-before-cancel');
    expect(beforeClaim?.delivered).toBe(true);
    expect(await server.tasks.deviceTerminal('claim-before-cancel')).toBeUndefined();

    daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials });
    await daemon.start();
    await waitForReady(daemon);
    await vi.waitFor(() => expect(adapter.sessions.has('claim-before-cancel')).toBe(true), { timeout: 5000 });
    // Runtime creation does not wait for the SDK's durable claim receipt.
    await vi.waitFor(async () => expect(await server.tasks.attempt('claim-before-cancel')).toMatchObject({
      ownerDeviceId: deviceId, claimedRuntime: 'pi',
    }), { timeout: 5000 });
    const session = adapter.sessions.get('claim-before-cancel')!;
    expect(adapter.sessions.has('cancel-before-claim')).toBe(false);
    // Same task and identical allowed observations, although a runtime now runs.
    expect(await server.tasks.offer('claim-before-cancel')).toEqual(beforeClaim);
    expect(await server.tasks.deviceTerminal('claim-before-cancel')).toBeUndefined();
    expect(submitted.attempt.ownerDeviceId).toBeUndefined(); // The submit snapshot stays stale.
    expect(session.interrupted).toBe(false);

    // Hold device completion so the intermediate cancel_requested state is observable.
    const interruptGate = new Promise<void>(resolve => { releaseInterrupt = resolve; });
    vi.spyOn(session, 'interrupt').mockImplementation(async () => { session.interrupted = true; await interruptGate; });
    expect(await server.tasks.cancel('claim-before-cancel', 'waiting limit')).toBeUndefined();
    expect(await server.tasks.attempt('claim-before-cancel')).toMatchObject({ status: 'cancel_requested', claimedRuntime: 'pi' });
    await vi.waitFor(() => expect(session.interrupted).toBe(true), { timeout: 5000 });
    releaseInterrupt!();
    await vi.waitFor(async () => expect(await server.tasks.deviceTerminal('claim-before-cancel')).toMatchObject({
      envelope: { type: 'task.cancelled' },
    }), { timeout: 5000 });
    expect(await server.tasks.deviceTerminal('cancel-before-claim')).toBeUndefined();
    expect(await server.tasks.attempt('cancel-before-claim')).toMatchObject({ status: 'cancelled' });
    expect((await server.tasks.attempt('cancel-before-claim'))?.claimedRuntime).toBeUndefined();
  } finally {
    releaseInterrupt?.();
    await daemon.stop();
    await server.close();
    await new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve());
      if ('closeAllConnections' in http) http.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
});
