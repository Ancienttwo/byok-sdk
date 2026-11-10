import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ protocol: 4, helperVersion: '4', requests: [] as Record<string, unknown>[],
  error: undefined as { code: string; message: string } | undefined }));
vi.mock('../util/agent-memory-helper-release', () => ({ verifyAgentMemoryFilesystemHelper: (bin: string) => bin }));
vi.mock('node:child_process', () => ({
  spawn: () => {
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

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
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
