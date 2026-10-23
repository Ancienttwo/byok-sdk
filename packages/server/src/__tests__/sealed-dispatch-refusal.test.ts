/**
 * #654 E3a: this server has no sealed dispatch. It builds the plaintext offer
 * from named fields, so a `sealing` or `sealed` key that a Host passes through
 * a type cast would be dropped, and the task would run in plaintext. The server
 * refuses the key before any device read or task creation, with the code of
 * the cloud plaintext lanes.
 */
import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';

const SEALING = { scopeId: 'scope-1', epoch: 1, categories: ['task-input', 'task-output'] };
const SEALED = { v: 1, ciphertext: 'AAAA' };
const AGENT_REF = { agentId: 'agent-sealed-refusal', profileRevision: 'profile-r1' };

describe('sealed fields on the server dispatch lanes (#654)', () => {
  it.each([
    ['sealing', { sealing: SEALING }],
    ['sealed', { sealed: SEALED }],
  ])('dispatch refuses %s before the device read', async (_label, extra) => {
    const byok = createByokServer({ productId: 'acme' });
    try {
      await expect(byok.dispatch({ instruction: 'do the thing', deviceId: 'dev_ghost', ...extra } as never))
        .rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect((await byok.tasks.list()).tasks).toEqual([]);
    } finally { await byok.close(); }
  });

  // A spread drops an inherited or a non-enumerable key, so the guard reads the caller's own object.
  const hidden = (field: string, value: unknown, base: object) => [
    [`${field} (inherited)`, Object.assign(Object.create({ [field]: value }) as object, base)],
    [`${field} (non-enumerable)`, Object.defineProperty({ ...base }, field, { value, enumerable: false })],
  ] as const;

  it.each([
    ...hidden('sealing', SEALING, { instruction: 'do the thing', deviceId: 'dev_ghost' }),
    ...hidden('sealed', SEALED, { instruction: 'do the thing', deviceId: 'dev_ghost', taskId: 'sealed-hidden' }),
  ])('dispatch refuses a hidden key: %s', async (_label, input) => {
    const byok = createByokServer({ productId: 'acme' });
    try {
      await expect(byok.dispatch(input as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect((await byok.tasks.list()).tasks).toEqual([]);
    } finally { await byok.close(); }
  });

  it.each(hidden('sealing', SEALING, {
    instruction: 'do the thing', runtime: 'codex', agentRef: AGENT_REF, terminalProjection: { mode: 'none' },
  }))('executions.submit refuses a hidden payload key: %s', async (_label, payload) => {
    const byok = createByokServer({ productId: 'acme' });
    try {
      await expect(byok.executions.submit({ taskId: 'sealed-hidden', deviceId: 'dev_ghost', payload } as never))
        .rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect((await byok.tasks.list()).tasks).toEqual([]);
    } finally { await byok.close(); }
  });

  it.each([
    ['sealing', { sealing: SEALING }],
    ['sealed', { sealed: SEALED }],
  ])('executions.submit refuses %s before the device read', async (_label, extra) => {
    const byok = createByokServer({ productId: 'acme' });
    try {
      await expect(byok.executions.submit({
        taskId: 'sealed-refusal',
        deviceId: 'dev_ghost',
        payload: { instruction: 'do the thing', runtime: 'codex', agentRef: AGENT_REF, terminalProjection: { mode: 'none' }, ...extra },
      } as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect((await byok.tasks.list()).tasks).toEqual([]);
    } finally { await byok.close(); }
  });
});
