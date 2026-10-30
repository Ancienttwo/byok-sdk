import { execFileSync, spawn } from 'node:child_process';
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
import { fakeRuntimeAdapter } from '../testing';
import { isAgentMemoryFilesystemHelperSupported } from '../daemon/agent-memory-fs-helper';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  capture.helper.mockReset();
  capture.surface = undefined;
  await Promise.all(roots.splice(0).map(removeFixtureRoot));
});

async function removeFixtureRoot(directory: string): Promise<void> {
  // Windows can refuse unlink while an executable still has a handle/image
  // mapping. Retry only busy-file errors; persistent locks must remain failures.
  for (let retry = 0; ; retry++) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || retry === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (retry + 1)));
    }
  }
}

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-admission-'));
  roots.push(value);
  return value;
}

describe('compiled-product fixture cleanup', () => {
  it.each(['EBUSY', 'EPERM'])('removes the real fixture after transient %s errors stop', async code => {
    const directory = await root();
    const executable = path.join(directory, 'memory-product.exe');
    await fs.writeFile(executable, 'fixture');
    const remove = fs.rm.bind(fs);
    const busy = Object.assign(new Error('executable is busy'), { code });
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockImplementation(remove);
    await removeFixtureRoot(directory);
    await expect(fs.lstat(executable)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still reports a persistently busy fixture after the bounded attempts', async () => {
    const directory = await root();
    const executable = path.join(directory, 'memory-product.exe');
    await fs.writeFile(executable, 'fixture');
    const busy = Object.assign(new Error('executable remains busy'), { code: 'EBUSY' });
    const remove = vi.spyOn(fs, 'rm').mockRejectedValue(busy);
    await expect(removeFixtureRoot(directory)).rejects.toBe(busy);
    expect(remove).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(executable, 'utf8')).toBe('fixture');
  });

  it('reports non-busy cleanup errors immediately', async () => {
    const directory = await root();
    const denied = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    const remove = vi.spyOn(fs, 'rm').mockRejectedValue(denied);
    await expect(removeFixtureRoot(directory)).rejects.toBe(denied);
    expect(remove).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === 'win32')('removes an executable once its real Windows image mapping is released', async () => {
    const directory = await root();
    const executable = path.join(directory, 'held-node.exe');
    await fs.copyFile(process.execPath, executable);
    const child = spawn(executable, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n');"], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', () => resolve());
        child.once('exit', code => reject(new Error(`image holder exited before ready: ${code}`)));
      });
      const blocked = await fs.rm(directory, { recursive: true, force: true }).then(() => undefined, error => error as NodeJS.ErrnoException);
      expect(blocked?.code).toMatch(/^(EBUSY|EPERM)$/u);
      release = setTimeout(() => child.stdin.end(), 100);
      await removeFixtureRoot(directory);
      await closed;
      await expect(fs.lstat(executable)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (release !== undefined) clearTimeout(release);
      child.kill();
      await closed;
    }
  });
});

function config(directory: string) {
  return { productName: 'Availability', productId: 'availability', serverUrl: 'http://localhost:1',
    storeDir: path.join(directory, 'store'), localAgentRelease: { version: '0.0.0-test' }, storage: { scratchRoot: testScratchRoot() },
    agentHome: { hostStorageRoot: path.join(directory, 'homes') } };
}

describe.skipIf(!isAgentMemoryFilesystemHelperSupported())('helper platform native deployment admission', () => {
  it.each(['missing SDK package', 'missing binary', 'digest mismatch'])('refuses prepared memory before probing when the helper has %s', async message => {
    capture.helper.mockImplementation(() => { throw new Error(message); });
    // The prepared lane binds the Pi adapter's runtime environment (#1095).
    createDaemonWithAdapters(config(await root()), [fakeRuntimeAdapter('pi')]);
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
