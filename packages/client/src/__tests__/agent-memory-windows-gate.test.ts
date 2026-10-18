import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { isAgentMemoryFilesystemHelperSupported, openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { helperAgentMemoryIntentBackend } from '../daemon/agent-memory-intent';

describe('Windows model S admission', () => {
  it('keeps filesystem authority and B closed even with an explicit helper', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (descriptor === undefined) throw new Error('process.platform descriptor missing');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    try {
      expect(isAgentMemoryFilesystemHelperSupported()).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(false)).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(true)).toBe(false);
      const helperBin = path.resolve('unproved-agent-memory-fs.exe');
      expect(helperAgentMemoryIntentBackend(helperBin).strictLedgerBarrier).toBe(false);
      await expect(openAgentMemoryFilesystemHelper({
        helperBin, canonicalHome: path.resolve('unproved-home'), homeIdentity: { dev: 1n, ino: 2n },
      })).rejects.toThrow('not admitted on this platform');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
});
