import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_RUNTIME_VERSIONS_URL,
  checkSuggestedRuntimeVersion,
  suggestedRuntimeVersions,
  type SuggestedRuntimeVersionsManifest,
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

  it('returns no advice for a missing or unreadable installed version', () => {
    expect(checkSuggestedRuntimeVersion('codex', undefined)).toBeNull();
    expect(checkSuggestedRuntimeVersion('codex', 'version unavailable')).toBeNull();
  });

  it('looks up Antigravity and returns advice under the SDK id agy', () => {
    const antigravity = { version: '1.6.0', reason: 'Model support' };
    const manifest: SuggestedRuntimeVersionsManifest = {
      schemaVersion: 1,
      updatedAt: '2026-11-26',
      runtimes: { antigravity },
    };
    expect(checkSuggestedRuntimeVersion('agy', 'agy 1.5.18', manifest)).toEqual({
      runtime: 'agy',
      installedVersion: '1.5.18',
      suggestedMinVersion: antigravity.version,
      reason: antigravity.reason,
    });
    expect(checkSuggestedRuntimeVersion('antigravity', '1.5.18', manifest)).toBeNull();
  });
});
