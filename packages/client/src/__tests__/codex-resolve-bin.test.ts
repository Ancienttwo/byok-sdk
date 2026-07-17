import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexBin } from '../adapters/codex/resolve-bin';

describe('resolveCodexBin', () => {
  const ORIGINAL = process.env.BYOK_CODEX_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_CODEX_BIN;
    else process.env.BYOK_CODEX_BIN = ORIGINAL;
  });

  it('falls back to a bare "codex" on PATH when no override is set', () => {
    delete process.env.BYOK_CODEX_BIN;
    expect(resolveCodexBin()).toEqual({ command: 'codex', source: 'path' });
  });

  it('BYOK_CODEX_BIN overrides the PATH lookup', () => {
    process.env.BYOK_CODEX_BIN = '/tmp/some-fake-codex.mjs';
    expect(resolveCodexBin()).toEqual({ command: '/tmp/some-fake-codex.mjs', source: 'env' });
  });
});
