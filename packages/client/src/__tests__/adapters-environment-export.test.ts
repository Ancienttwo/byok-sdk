import { expect, it } from 'vitest';
import * as adapters from '../adapters';

it('offers direct adapter hosts the same environment builder as the daemon', () => {
  const ambient = { PATH: '/bin', CLAUDECODE: '1', BYOK_SECRET: 'secret', NODE_OPTIONS: '--trace-warnings' };
  expect(adapters).toHaveProperty('buildRuntimeEnv');
  expect(adapters.buildRuntimeEnv({ ambient })).toEqual({ PATH: '/bin', NODE_OPTIONS: '--trace-warnings' });
  expect(ambient.BYOK_SECRET).toBe('secret');
});
