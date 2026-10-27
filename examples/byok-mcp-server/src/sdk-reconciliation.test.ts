import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import { createDeviceSimulator } from '@byok-sdk/testkit';
import { createEnvelope, PROTOCOL_VERSION, type Envelope } from '@byok-sdk/protocol';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { BetaLedger, type TaskArguments } from './index';
import { AGENT, AGENT_EXECUTION_CAPABILITIES } from './tools.test-support';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function host() {
  const root = mkdtempSync(join(tmpdir(), 'b2-sdk-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const server = createByokServer({ productId: 'beta-b2-test' }); cleanup.push(() => server.close());
  const device = await createDeviceSimulator({ baseUrl: 'http://127.0.0.1',
    fetch: async (input, init) => server.hono.fetch(new Request(input, init)) });
  const code = await server.pairing.createPairingCode({ productId: 'beta-b2-test' });
  const session = await device.pair(code.code);
  const send = async (envelope: Envelope) => {
    const response = await device.request({ method: 'POST', path: '/byok/messages', body: { messages: [envelope] } });
    expect(response).toMatchObject({ status: 200, body: { accepted: 1 } });
  };
  await send(createEnvelope('conn.hello', { protocolVersions: [PROTOCOL_VERSION], capabilities: AGENT_EXECUTION_CAPABILITIES,
    productId: 'beta-b2-test', deviceId: session.deviceId, runtimes: [{ id: 'pi', capabilities: { steer: false, resume: false, approvalInteractive: false } }] }));
  const ledger = new BetaLedger(join(root, 'beta.sqlite'), 'tenant-a', { tasks: server.tasks }); cleanup.push(() => ledger.close());
  const issued = ledger.issueKey({ label: 'SDK integration', scopes: ['tasks.dispatch', 'tasks.read'], deviceIds: [session.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const caller = ledger.authenticate(`Bearer ${issued.token}`);
  const input: TaskArguments = { runtime: 'pi', instruction: 'local signed device fixture', clientRequestId: 'sdk-1' };
  const reservation = ledger.reserveTask(caller, input, session.deviceId);
  const dispatch = async () => {
    await server.executions.submit({ taskId: reservation.taskId, deviceId: reservation.binding.deviceId, payload: {
      runtime: reservation.binding.arguments.runtime, instruction: reservation.binding.arguments.instruction,
      agentRef: reservation.binding.agentRef!, egressPolicy: policy, terminalProjection: { mode: 'none' } } });
    const handle = { taskId: reservation.taskId };
    await send(createEnvelope('task.claim', { deviceId: session.deviceId, agentRef: AGENT, runtime: 'pi' }, { taskId: handle.taskId }));
    await send(createEnvelope('task.started', {}, { taskId: handle.taskId }));
    expect((await server.tasks.get(handle.taskId))?.state).toBe('Running');
    return handle;
  };
  return { ledger, server, caller, issued, reservation, input, dispatch, send };
}

it('keeps a pre-dispatch reservation occupied across missing SDK state and Host-only cancellation', async () => {
  const f = await host();
  expect(await f.ledger.reconcileTask(f.reservation.taskId)).toBe(false);
  expect(f.ledger.lookupTask(f.caller, f.input)?.taskId).toBe(f.reservation.taskId);
  expect(f.ledger.quota(f.caller).runningTasks).toBe(1);
  const handle = await f.dispatch();
  await f.server.tasks.cancel(handle.taskId, 'Host cancellation');
  expect((await f.server.tasks.get(handle.taskId))?.state).toBe('Cancelled');
  expect(await f.ledger.reconcileTask(handle.taskId)).toBe(false);
  expect(f.ledger.quota(f.caller).runningTasks).toBe(1);
  await f.send(createEnvelope('task.cancelled', { agentRef: AGENT, reason: 'Device acknowledged cancellation' }, { taskId: handle.taskId }));
  expect(await f.ledger.reconcileTask(handle.taskId)).toBe(true);
  expect(await f.ledger.reconcileTask(handle.taskId)).toBe(true);
  expect(f.ledger.quota(f.caller)).toMatchObject({ runningTasks: 0, remainingSubmits: 59 });
});

it('revokes authorization without killing the SDK task or releasing its slot', async () => {
  const f = await host(); const handle = await f.dispatch();
  f.ledger.revokeKey(f.issued.key.keyId);
  expect((await f.server.tasks.get(handle.taskId))?.state).toBe('Running');
  expect(await f.ledger.reconcileTask(handle.taskId)).toBe(false);
  await f.send(createEnvelope('task.complete', { agentRef: AGENT, summary: 'Device fixture completed', sessionRef: 'b2-fixture-session' }, { taskId: handle.taskId }));
  expect((await f.server.tasks.get(handle.taskId))?.state).toBe('Complete');
  expect(await f.ledger.reconcileTask(handle.taskId)).toBe(true);
});
