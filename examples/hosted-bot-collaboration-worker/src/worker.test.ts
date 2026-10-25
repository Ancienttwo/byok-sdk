/**
 * The H Host as a Worker on local workerd (#794 D3, Worker row). One substrate and one device process for the file; each test
 * has its own scope (SDK tenant) and Agent, and starts its own Worker instance, so a test that kills an instance leaves no
 * state but Postgres behind.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskId } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { openSubstrate, RUN, startDevice, startWorker, until, type DeviceProcess, type Substrate, type WorkerInstance } from './worker.test-support';

const OWNER = { id: 'owner', kind: 'human' } as const;

describe.skipIf(!RUN)('H Host on local workerd (#794 D3)', () => {
  let substrate: Substrate;
  let worker: WorkerInstance | undefined;
  let device: DeviceProcess | undefined;
  /** The scope that pairs the device: its tenant owns the enrollment. */
  let home: string;

  beforeAll(async () => {
    substrate = await openSubstrate();
    home = `worker-tenant-${randomUUID()}`;
    await substrate.provision(home, OWNER, { models: { default: template('pending', 'main') }, readOnlyToolsets: [] });
    worker = await startWorker(substrate);
    const { code } = await worker.admin<{ code: string }>('/host/pairing-code', { scope: home });
    device = await startDevice(worker.base, code);
  });
  afterAll(async () => {
    await device?.stop();
    await worker?.kill();
    await substrate?.dispose();
  });

  /** A Main Bot on the device with its own Agent, bound to H, and the owner's session token. */
  async function bot(agentId = `agent-${randomUUID()}`) {
    const execution = template(device!.deviceId, agentId);
    const token = await substrate.provision(home, OWNER, { models: { default: execution }, readOnlyToolsets: [] });
    await substrate.store.seed(home, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.team.bots.main!.execution = execution;
    });
    await substrate.store.bindDevice(home, device!.deviceId);
    return { token, agentId };
  }
  const intent = async (turnId: string) => (await substrate.pool.query<{ tries: number; submission: string; conclusion: string | null }>(
    `SELECT tries, submission, conclusion FROM "${substrate.hSchema}".intent WHERE scope = $1 AND key = $2`, [storedKey(home), storedKey(turnId)])).rows[0];
  const commands = async () => (await substrate.pool.query<{ key: string }>(
    `SELECT key FROM "${substrate.hSchema}".command WHERE scope = $1 ORDER BY key`, [storedKey(home)])).rows.map(row => JSON.parse(row.key) as string);
  /** The envelope types of the SDK mailbox rows that name `task`. One offer is one row, however many submits resolved. */
  const mailbox = async (task: string) => (await substrate.pool.query<{ type: string }>(
    `SELECT body::jsonb->>'type' AS type FROM "${substrate.sdkSchema}".outbox WHERE tenant_id = $1 AND position($2 in body) > 0 ORDER BY seq`,
    [home, task])).rows.map(row => row.type);

  it('runs one owner Turn: the entry commits, a pass offers it, the device runs it, a pass applies the terminal once', async () => {
    const { token } = await bot();
    const response = await worker!.input(token, 'main', `k-${randomUUID()}`, 'Hello from the Worker');
    expect(response.status).toBe(200);
    const { turnId } = await response.json() as { turnId: string };
    const task = taskId(turnId, 0);
    await until(async () => (await worker!.passes(), (await intent(turnId))?.submission === 'delivered' || undefined));
    await device!.waitForStart(task);
    await device!.finish(task, {});
    await until(async () => (await worker!.passes(), (await substrate.store.read(home)).turns[turnId]?.status === 'succeeded' || undefined));
    expect(await intent(turnId)).toMatchObject({ tries: 1, submission: 'delivered', conclusion: 'succeeded' });
    expect(await commands()).toContain(task);
    expect(await mailbox(task)).toEqual(['task.offer_for_agent_with_egress_fresh']);
  });

  it('rejects a request with no valid owner session, and writes nothing', async () => {
    await bot();
    const before = await substrate.store.dump(home);
    expect((await worker!.input('not-a-session', 'main', 'k', 'Hello')).status).toBe(401);
    expect(await substrate.store.dump(home)).toBe(before);
  });

  it('runs the scheduled handler on the cron route', async () => {
    await worker!.cron();
    await worker!.waitForOutput('[h-worker] scheduled pass');
  });
});
