import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySdkNativeAssets, sdkDistributionManifest, sdkNativeAssetTargets } from '../sdk-native-assets';
import { resolveSdkReservedHelperBin } from '../sdk-reserved-helper-host';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-assets-')); roots.push(dir); return dir; }
it('uses the official lockfile integrity for cross-host Windows x64 copy', async () => {
  const lock = await fs.readFile(new URL('../../../../bun.lock', import.meta.url), 'utf8');
  const pin = sdkNativeAssetTargets['win32-x64'];
  expect(lock).toContain(`"${pin.package}@${pin.version}"`); expect(lock).toContain(pin.integrity);
  expect(pin.url).toBe('https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-3.3.7.tgz');
});
it('lists the Windows memory helper apart from Koffi with its own signing policy', async () => {
  const { AGENT_MEMORY_HELPER_RELEASE } = await import('../util/agent-memory-helper-release-pin');
  const target = sdkNativeAssetTargets['win32-x64'];
  expect(target.signingPolicy).toBe('unmodified-official-addon');
  expect(target.files).toEqual(['KOFFI-LICENSE.txt', 'manifest.json', 'win32-x64/koffi.node']);
  expect(target.agentMemoryHelper).toEqual({
    files: ['agent-memory-fs/manifest.json', `agent-memory-fs/${AGENT_MEMORY_HELPER_RELEASE.entries['win32-x64'].file}`],
    signingPolicy: 'product-resigning-allowed',
  });
});
it('refuses relative roots and unsupported targets before downloading', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(copySdkNativeAssets({ outDir: 'relative', platform: 'win32', arch: 'x64' })).rejects.toThrow('absolute');
  await expect(copySdkNativeAssets({ outDir: await root(), platform: 'win32', arch: 'arm64' })).rejects.toThrow('unsupported target'); expect(fetch).not.toHaveBeenCalled();
});
it('refuses a nonempty target without changing existing files', async () => {
  const dir = await root(); await fs.writeFile(path.join(dir, 'keep'), 'owned');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(copySdkNativeAssets({ outDir: dir, platform: 'win32', arch: 'x64' })).rejects.toThrow('empty');
  expect(await fs.readFile(path.join(dir, 'keep'), 'utf8')).toBe('owned'); expect(fetch).not.toHaveBeenCalled();
});
it('does not extract or write an archive with mismatched integrity', async () => {
  const dir = await root(); vi.stubGlobal('fetch', vi.fn(async () => new Response('not the official archive')));
  await expect(copySdkNativeAssets({ outDir: dir, platform: 'win32', arch: 'x64' })).rejects.toThrow('integrity mismatch'); expect(await fs.readdir(dir)).toEqual([]);
});
it('copies from archivePath without fetching, and a changed byte fails integrity', async () => {
  const { createHash } = await import('node:crypto'); const { gzipSync } = await import('node:zlib');
  const addon = Buffer.from('addon bytes'); const meta = Buffer.from(JSON.stringify({ name: 'pkg', version: '3.3.7' }));
  const member = (name: string, body: Buffer) => { const header = Buffer.alloc(512); header.write(name); header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header[156] = 48;
    return Buffer.concat([header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]); };
  const bytes = gzipSync(Buffer.concat([member('package/package.json', meta), member('package/win32_x64/koffi.node', addon), Buffer.alloc(1024)]));
  const pin = { package: 'pkg', version: '3.3.7', url: 'unused', sha256: createHash('sha256').update(addon).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  vi.resetModules(); vi.doMock('../sdk-native-assets-pin', () => ({ KOFFI: pin }));
  vi.doMock('../util/agent-memory-helper-release', () => ({ copyAgentMemoryHelperAssets: async () => [] }));
  const fetch = vi.fn(async () => { throw new Error('network disabled'); }); vi.stubGlobal('fetch', fetch);
  const { copySdkNativeAssets: copy } = await import('../sdk-native-assets');
  const archivePath = path.join(await root(), 'koffi.tgz'); await fs.writeFile(archivePath, bytes);
  const out = path.join(await root(), 'out');
  expect(await copy({ outDir: out, platform: 'win32', arch: 'x64', archivePath })).toContain('win32-x64/koffi.node');
  expect(await fs.readFile(path.join(out, 'win32-x64/koffi.node'))).toEqual(addon);
  bytes.writeUInt8(bytes.readUInt8(bytes.length >> 1) ^ 1, bytes.length >> 1); await fs.writeFile(archivePath, bytes);
  await expect(copy({ outDir: path.join(await root(), 'out2'), platform: 'win32', arch: 'x64', archivePath })).rejects.toThrow('integrity mismatch');
  expect(fetch).not.toHaveBeenCalled(); vi.doUnmock('../sdk-native-assets-pin'); vi.doUnmock('../util/agent-memory-helper-release');
});
it('publishes the actual reserved helper routing keys including describe', () => {
  expect(sdkDistributionManifest.reservedHelperKinds).toContain('agent-memory-describe'); expect(sdkDistributionManifest.piRuntimePin).toBeTruthy();
  for (const kind of sdkDistributionManifest.reservedHelperKinds) {
    const route = resolveSdkReservedHelperBin(kind, { mode: 'self-executable', executable: process.execPath });
    expect(route.args).toEqual(['__byok_sdk_helper', kind]);
  }
});

vi.mock('koffi', () => ({ default: { load: () => ({ func: () => () => 1 }), pointer: () => null } }));
it('never aliases an explicit invalid root to cached installed bindings', async () => {
  const { loadBindings } = await import('../adapters/win32-job-object');
  await loadBindings();
  await expect(loadBindings('<installed>')).rejects.toThrow('configured root');
  await expect(loadBindings(null as unknown as string)).rejects.toThrow('configured root');
});
it('rejects a jointly modified addon and manifest before loading native code', async () => {
  const dir = await root(); await fs.mkdir(path.join(dir, 'win32-x64'));
  const bytes = Buffer.from('modified native code');
  const { createHash } = await import('node:crypto');
  const pin = sdkNativeAssetTargets['win32-x64'];
  await fs.writeFile(path.join(dir, 'win32-x64/koffi.node'), bytes);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, target: 'win32-x64', package: pin.package,
    packageVersion: pin.version, archiveIntegrity: pin.integrity, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const getBuiltinModule = vi.fn();
  vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64', getBuiltinModule });
  const { loadSdkKoffiAsset } = await import('../sdk-native-assets');
  expect(() => loadSdkKoffiAsset(dir)).toThrow('deployment mismatch');
  expect(getBuiltinModule).not.toHaveBeenCalled();
});

it.each([true, false])('bounds archive bytes before hashing (declared length: %s)', async declared => {
  const dir = await root(); const cancel = vi.fn();
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, declared ? { headers: { 'content-length': String(9 * 1024 * 1024) } } : undefined)));
  await expect(copySdkNativeAssets({ outDir: dir, platform: 'win32', arch: 'x64' })).rejects.toThrow('size limit');
  expect(cancel).toHaveBeenCalled(); expect(await fs.readdir(dir)).toEqual([]);
});

it('classifies every published bin of every public package, and nothing else (#1104)', async () => {
  const packagesDir = fileURLToPath(new URL('../../../', import.meta.url));
  const published: Record<string, { package: string; target: string }> = {};
  for (const dir of await fs.readdir(packagesDir)) {
    const file = path.join(packagesDir, dir, 'package.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{"private":true}'));
    if (manifest.private === true) continue;
    for (const [name, target] of Object.entries<string>(manifest.bin ?? {})) published[name] = { package: manifest.name, target };
  }
  const { bins, reservedHelperKinds } = sdkDistributionManifest;
  // A new bin fails here until it has a role; a removed bin fails until its row goes.
  expect(Object.keys(bins).sort()).toEqual(Object.keys(published).sort());
  for (const [name, bin] of Object.entries(bins)) {
    expect(bin.package, name).toBe(published[name]!.package);
    if (bin.role === 'reserved-helper' || bin.role === 'pi-host') {
      // A re-entered bin is the dist script of its reserved kind.
      const route = resolveSdkReservedHelperBin(bin.kind!);
      expect(path.basename(route.args[0]!), name).toBe(path.basename(published[name]!.target));
      expect(bin.kind!.startsWith('pi-'), name).toBe(bin.role === 'pi-host');
    } else expect(bin.kind, name).toBeUndefined();
  }
  // Only the describe helper has no bin; it is a reserved kind all the same.
  const binKinds = Object.values(bins).flatMap(bin => bin.kind === undefined ? [] : [bin.kind]);
  expect(reservedHelperKinds.filter(kind => !binKinds.includes(kind))).toEqual(['agent-memory-describe']);
  const client = JSON.parse(await fs.readFile(path.join(packagesDir, 'client/package.json'), 'utf8'));
  expect(sdkDistributionManifest.nodeEngine).toBe(client.engines.node);
});
