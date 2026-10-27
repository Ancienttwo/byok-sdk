import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBunBin } from './support/test-bun-bin';
import { testScratchRoot } from './fixtures/execution-scratch';

const capture = vi.hoisted(() => ({
  helper: vi.fn<() => string>(),
  surface: undefined as ReturnType<typeof import('../daemon/prepared-tool-surface').createPreparedToolSurfaceAssembler> | undefined,
}));
vi.mock('../daemon/agent-memory-helper-release', () => ({ resolveAgentMemoryFilesystemHelper: capture.helper }));
vi.mock('../daemon/prepared-tool-surface', async importOriginal => {
  const actual = await importOriginal<typeof import('../daemon/prepared-tool-surface')>();
  return { ...actual, createPreparedToolSurfaceAssembler: (deps: Parameters<typeof actual.createPreparedToolSurfaceAssembler>[0]) => {
    capture.surface = actual.createPreparedToolSurfaceAssembler(deps);
    return capture.surface;
  } };
});
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { isAgentMemoryFilesystemHelperSupported } from '../daemon/agent-memory-fs-helper';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  capture.helper.mockReset();
  capture.surface = undefined;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-admission-'));
  roots.push(value);
  return value;
}

function config(directory: string) {
  return { productName: 'Availability', productId: 'availability', serverUrl: 'http://localhost:1',
    storeDir: path.join(directory, 'store'), localAgentRelease: { version: '0.0.0-test' }, storage: { scratchRoot: testScratchRoot() },
    agentHome: { hostStorageRoot: path.join(directory, 'homes') } };
}

describe.skipIf(!isAgentMemoryFilesystemHelperSupported())('helper platform native deployment admission', () => {
  it.each(['missing SDK package', 'missing binary', 'digest mismatch'])('refuses prepared memory before probing when the helper has %s', async message => {
    capture.helper.mockImplementation(() => { throw new Error(message); });
    createDaemonWithAdapters(config(await root()), []);
    expect(capture.helper).toHaveBeenCalledOnce();
    expect(await capture.surface!.resolveBinding({ requiredToolsets: [], agentMemory: 'read' })).toMatchObject({
      ok: false, code: 'unsupported_input', detail: 'agent_memory_unavailable',
    });
    expect(await capture.surface!.resolveBinding({ requiredToolsets: [], agentMemory: 'none' })).toMatchObject({ ok: true });
  });

  it('fails closed for an explicit asset root without projection or intent configuration', async () => {
    capture.helper.mockImplementation(() => { throw new Error('SDK deployment digest mismatch'); });
    expect(() => createDaemonWithAdapters({ ...config('/tmp/byok-explicit-assets'), agentMemoryHelperAssetRoot: '/tmp/product/assets' }, [])).toThrow('SDK deployment digest mismatch');
    expect(capture.helper).toHaveBeenCalledWith('/tmp/product/assets');
  });

  it('retains the explicit intent deployment refusal before advertising', async () => {
    capture.helper.mockImplementation(() => { throw new Error('SDK deployment digest mismatch'); });
    expect(() => createDaemonWithAdapters({ ...config('/tmp/byok-intent-admission'), agentMemoryIntents: {
      fetch: async () => { throw new Error('not reached'); }, complete: async () => { throw new Error('not reached'); },
    } }, [])).toThrow('SDK deployment digest mismatch');
  });

  const bun = resolveBunBin();
  it.skipIf(bun === undefined)('rejects hosted memory in a real compiled product with no SDK native assets', async () => {
    const directory = await root();
    const executable = path.join(directory, process.platform === 'win32' ? 'memory-product.exe' : 'memory-product');
    const fixture = fileURLToPath(new URL('./fixtures/agent-memory-compiled-availability.ts', import.meta.url));
    execFileSync(bun!, ['build', fixture, '--compile', '--outfile', executable], { stdio: 'pipe' });
    const result = JSON.parse(execFileSync(executable, [directory], { encoding: 'utf8' }));
    expect(result.plainDaemonAdmitted).toBe(true);
    expect(result.memoryAdmitted).toBe(false);
    expect(result.memoryError).toBe(result.assetError);
    expect(result.assetError).toBe('Error: SDK Agent memory helper release assets missing; build with `bun run build:release`');
  }, 30_000);
});
