import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import {
  resolveLocalAgentReleaseIdentity,
  type LocalAgentReleaseIdentity,
} from '../release-identity';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

describe('LocalAgentReleaseIdentity', () => {
  it.each([
    '0.0.0',
    '1.2.3',
    '1.2.3-rc.1',
    '1.2.3+sha.abcdef',
    '1.2.3-rc.1+sha.abcdef',
  ])('accepts strict SemVer %s', (version) => {
    expect(resolveLocalAgentReleaseIdentity({ version })).toEqual({ version });
  });

  it.each([
    '',
    'latest',
    '^1.2.3',
    'v1.2.3',
    ' 1.2.3',
    '1.2.3 ',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2',
    '1.2.3-01',
  ])('rejects non-canonical version %j', (version) => {
    expect(() => resolveLocalAgentReleaseIdentity({ version })).toThrow(/version.*SemVer/i);
  });

  it('accepts a bounded opaque build id and rejects unsafe or oversized ids', () => {
    expect(resolveLocalAgentReleaseIdentity({ version: '1.2.3', buildId: 'sha256:abc.def-123' })).toEqual({
      version: '1.2.3',
      buildId: 'sha256:abc.def-123',
    });
    expect(() => resolveLocalAgentReleaseIdentity({ version: '1.2.3', buildId: '' })).toThrow(/buildId/);
    expect(() => resolveLocalAgentReleaseIdentity({ version: '1.2.3', buildId: 'contains space' })).toThrow(/buildId/);
    expect(() => resolveLocalAgentReleaseIdentity({ version: '1.2.3', buildId: 'a'.repeat(129) })).toThrow(/buildId/);
  });

  it('copies and freezes the identity once at daemon construction', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-release-workspace-'));
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-release-store-'));
    const input: LocalAgentReleaseIdentity = { version: '1.2.3', buildId: 'build-a' };
    const daemon = createDaemonWithAdapters(
      {
        productName: 'Release Test',
        productId: 'release-test',
        serverUrl: 'ws://127.0.0.1:1',
        workspaceRoot,
        storeDir,
        localAgentRelease: input,
      },
      [new StubRuntimeAdapter()],
    );

    input.version = '9.9.9';
    expect(daemon.status().localAgentRelease).toEqual({ version: '1.2.3', buildId: 'build-a' });
    expect(Object.isFrozen(daemon.status().localAgentRelease)).toBe(true);
    expect(daemon.status().localAgentRelease).toBe(daemon.status().localAgentRelease);
  });

  it('rejects a missing identity at the runtime boundary for untyped JavaScript callers', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-release-missing-workspace-'));
    expect(() => createDaemonWithAdapters({
      productName: 'Release Test',
      productId: 'release-test-missing',
      serverUrl: 'ws://127.0.0.1:1',
      workspaceRoot,
      localAgentRelease: undefined,
    } as never, [new StubRuntimeAdapter()])).toThrow(/localAgentRelease/);
  });
});
