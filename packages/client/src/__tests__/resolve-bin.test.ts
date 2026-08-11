import { afterEach, describe, expect, it } from 'vitest';
import { resolvePiBin } from '../adapters/pi/resolve-bin';

describe('resolvePiBin', () => {
  const ORIGINAL = process.env.BYOK_PI_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_PI_BIN;
    else process.env.BYOK_PI_BIN = ORIGINAL;
  });

  it('resolves the bin from the exact required dependency', () => {
    const result = resolvePiBin();
    expect(result.source).toBe('package');
    expect(result.command).toMatch(/pi-coding-agent/);
    expect(result.command.endsWith('cli.js')).toBe(true);
  });

  it('BYOK_PI_BIN explicitly overrides package resolution for tests and packaged sidecars', () => {
    process.env.BYOK_PI_BIN = '/tmp/some-fake-pi.mjs';
    expect(resolvePiBin()).toEqual({ command: '/tmp/some-fake-pi.mjs', source: 'env' });
  });
});
