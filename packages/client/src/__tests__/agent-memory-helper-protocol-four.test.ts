import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ protocol: 4, helperVersion: '4', requests: [] as Record<string, unknown>[],
  barriers: [] as Record<string, unknown>[], commands: [] as string[], deferBarrier: false,
  finishBarrier: undefined as (() => void) | undefined, barrierError: null as Error | null,
  error: undefined as { code: string; message: string } | undefined }));
vi.mock('../util/agent-memory-helper-release', () => ({ verifyAgentMemoryFilesystemHelper: (bin: string) => bin }));
vi.mock('node:child_process', () => ({
  execFile: (_bin: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null) => void) => {
    wire.commands.push(args[0]!);
    expect(options).toMatchObject({ shell: false, windowsHide: true, env: {}, timeout: 10_000, maxBuffer: 4096 });
    return { stdin: new Writable({
      write(chunk, _encoding, done) { wire.barriers.push(JSON.parse(String(chunk))); done(); },
      final(done) {
        wire.finishBarrier = () => callback(wire.barrierError);
        if (!wire.deferBarrier) queueMicrotask(wire.finishBarrier);
        done();
      },
    }) };
  },
  spawn: () => {
    wire.commands.push('serve');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
      kill: () => { child.exitCode = 0; child.emit('exit', 0, null); return true; },
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const request = JSON.parse(String(chunk)) as Record<string, unknown>;
          wire.requests.push(request);
          queueMicrotask(() => {
            const response = wire.error === undefined
              ? { ok: true, result: request.op === 'open' ? { helperVersion: wire.helperVersion, identity: request.expectedIdentity } : {} }
              : { ok: false, error: wire.error };
            child.stdout.write(`${JSON.stringify({ id: request.id, protocol: wire.protocol, ...response })}\n`);
            if (request.op === 'close') { child.exitCode = 0; child.emit('exit', 0, null); }
          });
          done();
        },
      }),
    });
    return child;
  },
}));
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { AgentHomeLayout } from '../agent-home';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  wire.barriers.length = 0;
  wire.commands.length = 0;
  wire.deferBarrier = false;
  wire.finishBarrier = undefined;
  wire.barrierError = null;
  wire.protocol = 4;
  wire.helperVersion = '4';
  wire.error = undefined;
  wire.requests.length = 0;
});
function input() {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  return { helperBin: path.resolve('helper'), canonicalHome: path.resolve('host/agents/one'), ancestorRoot: path.resolve('host'), homeIdentity: { dev: 1n, ino: 2n } };
}

describe('protocol 4 transport contract (#605)', () => {
  async function createdRootInput() {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-root-')));
    roots.push(parent);
    const ancestorRoot = path.join(parent, 'host');
    const home = await new AgentHomeLayout(ancestorRoot).resolve({ agentId: 'one', profileRevision: 'p1' });
    return { ...input(), ancestorRoot, canonicalHome: home.canonicalHome };
  }

  it.each(['darwin', 'win32'])('runs the native root barrier once before concurrent opens on %s', async target => {
    const selected = await createdRootInput();
    Object.defineProperty(process, 'platform', { ...platform, value: target });
    Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
    wire.deferBarrier = true;
    const first = openAgentMemoryFilesystemHelper(selected);
    const second = openAgentMemoryFilesystemHelper(selected);
    expect(wire.commands).toEqual(['root-barrier']);
    expect(wire.barriers).toEqual([{ root: selected.ancestorRoot }]);
    expect(wire.requests).toEqual([]);
    wire.finishBarrier!();
    const filesystems = await Promise.all([first, second]);
    filesystems.push(await openAgentMemoryFilesystemHelper(selected));
    expect(wire.commands).toEqual(['root-barrier', 'serve', 'serve', 'serve']);
    await Promise.all(filesystems.map(filesystem => filesystem.close()));
  });

  it('refuses helper open on a failed barrier and retries before granting authority', async () => {
    const selected = await createdRootInput();
    wire.barrierError = new Error(`private native failure at ${selected.ancestorRoot}`);
    await expect(openAgentMemoryFilesystemHelper(selected)).rejects.toMatchObject({ name: 'AgentMemoryIoError',
      message: 'Agent memory hostStorageRoot durability barrier failed; helper open refused' });
    expect(wire.commands).toEqual(['root-barrier']);
    expect(wire.requests).toEqual([]);
    wire.barrierError = null;
    const filesystem = await openAgentMemoryFilesystemHelper(selected);
    expect(wire.commands).toEqual(['root-barrier', 'root-barrier', 'serve']);
    await filesystem.close();
  });

  it('sends the separately selected ancestor root in the first request', async () => {
    const selected = input();
    const filesystem = await openAgentMemoryFilesystemHelper(selected);
    expect(wire.requests[0]).toEqual({ id: 'm1', protocol: 4, op: 'open', root: selected.canonicalHome,
      ancestorRoot: selected.ancestorRoot, expectedIdentity: { kind: 'unix', dev: '1', ino: '2' } });
    await filesystem.close();
  });
  it('gives the Host a same-volume remedy when the ancestor chain is refused', async () => {
    wire.error = { code: 'ancestor_volume_mismatch', message: 'private diagnostic must not be forwarded' };
    const refused = openAgentMemoryFilesystemHelper(input());
    await expect(refused).rejects.toThrow('ancestor_volume_mismatch. Put the agents directory on the same volume as hostStorageRoot.');
    await expect(refused).rejects.not.toThrow(wire.error.message);
    expect(wire.requests.map(request => request.op)).toEqual(['open', 'close']);
  });
  it.each([3, 5])('rejects response protocol %s without granting filesystem authority', async protocol => {
    wire.protocol = protocol;
    await expect(openAgentMemoryFilesystemHelper(input())).rejects.toThrow('invalid response');
    expect(wire.requests.map(request => request.op)).toEqual(['open']);
  });
  it.each(['3', '5'])('rejects helper version %s even in a protocol-4 response', async version => {
    wire.helperVersion = version;
    await expect(openAgentMemoryFilesystemHelper(input())).rejects.toThrow('version mismatch');
    expect(wire.requests.map(request => request.op)).toEqual(['open', 'close']);
  });
  it.each([undefined, '', 'relative'])('rejects absent or invalid ancestor %s before spawn', async ancestorRoot => {
    const selected = input();
    // The public type requires this field; also prove the untyped caller boundary.
    await expect(openAgentMemoryFilesystemHelper({ ...selected, ancestorRoot: ancestorRoot as string })).rejects.toThrow('explicit absolute ancestor root');
    expect(wire.requests).toEqual([]);
  });
});
