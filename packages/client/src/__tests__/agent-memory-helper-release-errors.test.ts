import { afterEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: assets.resolve }) }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: assets.read,
}));
import { AGENT_MEMORY_HELPER_RELEASE } from '../util/agent-memory-helper-release-pin';
import { resolveAgentMemoryFilesystemHelper } from '../util/agent-memory-helper-release';

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
      assets.read.mockReturnValueOnce(JSON.stringify(AGENT_MEMORY_HELPER_RELEASE));
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

  it('reports missing explicit assets as a product deployment error and preserves the cause', () => {
    const cause = Object.assign(new Error('missing product manifest'), { code: 'ENOENT' });
    assets.read.mockImplementation(() => { throw cause; });
    expect(() => resolveAgentMemoryFilesystemHelper('/product/memory-assets')).toThrow(
      'deploy copyAgentMemoryHelperAssets output from the same SDK release',
    );
    try { resolveAgentMemoryFilesystemHelper('/product/memory-assets'); }
    catch (error) { expect((error as Error).cause).toBe(cause); }
    expect(assets.resolve).not.toHaveBeenCalled();
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
