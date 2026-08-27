import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const helperHarness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();

    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener): this {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(event) ?? [];
      if (listeners.length === 0 && event === 'error') throw args[0];
      for (const listener of listeners) listener(...args);
      return listeners.length !== 0;
    }
  }

  let lastChild: { exitCode: number | null } | undefined;
  const requests: Array<Record<string, unknown>> = [];
  const spawn = vi.fn(() => {
    const stdout = new Emitter();
    const stderr = new Emitter();
    const stdin = new Emitter() as Emitter & {
      write: (line: string, callback?: (error?: Error | null) => void) => boolean;
      end: () => void;
    };
    const child = Object.assign(new Emitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(),
    });
    stdin.write = (line, callback) => {
      const request = JSON.parse(line) as { id: string; op: string; expectedIdentity?: unknown };
      requests.push(request);
      queueMicrotask(() => {
        if (request.op === 'open') {
          stdout.emit('data', Buffer.from(`${JSON.stringify({
            id: request.id,
            ok: true,
            protocol: 2,
            result: { helperVersion: '2', identity: request.expectedIdentity },
          })}\n`));
          return;
        }
        const error = Object.assign(new Error('simulated helper stdin EPIPE'), { code: 'EPIPE' });
        callback?.(error);
        stdin.emit('error', error);
      });
      return false;
    };
    stdin.end = vi.fn();
    lastChild = child;
    return child;
  });

  return { spawn, lastChild: () => lastChild, requests: () => requests };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: helperHarness.spawn,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (filePath: Parameters<typeof actual.existsSync>[0]) => filePath === '/proc/self/fd' || actual.existsSync(filePath),
  };
});

import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function withPlatform<T>(platform: NodeJS.Platform, operation: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (descriptor === undefined) throw new Error('process.platform descriptor is unavailable for this regression guard');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

describe('Agent memory helper P1 regressions', () => {
  it('rejects a Linux helper configuration before native admission can forward it to the macOS-only helper', async () => {
    await withPlatform('linux', () => {
      expect(isAgentMemorySecureFilesystemAvailable(true)).toBe(true);
      expect(() => createDaemonWithAdapters({
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Agent memory Linux helper regression guard',
        productId: 'agent-memory-linux-helper-regression-guard',
        serverUrl: 'ws://localhost:1',
        workspaceRoot: path.join(process.cwd(), '.tmp-agent-memory-linux-helper-workspace'),
        agentHome: { hostStorageRoot: path.join(process.cwd(), '.tmp-agent-memory-linux-helper-home') },
        agentMemory: {},
        agentMemoryFilesystem: { helperBin: '/opt/byok-agent-memory-fs' },
      }, [new StubRuntimeAdapter('pi')])).toThrow('is not admitted on this platform');
    });
  });

  it('contains a helper stdin EPIPE as a rejected request instead of an uncaught process exception', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      // CI runs this suite on Linux, but the helper is intentionally admitted
      // only on macOS. Override only admission so the mocked stdin reaches the
      // EPIPE branch on every runner.
      await withPlatform('darwin', async () => {
        const filesystem = await openAgentMemoryFilesystemHelper({
          helperBin: '/opt/byok-agent-memory-fs',
          canonicalHome: '/tmp/byok-agent-memory-helper-epipe',
          homeIdentity: { dev: 1n, ino: 2n },
        });
        const expectedRevision = `sha256:${'0'.repeat(64)}`;
        const requestCount = helperHarness.requests().length;
        await expect(filesystem.replace('MEMORY.md', expectedRevision, 'x'.repeat(1025), 1024)).rejects.toThrow('exceeds its requested byte limit');
        expect(helperHarness.requests()).toHaveLength(requestCount);

        await expect(filesystem.replace('MEMORY.md', expectedRevision, '\u0000', 1024)).rejects.toThrow('could not be written');
        const requests = helperHarness.requests();
        const request = requests[requests.length - 1];
        expect(request).toMatchObject({ op: 'replace', contentBase64: 'AA', maxBytes: 1024 });
        expect(request).not.toHaveProperty('content');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(uncaught).toEqual([]);
        const child = helperHarness.lastChild();
        if (child === undefined) throw new Error('helper spawn was not observed');
        child.exitCode = 0;
        await filesystem.close();
      });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
