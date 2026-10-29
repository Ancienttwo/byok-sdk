/**
 * Two independent device processes against one Worker H Host (#794 D3, cross-process row). Each process has its own pairing
 * (enrollment), SDK store dir, workspace and Agent home, and a synthetic runtime. The machine identities are synthetic, so
 * this is two devices on one computer, not two computers. The runtime is the K8 stub: this records protocol evidence only,
 * with no model call.
 *
 * Bot A (the Main Bot) runs on device 1 and delegates to Bot B on device 2. B's reply, an Agent message that H's consumer
 * accepts, answers the delegation, and A's report Turn runs on device 1.
 */
import { randomUUID } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash, taskId, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { openSubstrate, RUN, startDevice, startWorker, until, type DeviceProcess, type Substrate, type WorkerInstance } from './worker.test-support';

const OWNER = { id: 'owner', kind: 'human' } as const;

/** A Bot template with the K8 reply contract (K8 team.test-support.ts): each Turn's reply is a required Agent message. */
function replying(deviceId: string, agentId: string): ExecutionTemplate {
  const base = template(deviceId, agentId);
  return { ...base, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'h-worker' }, payload: { ...base.payload,
    messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65_536 } } };
}

describe.skipIf(!RUN)('two device processes against one Worker H Host (#794 D3)', () => {
  let substrate: Substrate;
  let worker: WorkerInstance | undefined;
  const devices: DeviceProcess[] = [];
  const scope = `worker-team-${randomUUID()}`;
  let token: string;

  beforeAll(async () => {
    substrate = await openSubstrate();
    await substrate.provision(scope, OWNER, { models: { default: template('pending', 'main') }, readOnlyToolsets: [] });
    worker = await startWorker(substrate);
    for (let i = 0; i < 2; i++) {
      const { code } = await worker.admin<{ code: string }>('/host/pairing-code', { scope });
      devices.push(await startDevice(worker.base, code));
    }
    const [one, two] = devices as [DeviceProcess, DeviceProcess];
    const a = replying(one.deviceId, 'agent-a'), b = replying(two.deviceId, 'agent-b');
    token = await substrate.provision(scope, OWNER, { models: { local: a, remote: b }, readOnlyToolsets: [] });
    await substrate.store.seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.team.bots.main = { ...state.team.bots.main!, model: 'local', execution: a };
      state.team.bots.b = { ...state.team.bots.main, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, model: 'remote', execution: b };
    });
    for (const device of devices) await substrate.store.bindDevice(scope, device.deviceId);
  });
  afterAll(async () => {
    for (const device of devices) await device.stop();
    await worker?.kill();
    await substrate?.dispose();
  });

  const pass = () => worker!.passes();
  const state = () => substrate.store.read(scope);
  const attempt = async (task: string) => (await substrate.pool.query<{ device_id: string; status: string }>(
    `SELECT device_id, status FROM "${substrate.sdkSchema}".task WHERE tenant_id = $1 AND task_id = $2`, [scope, task])).rows[0];
  const commands = async () => (await substrate.pool.query<{ key: string }>(
    `SELECT key FROM "${substrate.hSchema}".command WHERE scope = $1 ORDER BY key`, [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);

  it('routes A -> B -> A across the two processes: each Turn runs on its Bot\'s device, and each result commits once', async () => {
    const [one, two] = devices as [DeviceProcess, DeviceProcess];
    expect(one.pid).not.toBe(two.pid);
    expect(one.deviceId).not.toBe(two.deviceId);

    const response = await worker!.input(token, 'main', `k-${randomUUID()}`, 'Ask B to check the totals');
    expect(response.status).toBe(200);
    const { turnId: root } = await response.json() as { turnId: string };
    const rootTask = taskId(root, 0);
    await one.waitForStart(rootTask);
    await one.finish(rootTask, { delegate: [{ to: 'b', request: 'Check the totals' }] });

    const delegationId = hash([rootTask, 'delegate', 0]), request = taskId(delegationId, 0);
    await until(async () => (await pass(), two.started.some(entry => entry.taskId === request) || undefined));
    expect((await state()).delegations[delegationId]).toMatchObject({ toDeviceId: two.deviceId, toAgentRef: { agentId: 'agent-b' } });
    expect(await attempt(request)).toMatchObject({ device_id: two.deviceId });
    await two.finish(request, {});

    const report = hash(['bot_reply', delegationId]), reportTask = taskId(report, 0);
    await until(async () => (await pass(), (await state()).delegations[delegationId]?.verdict === 'answered' || undefined));
    expect((await state()).delegations[delegationId]).toMatchObject({ verdict: 'answered', reply: request, replyTurnId: report });
    await until(async () => (await pass(), one.started.some(entry => entry.taskId === reportTask) || undefined));
    await one.finish(reportTask, {});
    await until(async () => (await pass(), (await state()).turns[report]?.status === 'succeeded' || undefined));

    // Each Turn ran on its own Bot's device process, once.
    expect(one.started.map(entry => entry.taskId)).toEqual([rootTask, reportTask]);
    expect(two.started.map(entry => entry.taskId)).toEqual([request]);
    expect(await attempt(reportTask)).toMatchObject({ device_id: one.deviceId });
    // One command record for each terminal outcome, and one for each Turn's reply message (`taskId:messageId`).
    const recorded = await commands();
    for (const task of [rootTask, request, reportTask]) {
      expect(recorded.filter(id => id === task), task).toHaveLength(1);
      expect(recorded.filter(id => id.startsWith(`${task}:`)), `${task} reply`).toHaveLength(1);
    }
    // Each device has its own Agent home: B's Agent never had a home on device 1, nor A's on device 2.
    const agents = async (device: DeviceProcess) => readdir(path.join(device.root, 'homes', 'agents')).catch(() => [] as string[]);
    expect(await agents(one)).toContain('agent-a');
    expect(await agents(two)).toContain('agent-b');
    expect(await agents(one)).not.toContain('agent-b');
    expect(await agents(two)).not.toContain('agent-a');
    await expect(access(path.join(two.root, 'sdk'))).resolves.toBeUndefined();
  });

  it('an instance destroyed after the consumer committed a reply: the device sends it again, and the decision stays', async () => {
    const [one] = devices as [DeviceProcess, DeviceProcess];
    worker = await restart({ fault: 'hang-after-consume' });
    const response = await worker.input(token, 'main', `k-${randomUUID()}`, 'Answer directly');
    const { turnId } = await response.json() as { turnId: string };
    const task = taskId(turnId, 0);
    await until(async () => (await pass(), one.started.some(entry => entry.taskId === task) || undefined));
    // Without a wait for this finish: the device's reply request is the one that hangs.
    const finished = one.finish(task, {});
    await worker.waitForOutput(`[h-fault] hang-after-consume ${task}`);
    await worker.kill();
    const committed = (await commands()).filter(id => id.startsWith(`${task}:`));
    expect(committed).toHaveLength(1);
    worker = await restart();
    await finished;
    await until(async () => (await pass(), (await state()).turns[turnId]?.status === 'succeeded' || undefined));
    expect((await commands()).filter(id => id.startsWith(`${task}:`))).toEqual(committed);
    expect((await commands()).filter(id => id === task)).toHaveLength(1);
  });

  async function restart(options: Parameters<typeof startWorker>[1] = {}) {
    const port = Number(new URL(worker!.base).port);
    await worker!.kill();
    return startWorker(substrate, { ...options, port });
  }
});
