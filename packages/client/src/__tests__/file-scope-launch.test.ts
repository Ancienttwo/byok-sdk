import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileScopeGuardError, resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity } from '../file-scope-guard';
import { parseSerializedFileScopeGrant, serializeFileScopeGrant, verifySerializedFileScopeGrant } from '../file-scope-launch';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function identityOf(filePath: string): Promise<FileScopeIdentity> {
  const value = await fs.stat(filePath, { bigint: true });
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

async function grantFixture(): Promise<FileScopeGrant> {
  const home = await tmpDir('byok-launch-home-');
  const root = await tmpDir('byok-launch-root-');
  return resolveFileScopeGrant({
    fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: root, access: 'write' }] },
    home: { path: home, identity: await identityOf(home) },
  });
}

function parseOrThrow(value: unknown) {
  return parseSerializedFileScopeGrant(value, (message) => { throw new Error(message); });
}

async function verifyFailure(value: Parameters<typeof verifySerializedFileScopeGrant>[0]): Promise<FileScopeGuardError> {
  try {
    await verifySerializedFileScopeGrant(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FileScopeGuardError);
    return error as FileScopeGuardError;
  }
  throw new Error('expected verification to fail');
}

describe('Pi file-scope launch serialization (#1061 slice 3)', () => {
  it('round-trips a grant and re-verifies the same dev+ino identities', async () => {
    const grant = await grantFixture();
    const serialized = serializeFileScopeGrant(grant);
    expect(serialized.digest).toBe(grant.digest);
    expect(serialized.home.dev).toMatch(/^[0-9]+$/);
    expect(parseOrThrow(serialized)).toEqual(serialized);
    const verified = await verifySerializedFileScopeGrant(serialized);
    expect(verified.digest).toBe(grant.digest);
    expect(verified.roots[0]?.path).toBe(grant.roots[0]?.path);
  });

  it('refuses a grant whose admitted root no longer matches its digest', async () => {
    const grant = await grantFixture();
    // Replace the workspace root with a real, different directory while
    // keeping the digest the daemon admitted. Recreating the same path can
    // reuse its inode on APFS, so the deterministic identity mismatch is a
    // different root object, not a same-path inode gamble.
    const replacement = await tmpDir('byok-launch-replacement-');
    const serialized = JSON.parse(JSON.stringify(serializeFileScopeGrant(grant))) as {
      roots: { path: string; lexicalPath: string }[];
    };
    serialized.roots[0]!.path = replacement;
    serialized.roots[0]!.lexicalPath = replacement;
    const error = await verifyFailure(serialized as unknown as Parameters<typeof verifyFailure>[0]);
    expect(error.code).toBe('file_scope_unavailable');
    expect(error.reason).toBe('root_identity_changed');
  });

  it('refuses a symlinked, missing, or non-normalized root', async () => {
    const grant = await grantFixture();
    const serialized = JSON.parse(JSON.stringify(serializeFileScopeGrant(grant))) as Record<string, unknown>;
    const roots = serialized.roots as Record<string, unknown>[];
    expect(() => parseOrThrow({ ...serialized, roots: [{ ...roots[0], path: 'relative/root' }] })).toThrow(/normalized absolute/);
    expect(() => parseOrThrow({ ...serialized, roots: [{ ...roots[0], id: 'home' }] })).toThrow(/reserved home id/);
    expect(() => parseOrThrow({ ...serialized, mode: 'home' })).toThrow(/must not carry workspace roots/);
    expect(() => parseOrThrow({ ...serialized, digest: 'short' })).toThrow(/sha256/);
  });

  it('fails closed for Windows and unknown platforms', async () => {
    const grant = await grantFixture();
    const serialized = serializeFileScopeGrant(grant);
    for (const platform of ['win32', 'freebsd'] as const) {
      try {
        await verifySerializedFileScopeGrant(serialized, { platform });
        throw new Error('expected unsupported platform');
      } catch (error) {
        expect(error).toBeInstanceOf(FileScopeGuardError);
        expect((error as FileScopeGuardError).code).toBe('file_scope_unsupported');
        expect((error as FileScopeGuardError).reason).toBe('unsupported_platform');
      }
    }
  });
});
