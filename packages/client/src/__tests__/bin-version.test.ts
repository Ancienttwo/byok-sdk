import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../bin/official-release';
import { runVersionCommand } from '../bin/version';

describe('byok-agent --version', () => {
  it('prints only the manifest-derived Local Agent version without consulting config or state', () => {
    const log = vi.fn();
    runVersionCommand(log);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(OFFICIAL_LOCAL_AGENT_RELEASE.version);
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(OFFICIAL_LOCAL_AGENT_RELEASE.version).toBe(manifest.version);
  });
});
