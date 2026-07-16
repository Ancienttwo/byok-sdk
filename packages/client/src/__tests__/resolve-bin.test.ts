import { afterEach, describe, expect, it } from 'vitest';
import { resolvePiBin } from '../adapters/pi/resolve-bin';

describe('resolvePiBin', () => {
  const ORIGINAL = process.env.BYOK_PI_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_PI_BIN;
    else process.env.BYOK_PI_BIN = ORIGINAL;
  });

  it('resolves the bin from the installed optionalDependency, or falls back to PATH', () => {
    // optionalDependencies can legitimately fail to install (platform, registry
    // outage, etc.) without breaking the overall install, so this must not
    // assume either branch — it just asserts each branch's shape is sane.
    const result = resolvePiBin();
    if (result.source === 'package') {
      expect(result.command).toMatch(/pi-coding-agent/);
      expect(result.command.endsWith('cli.js')).toBe(true);
    } else {
      expect(result.command).toBe('pi');
    }
  });

  it('BYOK_PI_BIN overrides both the optionalDependency and PATH lookup', () => {
    process.env.BYOK_PI_BIN = '/tmp/some-fake-pi.mjs';
    expect(resolvePiBin()).toEqual({ command: '/tmp/some-fake-pi.mjs', source: 'path' });
  });
});
