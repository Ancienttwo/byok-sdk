import { afterEach, describe, expect, it, vi } from 'vitest';

const manifest = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: manifest.resolve }) }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: manifest.read,
}));
import clientPackage from '../../package.json';
import { clientManifestPath, clientPackageRoot } from '../adapters/pi/client-manifest';

afterEach(() => { vi.resetAllMocks(); });

/**
 * #724: the require resolver also searches `NODE_PATH` and the global folders,
 * which ESM does not. A manifest found there is another client install, and
 * its `dist/bin` must never be launched.
 */
describe('client manifest identity', () => {
  it('returns the resolved manifest when it is this client', () => {
    manifest.resolve.mockReturnValue('/install/node_modules/@byok-sdk/client/package.json');
    manifest.read.mockReturnValue(JSON.stringify({ name: clientPackage.name, version: clientPackage.version }));
    expect(clientPackageRoot()).toBe('/install/node_modules/@byok-sdk/client');
    expect(manifest.resolve).toHaveBeenCalledWith('@byok-sdk/client/package.json');
  });

  it.each([
    ['another version', { name: clientPackage.name, version: '0.0.0-other' }],
    ['another package', { name: '@example/client', version: clientPackage.version }],
  ])('refuses a manifest of %s', (_case, found) => {
    manifest.resolve.mockReturnValue('/global/node_modules/@byok-sdk/client/package.json');
    manifest.read.mockReturnValue(JSON.stringify(found));
    expect(() => clientManifestPath()).toThrow(
      '/global/node_modules/@byok-sdk/client/package.json is another client; reinstall @byok-sdk/client');
  });
});
