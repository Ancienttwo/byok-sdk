import { afterEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: assets.resolve }) }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: assets.read,
}));
import { resolveAgentMemoryFilesystemHelper } from '../daemon/agent-memory-helper-release';

afterEach(() => { vi.resetAllMocks(); });

function resolutionError(): Error {
  try { resolveAgentMemoryFilesystemHelper(); }
  catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Missing helper assets were admitted');
}

describe.skipIf(process.platform !== 'darwin')('SDK helper missing release assets', () => {
  const message = 'SDK Agent memory helper release assets missing; build with `bun run build:release`';

  it.each(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'])('keeps the missing package cause (%s)', code => {
    const cause = Object.assign(new Error("Cannot find module '@byok-sdk/client/package.json'"), { code });
    assets.resolve.mockImplementation(() => { throw cause; });
    const error = resolutionError();
    expect(error.message).toBe(message);
    expect(error.cause).toBe(cause);
    expect(assets.read).not.toHaveBeenCalled();
  });

  it.each(['manifest', 'binary'])('keeps the missing %s cause', missing => {
    assets.resolve.mockReturnValue('/sdk/package.json');
    const cause = Object.assign(new Error(`ENOENT: ${missing}`), { code: 'ENOENT' });
    if (missing === 'binary') {
      assets.read.mockReturnValueOnce(JSON.stringify({
        version: 1, helperVersion: '2', protocol: 2, go: 'go1.26.5',
        digestAlgorithm: 'mach-o-content-v1', signingPolicy: 'product-resigning-allowed',
        flags: ['-buildvcs=false', '-trimpath'], sourceDigest: 'a'.repeat(64),
        entries: { [`darwin-${process.arch}`]: { file: `darwin-${process.arch}`, digest: 'b'.repeat(64) } },
      }));
    }
    assets.read.mockImplementation(() => { throw cause; });
    const error = resolutionError();
    expect(error.message).toBe(message);
    expect(error.cause).toBe(cause);
    expect(assets.read).toHaveBeenLastCalledWith(
      missing === 'manifest' ? '/sdk/dist/native/agent-memory-fs/manifest.json' : `/sdk/dist/native/agent-memory-fs/darwin-${process.arch}`,
      ...(missing === 'manifest' ? ['utf8'] : []),
    );
  });

  it('keeps access errors unchanged', () => {
    assets.resolve.mockReturnValue('/sdk/package.json');
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    assets.read.mockImplementation(() => { throw cause; });
    expect(resolutionError()).toBe(cause);
  });

  it('still rejects an invalid release manifest', () => {
    assets.resolve.mockReturnValue('/sdk/package.json');
    assets.read.mockReturnValue('{}');
    expect(() => resolveAgentMemoryFilesystemHelper()).toThrow('SDK Agent memory helper release manifest mismatch');
  });
});
