import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';

describe('dispatch() routing (no live connection)', () => {
  it('rejects with a clear error when no device is connected — M0 does not queue', async () => {
    const byok = createByokServer({ productId: 'acme' });

    await expect(byok.dispatch({ instruction: 'do the thing' })).rejects.toThrow(
      /no connected device/i,
    );
  });

  it('rejects when a specific deviceId is requested but not connected', async () => {
    const byok = createByokServer({ productId: 'acme' });

    await expect(
      byok.dispatch({ instruction: 'do the thing', deviceId: 'dev_ghost' }),
    ).rejects.toThrow(/not connected/i);
  });

  it('does not create a task record for a rejected dispatch', async () => {
    const byok = createByokServer({ productId: 'acme' });

    await expect(byok.dispatch({ instruction: 'anything' })).rejects.toThrow();
    expect(byok.tasks.list()).toEqual([]);
  });

  it('machines.list() is empty when nothing has ever paired', () => {
    const byok = createByokServer({ productId: 'acme' });
    expect(byok.machines.list()).toEqual([]);
  });
});
