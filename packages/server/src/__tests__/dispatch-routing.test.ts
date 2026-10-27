import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { TEST_AGENT_DISPATCH } from './test-support';

describe('explicit dispatch routing', () => {
  it('rejects a missing target rather than selecting an ambient device', async () => {
    const byok = createByokServer({ productId: 'acme' });
    try {
      await expect(byok.dispatch({ ...TEST_AGENT_DISPATCH, instruction: 'do the thing' } as never)).rejects.toThrow(/explicit deviceId/);
      expect((await byok.tasks.list()).tasks).toEqual([]);
    } finally { await byok.close(); }
  });
  it('rejects an unknown target before task creation', async () => {
    const byok = createByokServer({ productId: 'acme' });
    try {
      await expect(byok.dispatch({ ...TEST_AGENT_DISPATCH, instruction: 'do the thing', deviceId: 'dev_ghost' })).rejects.toMatchObject({ code: 'agent_capability_missing' });
      expect((await byok.tasks.list()).tasks).toEqual([]);
      expect(await byok.machines.list()).toEqual([]);
    } finally { await byok.close(); }
  });
});
