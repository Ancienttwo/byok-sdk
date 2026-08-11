import { afterEach, describe, expect, it } from 'vitest';
import { resolvePiBin } from '../adapters/pi/resolve-bin';

describe('resolvePiBin', () => {
  const ORIGINAL = process.env.BYOK_PI_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_PI_BIN;
    else process.env.BYOK_PI_BIN = ORIGINAL;
  });

  it('resolves the user-installed pi runtime from PATH', () => {
    expect(resolvePiBin()).toEqual({ command: 'pi', source: 'path' });
  });

  it('BYOK_PI_BIN overrides PATH lookup', () => {
    process.env.BYOK_PI_BIN = '/tmp/some-fake-pi.mjs';
    expect(resolvePiBin()).toEqual({ command: '/tmp/some-fake-pi.mjs', source: 'env' });
  });
});
