import { afterEach, describe, expect, it } from 'vitest';
import { resolveClaudeBin } from '../adapters/claude/resolve-bin';

describe('resolveClaudeBin', () => {
  const ORIGINAL = process.env.BYOK_CLAUDE_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_CLAUDE_BIN;
    else process.env.BYOK_CLAUDE_BIN = ORIGINAL;
  });

  it('falls back to the literal `claude` PATH command when no override is set', () => {
    delete process.env.BYOK_CLAUDE_BIN;
    expect(resolveClaudeBin()).toEqual({ command: 'claude', source: 'path' });
  });

  it('BYOK_CLAUDE_BIN overrides the PATH lookup', () => {
    process.env.BYOK_CLAUDE_BIN = '/tmp/some-fake-claude.mjs';
    expect(resolveClaudeBin()).toEqual({ command: '/tmp/some-fake-claude.mjs', source: 'env' });
  });
});
