import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskId } from '@byok-sdk/server/execution-core';
import { openStore, POSTGRES_URL } from './postgres.test-support';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;

describe.skipIf(POSTGRES_URL === undefined)('H intent table checks on real Postgres (#793 D2b-1)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  async function insert(scope: string, id: string, task: string, inputTask: string, ordinal: number, source = 'user', generation = 0) {
    const { pool, store } = opened!;
    await pool.query(`INSERT INTO "${store.schema}".intent (scope, key, task_id, generation, ordinal, agent, source, input, retry, wait_until, submission)
      VALUES ($1, $2, $3, $7, $4, 'agent', $6, $5::json, '{"maxAttempts":1,"delaysMs":[],"retryFailures":false}', 1, 'reserved')`,
    [JSON.stringify(scope), JSON.stringify(id), task, ordinal, JSON.stringify({ taskId: inputTask }), source, generation]);
  }
  const execution = (scope: string, id: string, generation: number, task: string) => opened!.pool.query(`INSERT INTO "${opened!.store.schema}".intent_execution
    (scope, key, generation, task_id, submission, started, attempt, terminal) VALUES ($1, $2, $3, $4, 'delivered', true, '{}', '{}')`,
  [JSON.stringify(scope), JSON.stringify(id), generation, task]);

  it('accepts the K4 task id of its generation for any Turn id, and refuses any other', async () => {
    const scope = `tenant:${randomUUID()}`;
    await opened!.store.seed(scope, () => {});
    const ids = ['t1', '10', '__proto__', 'constructor', '\ud800', '\udc00', 'a\u0000b', 'é', '😀', '"quoted"\\', 'x'.repeat(2000)];
    for (const [ordinal, id] of ids.entries()) await insert(scope, id, taskId(id, 0), taskId(id, 0), ordinal);
    await expect(insert(scope, 'g1', taskId('g1', 1), taskId('g1', 1), 100)).rejects.toThrow(/intent_stable_task/);
    // An imported intent of a later generation (#975 D1), and the earlier generations' rows, each pinned to its own task id.
    await insert(scope, 'g2', taskId('g2', 2), taskId('g2', 2), 103, 'user', 2);
    await expect(insert(scope, 'g3', taskId('g3', 0), taskId('g3', 0), 104, 'user', 1)).rejects.toThrow(/intent_stable_task/);
    await execution(scope, 'g2', 0, taskId('g2', 0));
    await expect(execution(scope, 'g2', 1, taskId('g2', 0))).rejects.toThrow(/intent_execution_task/);
    await expect(execution(scope, 'none', 0, taskId('none', 0))).rejects.toThrow(/foreign key/);
    // Each writer names the generation: the column has no default.
    await expect(opened!.pool.query(`INSERT INTO "${opened!.store.schema}".intent (scope, key, task_id, ordinal, agent, source, input, retry, wait_until, submission)
      VALUES ($1, '"g4"', $2, 105, 'agent', 'user', $3::json, '{"maxAttempts":1,"delaysMs":[],"retryFailures":false}', 1, 'reserved')`,
    [JSON.stringify(scope), taskId('g4', 0), JSON.stringify({ taskId: taskId('g4', 0) })])).rejects.toThrow(/"generation"/);
    await expect(insert(scope, 'other', taskId('t2', 0), taskId('t2', 0), 101)).rejects.toThrow(/intent_stable_task/);
    await expect(insert(scope, 't3', taskId('t3', 0), 'another', 102)).rejects.toThrow(/intent_input_task/);
    await expect(opened!.pool.query(`UPDATE "${opened!.store.schema}".intent SET task_id = $1 WHERE key = '"t1"'`, [taskId('t2', 0)]))
      .rejects.toThrow(/intent_(stable|input)_task/);
    await expect(opened!.pool.query(`UPDATE "${opened!.store.schema}".intent SET cancel_reason = 'superseded' WHERE key = '"t1"'`))
      .rejects.toThrow(/intent_cancel_reason_check/);
  });

  it('accepts a user, bot or routine source, and refuses any other (#793 D2b-2, D2f)', async () => {
    const scope = `tenant:${randomUUID()}`;
    await opened!.store.seed(scope, () => {});
    await insert(scope, 'u', taskId('u', 0), taskId('u', 0), 0, 'user');
    await insert(scope, 'b', taskId('b', 0), taskId('b', 0), 1, 'bot');
    await insert(scope, 'r', taskId('r', 0), taskId('r', 0), 2, 'routine');
    await expect(insert(scope, 'x', taskId('x', 0), taskId('x', 0), 3, 'room_slot')).rejects.toThrow(/intent_source_check/);
  });
});
