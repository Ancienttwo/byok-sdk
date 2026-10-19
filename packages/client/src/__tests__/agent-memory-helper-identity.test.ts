import { describe, expect, it } from 'vitest';

import { agentMemoryHelperIdentity, agentMemoryHelperIdentityMatches } from '../daemon/agent-memory-fs-helper';

describe('private helper tagged identity', () => {
  it('keeps unsigned 64-bit Unix device and inode values exact', () => {
    expect(agentMemoryHelperIdentity({ dev: (1n << 64n) - 1n, ino: 9007199254740993n }, 'darwin')).toEqual({
      kind: 'unix', dev: '18446744073709551615', ino: '9007199254740993',
    });
  });

  it('uses Windows volume serial and file index tags without number coercion', () => {
    expect(agentMemoryHelperIdentity({ dev: (1n << 32n) - 1n, ino: (1n << 64n) - 1n }, 'win32')).toEqual({
      kind: 'windows', volumeSerial: '4294967295', fileIndex: '18446744073709551615',
    });
  });

  it.each([
    ['win32', { dev: 1n << 32n, ino: 1n }],
    ['win32', { dev: 1n, ino: 1n << 64n }],
    ['darwin', { dev: -1n, ino: 1n }],
    ['linux', { dev: 1n, ino: -1n }],
  ] as const)('rejects out-of-range identity on %s', (platform, identity) => {
    expect(() => agentMemoryHelperIdentity(identity, platform)).toThrow('root identity is invalid');
  });

  it('rejects mixed, untagged, changed and number-valued replies', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const expected = agentMemoryHelperIdentity({ dev: 1n, ino: 2n }, platform);
      expect(agentMemoryHelperIdentityMatches({ ...expected }, expected)).toBe(true);
      for (const actual of [
        null, [], { dev: '1', ino: '2' },
        { ...expected, kind: 'other' },
        { ...expected, volumeSerial: '1', fileIndex: '2', dev: '1', ino: '2' },
        { ...expected, kind: 1 },
        platform === 'darwin' ? { ...expected, ino: 2 } : { ...expected, fileIndex: 2 },
        platform === 'darwin' ? { ...expected, ino: '3' } : { ...expected, fileIndex: '3' },
      ]) expect(agentMemoryHelperIdentityMatches(actual, expected)).toBe(false);
    }
  });
});
