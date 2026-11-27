import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_RUNTIME_VERSIONS_URL,
  checkSuggestedRuntimeVersion,
  parseSuggestedRuntimeVersions,
  suggestedRuntimeVersions,
} from '../index.js';

describe('suggested runtime versions', () => {
  it('advises an installed version below the bundled floor', () => {
    const codex = suggestedRuntimeVersions.runtimes.codex!;
    expect(new URL(SUGGESTED_RUNTIME_VERSIONS_URL).protocol).toBe('https:');
    expect(checkSuggestedRuntimeVersion('codex', 'codex-cli 0.165.0')).toEqual({
      runtime: 'codex',
      installedVersion: '0.165.0',
      suggestedMinVersion: codex.version,
      reason: codex.reason,
    });
  });

  it('returns no advice at or above the floor', () => {
    const { version } = suggestedRuntimeVersions.runtimes.codex!;
    expect(checkSuggestedRuntimeVersion('codex', version)).toBeNull();
    expect(checkSuggestedRuntimeVersion('codex', 'codex-cli 1.0.0')).toBeNull();
  });

  it('returns no advice for an unknown runtime', () => {
    expect(checkSuggestedRuntimeVersion('toString', '0.0.1')).toBeNull();
  });

  it('rejects a malformed manifest and drops malformed rows from a valid document', () => {
    const updatedAt = '2026-11-26';
    expect(parseSuggestedRuntimeVersions({ schemaVersion: 1, updatedAt, runtimes: [] })).toBeNull();

    const codex = { version: '1.0.0', reason: 'Model support' };
    const manifest = parseSuggestedRuntimeVersions({
      schemaVersion: 1,
      updatedAt,
      runtimes: { codex, claude: { version: 'latest', reason: 'Model support' } },
    });
    expect(manifest).toEqual({ schemaVersion: 1, updatedAt, runtimes: { codex } });
    expect(checkSuggestedRuntimeVersion('codex', '0.169.0', manifest!)).toMatchObject({
      suggestedMinVersion: codex.version,
      reason: codex.reason,
    });
  });
});
