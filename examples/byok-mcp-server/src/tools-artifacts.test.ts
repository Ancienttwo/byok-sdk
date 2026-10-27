import { createEnvelope } from '@byok-sdk/protocol';
import { afterEach, expect, it } from 'vitest';
import { AGENT, call, cleanup, connect, openSimulatorHost } from './tools.test-support';

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// The real daemon reports files as live `task.artifact` events and sets no
// `artifactRefs` on `task.complete`, so a device terminal with refs comes from the simulator.
it('lists artifacts of a finished task and returns a working download URL only to the owning key', async () => {
  const host = await openSimulatorHost();
  const key = host.ledger.issueKey({ label: 'Bot A', scopes: ['tasks.dispatch', 'tasks.read', 'artifacts.read'], deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const other = host.ledger.issueKey({ label: 'Bot B', scopes: ['tasks.read', 'artifacts.read'], deviceIds: [host.deviceId], runtimes: ['pi'] });
  const client = await connect(host, key.token);
  const { taskId } = (await call(client, 'byok_task_submit', { runtime: 'pi', instruction: 'Produce a report file.' })).value;
  const content = Buffer.from('# B3 report\n');
  const ref = await host.uploadBlob(content, 'text/markdown');
  await host.send(createEnvelope('task.claim', { deviceId: host.deviceId, agentRef: AGENT, runtime: 'pi' }, { taskId }));
  await host.send(createEnvelope('task.started', {}, { taskId }));
  await host.send(createEnvelope('task.complete', { agentRef: AGENT, summary: 'done', finalMessage: 'Report attached.', sessionRef: 'b3-sim', artifactRefs: [ref] }, { taskId }));

  expect((await call(client, 'byok_task_status', { taskId })).value).toEqual({ taskId, state: 'Complete', finalMessage: 'Report attached.',
    artifacts: [{ index: 0, contentType: 'text/markdown', size: content.length }] });
  const artifact = await call(client, 'byok_artifact_url', { taskId, index: 0 });
  expect(artifact.value).toEqual({ taskId, index: 0, url: expect.stringMatching(new RegExp(`^${host.origin}/byok/blobs/`)), contentType: 'text/markdown', size: content.length });
  const download = await fetch(artifact.value.url);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer()).equals(content)).toBe(true);

  const missing = await call(client, 'byok_artifact_url', { taskId, index: 1 });
  const foreign = await call(await connect(host, other.token), 'byok_artifact_url', { taskId, index: 0 });
  expect(missing).toEqual({ isError: true, value: { code: 'not_found', message: 'Resource not found' } });
  expect(foreign).toEqual(missing);
});

it('pages this key\'s tasks newest first and filters by state', async () => {
  // Each ledger read of the clock is one millisecond later, so submit order is creation order.
  let clock = Date.now();
  const host = await openSimulatorHost({ now: () => ++clock });
  const key = host.ledger.issueKey({ label: 'Bot A', scopes: ['tasks.dispatch', 'tasks.read'], deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT,
    quota: { runningTasks: 3 } });
  const client = await connect(host, key.token);
  const ids: string[] = [];
  for (const name of ['first', 'second', 'third']) {
    ids.push((await call(client, 'byok_task_submit', { runtime: 'pi', instruction: `Task ${name}.`, clientRequestId: name })).value.taskId);
  }
  await host.send(createEnvelope('task.claim', { deviceId: host.deviceId, agentRef: AGENT, runtime: 'pi' }, { taskId: ids[0]! }));
  await host.send(createEnvelope('task.complete', { agentRef: AGENT, summary: 'done', sessionRef: 'b3-sim' }, { taskId: ids[0]! }));

  const first = (await call(client, 'byok_task_list', { limit: 2 })).value;
  expect(first.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([ids[2], ids[1]]);
  expect(first.tasks.map((task: { state: string }) => task.state)).toEqual(['Offered', 'Offered']);
  const second = (await call(client, 'byok_task_list', { limit: 2, cursor: first.nextCursor })).value;
  expect(second).toEqual({ tasks: [{ taskId: ids[0], runtime: 'pi', createdAt: expect.any(String), state: 'Complete' }] });
  expect((await call(client, 'byok_task_list', { state: 'Complete' })).value.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([ids[0]]);
  // Listing a terminal task also reconciles its slot from the device terminal.
  expect(host.ledger.quota(host.ledger.authenticate(`Bearer ${key.token}`)).runningTasks).toBe(2);
  const bad = await call(client, 'byok_task_list', { cursor: 'not-a-cursor' });
  expect(bad).toMatchObject({ isError: true, value: { code: 'invalid_input' } });
});

it('dispatches toolsets on the Agent execution offer and accepts a retry only through exact readback', async () => {
  const host = await openSimulatorHost({ capabilities: ['toolset-selection'] });
  const key = host.ledger.issueKey({ label: 'Bot A', scopes: ['tasks.dispatch', 'tasks.read'], deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const client = await connect(host, key.token);
  const args = { runtime: 'pi', instruction: 'Use the docs toolset.', toolsets: ['docs', 'search.web'], clientRequestId: 'toolsets-1' };
  const submitted = (await call(client, 'byok_task_submit', args)).value;
  expect(await host.server.tasks.offer(submitted.taskId)).toMatchObject({ type: 'task.offer', deviceId: host.deviceId,
    payload: { instruction: 'Use the docs toolset.', runtime: 'pi', agentRef: AGENT, terminalProjection: { mode: 'none' },
      requiredToolsets: ['docs', 'search.web'] } });
  expect((await call(client, 'byok_task_submit', args)).value).toEqual({ ...submitted, deduplicated: true });
});

it('keeps the slot of a dispatch that the SDK refuses before the task exists', async () => {
  const host = await openSimulatorHost();
  const key = host.ledger.issueKey({ label: 'Bot A', scopes: ['tasks.dispatch', 'tasks.read'], deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: AGENT });
  const client = await connect(host, key.token);
  const refused = await call(client, 'byok_task_submit', { runtime: 'pi', instruction: 'Needs local tools.', toolsets: ['docs'], clientRequestId: 'no-cap' });
  expect(refused).toEqual({ isError: true, value: { code: 'unavailable', message: 'The task was admitted but not dispatched. Retry the same call.', retryAfterSeconds: 1 } });
  const caller = host.ledger.authenticate(`Bearer ${key.token}`);
  const [taskId] = host.ledger.openTasks(caller);
  expect(await host.server.tasks.get(taskId!)).toBeUndefined();
  expect((await call(client, 'byok_task_status', { taskId })).value).toEqual({ taskId, state: 'Reserved', artifacts: [] });
  expect(host.ledger.quota(caller)).toMatchObject({ runningTasks: 1, remainingSubmits: 59 });
});
