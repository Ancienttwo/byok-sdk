import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const release = vi.hoisted(() => ({
  verify: vi.fn((helperBin: string, _assetRoot?: string) => helperBin),
  actualVerify: undefined as ((helperBin: string, assetRoot?: string) => string) | undefined,
}));
// Model a verified SDK release helper. These tests pin the platform gate and
// the backend proofs; the PE digest has its own test with the real exe.
vi.mock('../util/agent-memory-helper-release', async importOriginal => {
  const actual = await importOriginal<typeof import('../util/agent-memory-helper-release')>();
  release.actualVerify = actual.verifyAgentMemoryFilesystemHelper;
  return { ...actual, verifyAgentMemoryFilesystemHelper: release.verify };
});
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import * as actualRelease from '../util/agent-memory-helper-release';
import { isAgentMemoryFilesystemHelperSupported, openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { helperAgentMemoryIntentBackend } from '../daemon/agent-memory-intent';

afterEach(() => { release.verify.mockClear(); });

async function withProcess(platform: NodeJS.Platform, arch: NodeJS.Architecture, run: () => Promise<void> | void): Promise<void> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  if (platformDescriptor === undefined || archDescriptor === undefined) throw new Error('process descriptors missing');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  Object.defineProperty(process, 'arch', { ...archDescriptor, value: arch });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.defineProperty(process, 'arch', archDescriptor);
  }
}

describe('Windows Agent memory admission', () => {
  it('admits the SDK helper on Windows x64 for recall and save, without B', async () => {
    await withProcess('win32', 'x64', () => {
      expect(isAgentMemoryFilesystemHelperSupported()).toBe(true);
      expect(isAgentMemorySecureFilesystemAvailable(false)).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(true)).toBe(true);
      const helperBin = path.resolve('agent-memory-fs', 'win32-x64.exe');
      const backend = helperAgentMemoryIntentBackend(helperBin);
      expect(release.verify).toHaveBeenCalledWith(helperBin, undefined);
      // No OS-crash or power-loss proof, so no strict barrier and no intents.
      expect(backend.strictLedgerBarrier).toBe(false);
      expect(backend.conflictProvesNoRename).toBe(true);
    });
  });

  it('keeps both proofs for the macOS helper', async () => {
    await withProcess('darwin', 'arm64', () => {
      const backend = helperAgentMemoryIntentBackend(path.resolve('agent-memory-fs', 'darwin-arm64'));
      expect(backend.strictLedgerBarrier).toBe(true);
      expect(backend.conflictProvesNoRename).toBe(true);
    });
  });

  it('keeps Windows arm64 closed even with an explicit helper', async () => {
    await withProcess('win32', 'arm64', async () => {
      expect(isAgentMemoryFilesystemHelperSupported()).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(false)).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(true)).toBe(false);
      // The release pin has no win32-arm64 target, so no backend can grant B.
      expect(() => actualRelease.resolveAgentMemoryFilesystemHelper()).toThrow('SDK Agent memory helper is not admitted on this platform');
      const helperBin = path.resolve('unproved-agent-memory-fs.exe');
      release.verify.mockImplementationOnce(release.actualVerify!);
      expect(() => helperAgentMemoryIntentBackend(helperBin)).toThrow('SDK Agent memory helper is not admitted on this platform');
      release.verify.mockClear();
      await expect(openAgentMemoryFilesystemHelper({
        helperBin, canonicalHome: path.resolve('unproved-home'), homeIdentity: { dev: 1n, ino: 2n },
      })).rejects.toThrow('not admitted on this platform');
      expect(release.verify).not.toHaveBeenCalled();
    });
  });
});
