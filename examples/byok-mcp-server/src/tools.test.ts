import { afterEach, expect, it, vi } from 'vitest';
import { createTaskTools, type KeySpec } from './index';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { AGENT, call, cleanup, connect, openDaemonHost } from './tools.test-support';

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scopes: KeySpec['scopes'] = ['tasks.dispatch', 'tasks.read', 'tasks.cancel', 'artifacts.read'];
const TOOLS = ['byok_artifact_url', 'byok_runtimes', 'byok_task_cancel', 'byok_task_list', 'byok_task_status', 'byok_task_submit', 'byok_whoami'];
type Client = Awaited<ReturnType<typeof connect>>;

/** Reads the state now, then long-polls for changes, as an MCP client loop does. */
async function until(client: Client, taskId: string, done: (state: string) => boolean) {
  let status = await call(client, 'byok_task_status', { taskId });
  for (let attempt = 0; attempt < 20 && !done(status.value.state); attempt += 1) {
    status = await call(client, 'byok_task_status', { taskId, waitSeconds: 2 });
  }
  if (!done(status.value.state)) throw new Error(`task ${taskId} did not reach the expected state`);
  return status.value;
}

it('runs submit, status and list against the real daemon, and frees the slot at the device terminal', async () => {
  const host = await openDaemonHost();
  const key = host.ledger.issueKey({ label: 'Bot A', scopes, deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const client = await connect(host, key.token);
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(TOOLS);
  expect((await call(client, 'byok_whoami', {})).value).toEqual({ keyId: key.key.keyId, label: 'Bot A', scopes, runtimes: ['pi'],
    devices: [{ deviceId: host.deviceId, name: expect.any(String), registered: true, connected: true }],
    quota: { limits: key.key.quota, now: { runningTasks: 0, routines: 0, remainingSubmits: 60, remainingStatusReads: 120 } } });
  expect((await call(client, 'byok_runtimes')).value).toEqual({ devices: [{ deviceId: host.deviceId, registered: true, connected: true,
    runtimes: [{ id: 'pi', installed: true, version: '0.0.0-fake' }] }] });

  const args = { runtime: 'pi', instruction: 'Write the B3 answer.' };
  const submitted = await call(client, 'byok_task_submit', args);
  expect(submitted).toEqual({ isError: false, value: { taskId: expect.stringMatching(/^[a-f0-9]{64}$/), state: 'Offered', deduplicated: false } });
  const { taskId } = submitted.value;
  const retry = await call(client, 'byok_task_submit', args);
  expect(retry.value).toEqual({ taskId, state: expect.any(String), deduplicated: true });

  const session = await host.runtime.session(taskId);
  expect(host.runtime.offers).toEqual([expect.objectContaining({ instruction: 'Write the B3 answer.', runtime: 'pi' })]);
  expect((await call(client, 'byok_whoami')).value.quota.now).toMatchObject({ runningTasks: 1, remainingSubmits: 59 });
  session.emit({ type: 'progress', text: 'B3 answer' }); session.emit({ type: 'turn_end' });
  const outcome = await until(client, taskId, state => state === 'Complete');
  expect(outcome).toEqual({ taskId, state: 'Complete', finalMessage: 'B3 answer', artifacts: [] });
  // The status read that saw the device terminal released the slot itself.
  expect(host.ledger.quota(host.ledger.authenticate(`Bearer ${key.token}`)).runningTasks).toBe(0);
  expect((await call(client, 'byok_whoami')).value.quota.now).toMatchObject({ runningTasks: 0, remainingSubmits: 59 });
  expect((await call(client, 'byok_task_list')).value).toEqual({ tasks: [{ taskId, runtime: 'pi', createdAt: expect.any(String), state: 'Complete' }] });

  // A retry after the terminal reads the task back; it never dispatches it again.
  expect((await call(client, 'byok_task_submit', args)).value).toEqual({ taskId, state: 'Complete', deduplicated: true });
  expect(host.runtime.offers).toHaveLength(1);
});

it('cancels a running task on the real daemon, and a repeated cancel keeps the final state', async () => {
  const host = await openDaemonHost();
  const key = host.ledger.issueKey({ label: 'Bot A', scopes, deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const client = await connect(host, key.token);
  const { taskId } = (await call(client, 'byok_task_submit', { runtime: 'pi', instruction: 'Run until cancelled.', clientRequestId: 'cancel-1' })).value;
  const session = await host.runtime.session(taskId);
  await until(client, taskId, state => state === 'Running');

  // A wait with no state change ends at its deadline and reports the unchanged state.
  const started = Date.now();
  expect((await call(client, 'byok_task_status', { taskId, waitSeconds: 1 })).value.state).toBe('Running');
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);

  expect((await call(client, 'byok_task_cancel', { taskId, reason: 'User stopped it' })).value).toEqual({ taskId, state: 'Cancelled' });
  await vi.waitFor(() => expect(session.closed).toBe(true), { timeout: 3000, interval: 20 });
  await vi.waitFor(async () => expect((await call(client, 'byok_whoami')).value.quota.now.runningTasks).toBe(0), { timeout: 3000, interval: 50 });
  expect((await call(client, 'byok_task_cancel', { taskId })).value).toEqual({ taskId, state: 'Cancelled' });
  expect((await call(client, 'byok_task_status', { taskId })).value).toEqual({ taskId, state: 'Cancelled', artifacts: [], reason: 'User stopped it' });
});

it('refuses bad or ungranted submits before admission, and hides foreign tasks', async () => {
  const host = await openDaemonHost();
  const key = host.ledger.issueKey({ label: 'Bot A', scopes, deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const reader = host.ledger.issueKey({ label: 'Bot B', scopes: ['tasks.read'], deviceIds: [host.deviceId], runtimes: ['pi'] });
  const offline = host.ledger.issueKey({ label: 'Bot C', scopes, deviceIds: ['dev-not-paired'], runtimes: ['pi'], agentRef: AGENT });
  const client = await connect(host, key.token);
  const refused = async (target: Client, name: string, args: Record<string, unknown>) => {
    const result = await call(target, name, args); expect(result.isError).toBe(true); return result.value.code as string;
  };
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', resultSchema: { type: 'object' } })).toBe('invalid_input');
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', workspace: 'repo-a' })).toBe('invalid_input');
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', toolsets: ['Not A Toolset'] })).toBe('invalid_input');
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', toolsets: [] })).toBe('invalid_input');
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', toolsets: Array.from({ length: 17 }, (_, n) => `t${n}`) })).toBe('invalid_input');
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', toolsets: ['docs', 'docs'] })).toBe('invalid_input');
  expect(await refused(client, 'byok_task_submit', { runtime: 'codex', instruction: 'x' })).toBe('forbidden');
  expect(await refused(client, 'byok_task_submit', { runtime: 'pi', instruction: 'x', extra: true })).toBe('invalid_input');
  expect(await refused(await connect(host, offline.token), 'byok_task_submit', { runtime: 'pi', instruction: 'x' })).toBe('unavailable');
  expect((await call(client, 'byok_whoami')).value.quota.now).toMatchObject({ runningTasks: 0, remainingSubmits: 60 });
  expect(host.runtime.offers).toHaveLength(0);
  for (const blobBaseUrl of ['http://bot.example', 'https://bot.example/sdk', 'not a url']) {
    expect(() => createTaskTools({ sdk: host.server, ledger: host.ledger, egressPolicy: policy, blobBaseUrl })).toThrow(TypeError);
  }

  const { taskId } = (await call(client, 'byok_task_submit', { runtime: 'pi', instruction: 'Owned by Bot A.' })).value;
  const other = await connect(host, reader.token);
  expect((await other.listTools()).tools.map(tool => tool.name).sort()).toEqual(['byok_runtimes', 'byok_task_list', 'byok_task_status', 'byok_whoami']);
  const foreign = await call(other, 'byok_task_status', { taskId });
  const unknown = await call(other, 'byok_task_status', { taskId: 'f'.repeat(64) });
  expect(foreign).toEqual({ isError: true, value: { code: 'not_found', message: 'Resource not found' } });
  expect(unknown).toEqual(foreign);
  expect(await refused(other, 'byok_task_cancel', { taskId })).toBe('forbidden');
  const canceller = await connect(host, host.ledger.issueKey({ label: 'Bot D', scopes: ['tasks.cancel'], deviceIds: [host.deviceId], runtimes: ['pi'] }).token);
  expect(await call(canceller, 'byok_task_cancel', { taskId })).toEqual(foreign);
  expect((await host.server.tasks.get(taskId))?.state).not.toBe('Cancelled');
  expect((await call(other, 'byok_task_list')).value).toEqual({ tasks: [] });
  expect(await refused(client, 'byok_artifact_url', { taskId: 'f'.repeat(64), index: 0 })).toBe('not_found');
});
