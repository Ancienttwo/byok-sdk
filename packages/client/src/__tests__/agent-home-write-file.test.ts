import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOME_PROJECTION_STATE_FILE,
  AgentHomeError,
  AgentHomeLeaseManager,
  AgentHomeManager,
  createAgentHomeProjectionConsumer,
  type AgentHomeProjectionApplyFunction,
} from '../agent-home';

// The child process and this file use one stable lease owner, as a restarted
// daemon does. A different owner could not reclaim the killed child's lease.
const OWNER = 'agent-home-write-file-test';
const AGENT = 'writer-agent';
const FILES = ['AGENTS.md', 'CLAUDE.md', 'persona.json'] as const;
const SDK_ENTRIES = ['.byok', 'MEMORY.md', 'notes'];
const roots: string[] = [];
const children: ChildProcess[] = [];
let requests = 0;

const content = (name: string, revision: string) => `${name} revision ${revision}\n`.repeat(4096);

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-home-write-file-'));
  roots.push(root);
  const home = path.join(await fs.realpath(root), 'agents', AGENT);
  return { root, home, state: path.join(home, '.byok', AGENT_HOME_PROJECTION_STATE_FILE) };
}

function desired(revision: string) {
  requests += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requests).padStart(12, '0')}`,
    agentRef: { agentId: AGENT, profileRevision: revision },
    projectionHash: `sha256:${revision.repeat(64)}`,
    projection: { schemaVersion: 'writer.v1', revision },
  };
}

/** The same three writes as the child process: two string bodies and one byte body. */
const writeAll: AgentHomeProjectionApplyFunction = async ({ agentRef, writeHomeFile }) => {
  for (const name of FILES) {
    const body = content(name, agentRef.profileRevision);
    await writeHomeFile(name, name.endsWith('.json') ? new TextEncoder().encode(body) : body);
  }
};

function manager(root: string, apply: AgentHomeProjectionApplyFunction = writeAll) {
  return new AgentHomeManager({
    hostStorageRoot: root,
    leaseManager: new AgentHomeLeaseManager({ ownerId: OWNER }),
    projection: createAgentHomeProjectionConsumer(apply),
  });
}

/** Revision 1 bytes are `old`, revision 2 bytes are `new`. Any other content is `torn`. */
async function fileStates(home: string) {
  return Promise.all(FILES.map(async name => {
    const bytes = await fs.readFile(path.join(home, name), 'utf8');
    return bytes === content(name, '1') ? 'old' : bytes === content(name, '2') ? 'new' : 'torn';
  }));
}

async function recordedRevision(state: string): Promise<string> {
  return (JSON.parse(await fs.readFile(state, 'utf8')) as { agentRef: { profileRevision: string } }).agentRef.profileRevision;
}

async function extraEntries(home: string): Promise<string[]> {
  return (await fs.readdir(home)).filter(name => !SDK_ENTRIES.includes(name) && !(FILES as readonly string[]).includes(name));
}

/**
 * The unhandled rejections while `run` and the timers it starts settle. Node
 * reports one after the microtask queue drains, so a short timer is enough.
 */
async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const record = (reason: unknown) => { reasons.push(reason); };
  process.on('unhandledRejection', record);
  try {
    await run();
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', record);
  }
  return reasons;
}

describe('Agent-home projection writeHomeFile', () => {
  it('replaces each named file at the home root with mode 0600 on POSIX', async () => {
    const { root, home, state } = await fixture();
    await expect(manager(root).project(desired('1'))).resolves.toBe('applied');
    await expect(manager(root).project(desired('2'))).resolves.toBe('applied');
    expect(await fileStates(home)).toEqual(['new', 'new', 'new']);
    expect(await recordedRevision(state)).toBe('2');
    expect(await extraEntries(home)).toEqual([]);
    if (process.platform !== 'win32') {
      for (const name of FILES) expect((await fs.stat(path.join(home, name))).mode & 0o777).toBe(0o600);
    }
  });

  it('calls the hook again for the same revision and repairs a lost file', async () => {
    const { root, home } = await fixture();
    let calls = 0;
    const counted: AgentHomeProjectionApplyFunction = async input => { calls += 1; await writeAll(input); };
    await expect(manager(root, counted).project(desired('2'))).resolves.toBe('applied');
    await fs.unlink(path.join(home, 'CLAUDE.md'));
    await expect(manager(root, counted).project(desired('2'))).resolves.toBe('idempotent');
    expect(await fileStates(home)).toEqual(['new', 'new', 'new']);
    expect(calls).toBe(2);
  });

  it('refuses a name that is not one portable file name, and the SDK-owned entries', async () => {
    const { root, home } = await fixture();
    const names: unknown[] = ['', '.', '..', 'a/b', 'a\\b', 'C:AGENTS.md', 'AGENTS.md:stream', 'a?b', 'a*b', 'a<b',
      'a>b', 'a|b', 'a"b', 'line\nbreak', 'nul\u0000', 'trailing.', 'trailing ', 'CON', 'con.md', 'Nul', 'AUX',
      'PRN', 'COM1', 'lpt9.txt', '.byok', '.BYOK', 'MEMORY.md', 'memory.MD', 'notes', 'NOTES', 7, undefined];
    const failures: unknown[] = [];
    await expect(manager(root, async ({ writeHomeFile }) => {
      for (const name of names) failures.push(await writeHomeFile(name as string, 'refused').catch((error: unknown) => error));
    }).project(desired('1'))).resolves.toBe('applied');
    expect(failures).toHaveLength(names.length);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AgentHomeError);
      expect((failure as Error).message).toMatch(/^invalid Agent home file name: /);
    }
    expect((await fs.readdir(home)).sort()).toEqual(SDK_ENTRIES);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('');
  });

  it('refuses a write after the hook settles', async () => {
    const { root, home } = await fixture();
    let stashed: ((name: string, body: string) => Promise<void>) | undefined;
    await expect(manager(root, ({ writeHomeFile }) => { stashed = writeHomeFile; }).project(desired('1')))
      .resolves.toBe('applied');
    await expect(stashed!('AGENTS.md', 'late')).rejects.toThrow('writeHomeFile is valid only while the projection hook runs');
    await expect(fs.access(path.join(home, 'AGENTS.md'))).rejects.toThrow();
  });

  it('leaves no unhandled rejection for a refused name that the hook does not await', async () => {
    const { root, home } = await fixture();
    expect(await unhandledRejections(async () => {
      await expect(manager(root, ({ writeHomeFile }) => { void writeHomeFile('a/b', 'refused'); })
        .project(desired('1'))).resolves.toBe('applied');
    })).toEqual([]);
    expect((await fs.readdir(home)).sort()).toEqual(SDK_ENTRIES);
  });

  it('leaves no unhandled rejection for a call after the hook settles that nobody awaits', async () => {
    const { root, home } = await fixture();
    let stashed: ((name: string, body: string) => Promise<void>) | undefined;
    await expect(manager(root, ({ writeHomeFile }) => { stashed = writeHomeFile; }).project(desired('1')))
      .resolves.toBe('applied');
    expect(await unhandledRejections(async () => {
      setTimeout(() => { void stashed!('AGENTS.md', 'late'); }, 0);
    })).toEqual([]);
    await expect(fs.access(path.join(home, 'AGENTS.md'))).rejects.toThrow();
  });

  it('waits for every started write, and a failed write fails the projection', async () => {
    const { root, home, state } = await fixture();
    await expect(manager(root, ({ writeHomeFile }) => { void writeHomeFile('AGENTS.md', 'not awaited'); })
      .project(desired('1'))).resolves.toBe('applied');
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe('not awaited');

    // A directory at the name makes the rename fail on every platform.
    await fs.mkdir(path.join(home, 'blocked.md'));
    await expect(manager(root, ({ writeHomeFile }) => { void writeHomeFile('blocked.md', 'fails'); })
      .project(desired('2'))).rejects.toThrow();
    expect(await recordedRevision(state)).toBe('1');

    // A failed write fails the projection even when the hook catches it.
    await expect(manager(root, async ({ writeHomeFile }) => {
      await writeHomeFile('blocked.md', 'fails').catch(() => {});
    }).project(desired('2'))).rejects.toThrow();
    expect(await recordedRevision(state)).toBe('1');

    // The hook's own error wins over the failed write that it did not await.
    await expect(manager(root, ({ writeHomeFile }) => {
      void writeHomeFile('blocked.md', 'fails');
      throw new Error('hook failed');
    }).project(desired('2'))).rejects.toThrow('hook failed');
    expect(await recordedRevision(state)).toBe('1');
  });

  it('replaces a link at the name and does not write through it', async ({ skip }) => {
    const { root, home } = await fixture();
    await expect(manager(root, () => {}).project(desired('1'))).resolves.toBe('applied');
    const outside = path.join(root, 'outside.md');
    await fs.writeFile(outside, 'outside');
    try {
      await fs.symlink(outside, path.join(home, 'AGENTS.md'), 'file');
    } catch (error) {
      // Windows needs the symbolic link privilege for this setup step only.
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') skip();
      throw error;
    }
    await expect(manager(root, ({ writeHomeFile }) => writeHomeFile('AGENTS.md', 'inside')).project(desired('2')))
      .resolves.toBe('applied');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
    expect((await fs.lstat(path.join(home, 'AGENTS.md'))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe('inside');
  });
});

describe('Agent-home projection writeHomeFile under a process kill', () => {
  const childScript = fileURLToPath(new URL('./fixtures/agent-home-write-file-child.mjs', import.meta.url));
  const clientEntry = new URL('../../dist/index.js', import.meta.url).href;

  /** Run one revision 2 delivery in a child process and kill the child at `checkpoint`. */
  async function killAt(root: string, checkpoint: string): Promise<void> {
    const input = path.join(root, 'child-input.json');
    await fs.writeFile(input, JSON.stringify({ clientEntry, root, ownerId: OWNER, files: FILES, checkpoint, payload: desired('2') }));
    const child = spawn(process.execPath, [childScript, input], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no checkpoint ${checkpoint} within 30 s: ${output}`)), 30_000);
      const read = (data: Buffer) => {
        output += String(data);
        if (output.includes(`checkpoint ${checkpoint}\n`)) { clearTimeout(timer); resolve(); }
      };
      child.stdout!.on('data', read);
      child.stderr!.on('data', read);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited with ${code} before ${checkpoint}: ${output}`)); });
    });
    child.kill('SIGKILL');
    await exited;
  }

  const STATE = AGENT_HOME_PROJECTION_STATE_FILE;
  it.each([
    { checkpoint: 'temp-partial:AGENTS.md', files: ['old', 'old', 'old'], recorded: '1', redelivery: 'applied', residue: 'AGENTS.md' },
    { checkpoint: 'before-rename:CLAUDE.md', files: ['new', 'old', 'old'], recorded: '1', redelivery: 'applied', residue: 'CLAUDE.md' },
    { checkpoint: 'after-rename:persona.json', files: ['new', 'new', 'new'], recorded: '1', redelivery: 'applied', residue: undefined },
    { checkpoint: `before-rename:${STATE}`, files: ['new', 'new', 'new'], recorded: '1', redelivery: 'applied', residue: undefined },
    { checkpoint: `after-rename:${STATE}`, files: ['new', 'new', 'new'], recorded: '2', redelivery: 'idempotent', residue: undefined },
  ])('keeps each file old or new after a kill at $checkpoint, and a redelivery completes it', async ({
    checkpoint, files, recorded, redelivery, residue,
  }) => {
    const { root, home, state } = await fixture();
    await expect(manager(root).project(desired('1'))).resolves.toBe('applied');

    await killAt(root, checkpoint);
    expect(await fileStates(home)).toEqual(files);
    expect(await recordedRevision(state)).toBe(recorded);
    const extra = await extraEntries(home);
    if (residue === undefined) {
      expect(extra).toEqual([]);
    } else {
      // The killed write leaves its own temp file, and only that one.
      expect(extra).toHaveLength(1);
      expect(extra[0]).toMatch(new RegExp(`^${residue.replaceAll('.', '\\.')}\\.\\d+-\\d+\\.tmp$`));
      if (checkpoint.startsWith('temp-partial:')) {
        const torn = Buffer.byteLength(content(residue, '2')) >> 1;
        expect((await fs.stat(path.join(home, extra[0]!))).size).toBe(torn);
      }
    }

    await expect(manager(root).project(desired('2'))).resolves.toBe(redelivery);
    expect(await fileStates(home)).toEqual(['new', 'new', 'new']);
    expect(await recordedRevision(state)).toBe('2');
    await expect(manager(root).project(desired('2'))).resolves.toBe('idempotent');
    expect(await fileStates(home)).toEqual(['new', 'new', 'new']);
    expect(await extraEntries(home)).toEqual(extra);
  }, 60_000);
});
