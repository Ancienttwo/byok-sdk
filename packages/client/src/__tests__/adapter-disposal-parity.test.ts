import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeProcessClient } from '../adapters/claude/process-client';
import { CodexProcessRunner } from '../adapters/codex/process-runner';
import { PiRpcClient } from '../adapters/pi/rpc-client';

/**
 * Structural guard: process-tree termination has exactly one authority
 * (`adapters/process-tree.ts`). Every runtime client must route through it,
 * and none may grow a private shortcut — a per-adapter `taskkill`, a bare
 * `child.kill()`, or a direct `process.kill()` would silently reintroduce
 * the direct-child-only disposal this module exists to prevent, on one
 * runtime only, where the shared tests would never see it.
 *
 * Source-level on purpose: an import graph assertion would still pass if a
 * client imported the module and then bypassed it.
 */

const RUNTIME_CLIENTS = [
  { runtime: 'pi', file: '../adapters/pi/rpc-client.ts' },
  { runtime: 'claude', file: '../adapters/claude/process-client.ts' },
  { runtime: 'codex', file: '../adapters/codex/process-runner.ts' },
];

const REQUIRED_IMPORTS = [
  'disposeOwnedProcessTree',
  'requestOwnedProcessTreeTermination',
  'withOwnedProcessTree',
];

/** Comments legitimately DISCUSS taskkill and signals; only executable code is constrained. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('runtime clients share one process-tree disposal authority', () => {
  it.each(RUNTIME_CLIENTS)('$runtime imports every process-tree entry point from ../process-tree', ({ file }) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/process-tree';/);

    const importedNames = importMatch?.[1];
    expect(importedNames).toBeDefined();
    const imported = (importedNames ?? '').split(',').map((name) => name.trim());
    for (const required of REQUIRED_IMPORTS) expect(imported).toContain(required);
  });

  it.each(RUNTIME_CLIENTS)('$runtime has no private termination shortcut', ({ file }) => {
    const code = stripComments(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'));

    expect(code).not.toMatch(/taskkill/);
    expect(code).not.toMatch(/process\.kill\s*\(/);
    expect(code).not.toMatch(/spawnSync/);
    // `spawnFn(...)` for the runtime itself is expected; killing the child is not.
    expect(code).not.toMatch(/\bthis\.child\.kill\s*\(/);
  });
});

/**
 * The other half of the shared authority: every runtime client must also
 * refuse to publish when the win32 job-object backstop could not take the tree.
 *
 * Real processes, real termination, exercised from POSIX through each client's
 * adoption-scoped `platform` seam. The assignment is made to fail LATE — after
 * the fake runtime has already produced the frame each client treats as its
 * session/thread authority — because the interesting failure is not "the tree
 * died before it said anything", it is "the tree already looked ready and must
 * still be refused".
 */

const ADOPTION_REJECT_DELAY_MS = 250;

interface FailClosedClient {
  runtime: string;
  /** stdout the fake runtime emits at once: the frame the client would otherwise treat as ready. */
  readyFrame: string;
  /** Drives the client to its first awaited start operation and returns whatever it settles with. */
  start(spawnFn: unknown, jobObject: { assign(pid: number): Promise<void> }): Promise<unknown>;
}

const owned: ChildProcess[] = [];

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Spawns a real Node process that prints `readyFrame` and then idles, honouring the stdio the client asked for. */
function fakeRuntimeSpawn(readyFrame: string, pids: number[]): unknown {
  return (_command: string, _args: readonly string[], options: Record<string, unknown>) => {
    const source = `process.stdout.write(${JSON.stringify(readyFrame)}); setTimeout(() => {}, 60_000);`;
    const child = realSpawn(process.execPath, ['-e', source], options as never);
    owned.push(child);
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  };
}

const FAIL_CLOSED_CLIENTS: FailClosedClient[] = [
  {
    runtime: 'claude',
    readyFrame: `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'already-initialised' })}\n`,
    async start(spawnFn, jobObject) {
      const client = new ClaudeProcessClient({
        command: 'claude', args: [], cwd: process.cwd(), env: process.env,
        spawnFn: spawnFn as never, platform: 'win32', jobObject,
      });
      return client.waitForInit().then(() => undefined, (error: unknown) => error);
    },
  },
  {
    runtime: 'pi',
    readyFrame: `${JSON.stringify({ type: 'event', name: 'ready' })}\n`,
    async start(spawnFn, jobObject) {
      const client = new PiRpcClient({
        command: 'pi', args: [], cwd: process.cwd(), env: process.env,
        spawnFn: spawnFn as never, platform: 'win32', jobObject,
      });
      return client.send({ type: 'prompt', message: 'go' }).then(() => undefined, (error: unknown) => error);
    },
  },
  {
    runtime: 'codex',
    readyFrame: `${JSON.stringify({ type: 'thread.started', thread_id: 'already-started' })}\n`,
    async start(spawnFn, jobObject) {
      const delivered: unknown[] = [];
      const runner = new CodexProcessRunner({
        command: 'codex', args: [], cwd: process.cwd(), env: process.env,
        spawnFn: spawnFn as never, platform: 'win32', jobObject,
        onEvent: (evt) => delivered.push(evt),
      });
      // codex has no first awaited operation of its own: `codex-adapter.ts`
      // races the first event against this close, and reads the reason off
      // `buildExitError`. No event may have been delivered — a delivered
      // `thread.started` is exactly the published thread id this must prevent.
      await runner.waitClosed();
      expect(delivered).toEqual([]);
      return runner.buildExitError('codex exited before yielding an authoritative thread id');
    },
  },
];

afterEach(() => {
  for (const child of owned.splice(0)) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already reaped by the fail-closed teardown under test.
    }
  }
});

describe('runtime clients fail closed when the win32 job object cannot take the tree', () => {
  it.each(FAIL_CLOSED_CLIENTS)('$runtime refuses to publish and leaves no live tree', async ({ readyFrame, start }) => {
    const failure = new Error('AssignProcessToJobObject denied');
    const pids: number[] = [];

    const settled = await start(fakeRuntimeSpawn(readyFrame, pids), {
      assign: () => new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(failure), ADOPTION_REJECT_DELAY_MS);
      }),
    });

    expect(settled).toBe(failure);
    expect(pids).toHaveLength(1);
    expect(processGroupExists(pids[0] as number)).toBe(false);
  });
});
