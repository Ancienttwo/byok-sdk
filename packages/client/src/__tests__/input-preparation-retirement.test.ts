import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDaemonOwner, DaemonOwnerActiveError } from '../daemon/daemon-owner';
import {
  executeInputPreparationRetirement,
  inspectInputPreparationNamespace,
  InputPreparationRetirementConfirmationRequiredError,
  InputPreparationRetirementDaemonRunningError,
  InputPreparationRetirementRefusedError,
  INPUT_PREPARATION_RETIREMENT_COMMAND,
} from '../daemon/input-preparation-retirement';
import {
  InputPreparationStore,
  InputPreparationUnsupportedRecordVersionError,
  INPUT_PREPARATION_RECORD_VERSION,
} from '../daemon/input-preparation-store';

/**
 * WP1-I-R: the operator retirement of an older-version input-preparation
 * namespace, against a real temporary filesystem. Every record line below is
 * hand-written in the version-7 shape; nothing reads it through the store.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tmpRoot(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-ip-retire-')));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const FIXED_NOW = new Date('2026-09-28T01:02:03.004Z');
const clock = (): Date => FIXED_NOW;

function v7Record(recordId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'byok.input-preparation.record',
    version: 7,
    recordId,
    key: { scopeId: 'scope-a', agentRef: 'agent-a', requestId: `req-${recordId}` },
    requestDigest: `sha256:${recordId}`,
    state: 'prepared',
    binding: { runtimeId: 'pi' },
    model: { provider: 'openai', id: 'gpt-x' },
    artifactBytes: 12,
    counterCalls: 0,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    artifactExpiresAt: '2026-09-21T00:00:00.000Z',
    recordExpiresAt: '2026-09-22T00:00:00.000Z',
    ...extra,
  };
}

interface Seed {
  storeDir: string;
  namespace: string;
  agentSentinel: string;
  agentHomeSentinel: string;
}

async function seedStore(lines: string[], artifacts: Record<string, string> = { 'r1.json': '{"requestBody":"D1"}' }): Promise<Seed> {
  const root = await tmpRoot();
  const storeDir = path.join(root, 'store');
  const namespace = path.join(storeDir, 'input-preparation');
  await fs.mkdir(path.join(namespace, 'artifacts'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(namespace, 'records.jsonl'), lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
  for (const [name, content] of Object.entries(artifacts)) {
    await fs.writeFile(path.join(namespace, 'artifacts', name), content, { mode: 0o600 });
  }
  // Agent memory under the store and a separate Agent home root: neither may be touched.
  const agentSentinel = path.join(storeDir, 'agents', 'agent-a', 'memory', 'MEMORY.md');
  await fs.mkdir(path.dirname(agentSentinel), { recursive: true });
  await fs.writeFile(agentSentinel, '# memory sentinel\n');
  const agentHomeSentinel = path.join(root, 'agent-home', 'agents', 'agent-a', 'memory', 'MEMORY.md');
  await fs.mkdir(path.dirname(agentHomeSentinel), { recursive: true });
  await fs.writeFile(agentHomeSentinel, '# agent home sentinel\n');
  const old = new Date('2026-01-01T00:00:00.000Z');
  await fs.utimes(agentSentinel, old, old);
  await fs.utimes(agentHomeSentinel, old, old);
  return { storeDir, namespace, agentSentinel, agentHomeSentinel };
}

const v7Lines = (): string[] => [
  JSON.stringify(v7Record('r1')),
  JSON.stringify(v7Record('r2', { state: 'failed', artifactBytes: 0 })),
  JSON.stringify(v7Record('r2', { state: 'failed', artifactBytes: 0, version: 6 })),
];

/** Relative path -> sha256 (files), `dir` (directories) or `link:<target>` for every entry under `dir`. */
async function treeHash(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    let entries: string[];
    try {
      entries = (await fs.readdir(current)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      const rel = path.relative(dir, full);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) out[rel] = `link:${await fs.readlink(full)}`;
      else if (stat.isDirectory()) {
        out[rel] = 'dir';
        await walk(full);
      } else out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

async function sentinelState(seed: Seed): Promise<unknown> {
  const read = async (file: string) => ({ content: await fs.readFile(file, 'utf8'), mtimeMs: (await fs.stat(file)).mtimeMs });
  return { store: await read(seed.agentSentinel), home: await read(seed.agentHomeSentinel) };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

const execute = (storeDir: string, overrides: Partial<Parameters<typeof executeInputPreparationRetirement>[1]> = {}) =>
  executeInputPreparationRetirement(storeDir, { confirmed: true, controlOnline: false, clock, ...overrides });

async function expectUnchanged(seed: Seed, before: Record<string, string>): Promise<void> {
  expect(await treeHash(seed.namespace)).toEqual(before);
  await expect(fs.lstat(path.join(seed.storeDir, 'input-preparation-retired'))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('input-preparation retirement: inspection', () => {
  it('reports counts per version, pins, artifacts and unparseable lines, and writes nothing', async () => {
    const seed = await seedStore([
      ...v7Lines(),
      JSON.stringify(v7Record('r3', { pin: { taskId: 't', manifestDigest: 'm' } })),
      '{not json',
      '[1,2]',
    ]);
    const before = await treeHash(seed.storeDir);
    const inspection = await inspectInputPreparationNamespace(seed.storeDir);
    expect(inspection).toMatchObject({
      status: 'present',
      lineCount: 6,
      recordCount: 4,
      versionCounts: { 7: 3, 6: 1 },
      pinnedRecordCount: 1,
      unparseableLines: [5, 6],
      artifactFileCount: 1,
      unexpectedEntries: [],
    });
    expect(await treeHash(seed.storeDir)).toEqual(before);
  });

  it('opening the store before retirement still refuses the older record', async () => {
    const seed = await seedStore(v7Lines());
    const before = await treeHash(seed.namespace);
    const store = new InputPreparationStore({ storeDir: seed.storeDir, retentionMs: 60_000, retryHorizonMs: 30_000 });
    expect(await refusal(store.open())).toBeInstanceOf(InputPreparationUnsupportedRecordVersionError);
    expect(await treeHash(seed.namespace)).toEqual(before);
  });
});

describe('input-preparation retirement: refusals write nothing', () => {
  it('refuses without confirmation', async () => {
    const seed = await seedStore(v7Lines());
    const before = await treeHash(seed.namespace);
    expect(await refusal(execute(seed.storeDir, { confirmed: false }))).toBeInstanceOf(InputPreparationRetirementConfirmationRequiredError);
    await expectUnchanged(seed, before);
    await expect(fs.lstat(path.join(seed.storeDir, 'daemon-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses while the control socket is online, before taking the owner lease', async () => {
    const seed = await seedStore(v7Lines());
    const before = await treeHash(seed.namespace);
    expect(await refusal(execute(seed.storeDir, { controlOnline: true }))).toBeInstanceOf(InputPreparationRetirementDaemonRunningError);
    await expectUnchanged(seed, before);
    await expect(fs.lstat(path.join(seed.storeDir, 'daemon-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses while another process holds the owner lease', async () => {
    const seed = await seedStore(v7Lines());
    const before = await treeHash(seed.namespace);
    const lease = await acquireDaemonOwner(seed.storeDir, 'daemon');
    try {
      expect(await refusal(execute(seed.storeDir))).toBeInstanceOf(DaemonOwnerActiveError);
    } finally {
      await lease.release();
    }
    await expectUnchanged(seed, before);
  });

  it.each([
    ['pinned record', [...v7Lines(), JSON.stringify(v7Record('r3', { pin: { taskId: 't', manifestDigest: 'm' } }))], 'pinned_record'],
    ['mixed current-version record', [...v7Lines(), JSON.stringify(v7Record('r3', { version: INPUT_PREPARATION_RECORD_VERSION }))], 'current_version_present'],
    ['unparseable line', [...v7Lines(), '{"version":7,'], 'unparseable_line'],
    ['non-object line', [...v7Lines(), '7'], 'unparseable_line'],
    ['non-integer version', [...v7Lines(), JSON.stringify(v7Record('r3', { version: 6.5 }))], 'unsupported_version'],
    ['string version', [...v7Lines(), JSON.stringify(v7Record('r3', { version: '7' }))], 'unsupported_version'],
    ['missing version', [...v7Lines(), JSON.stringify({ ...v7Record('r3'), version: undefined })], 'unsupported_version'],
    ['future version', [...v7Lines(), JSON.stringify(v7Record('r3', { version: INPUT_PREPARATION_RECORD_VERSION + 1 }))], 'unsupported_version'],
    ['zero version', [...v7Lines(), JSON.stringify(v7Record('r3', { version: 0 }))], 'unsupported_version'],
  ])('refuses a %s', async (_name, lines, reason) => {
    const seed = await seedStore(lines);
    const before = await treeHash(seed.namespace);
    const error = await refusal(execute(seed.storeDir));
    expect(error).toBeInstanceOf(InputPreparationRetirementRefusedError);
    expect((error as InputPreparationRetirementRefusedError).reason).toBe(reason);
    await expectUnchanged(seed, before);
  });

  it('refuses a record still pinned at its last line, even when later lines belong to other records', async () => {
    const pin = { taskId: 't', manifestDigest: 'm' };
    const seed = await seedStore([
      JSON.stringify(v7Record('r1')),
      JSON.stringify(v7Record('r1', { pin })),
      JSON.stringify(v7Record('r2', { state: 'failed', artifactBytes: 0 })),
    ]);
    const before = await treeHash(seed.namespace);
    expect((await inspectInputPreparationNamespace(seed.storeDir)).pinnedRecordCount).toBe(1);
    const error = await refusal(execute(seed.storeDir));
    expect((error as InputPreparationRetirementRefusedError).reason).toBe('pinned_record');
    await expectUnchanged(seed, before);
  });

  it('refuses a pin on a line with no string recordId: it folds with nothing, so it stays live', async () => {
    const seed = await seedStore([
      JSON.stringify({ ...v7Record('r1'), recordId: undefined, pin: { taskId: 't', manifestDigest: 'm' } }),
      JSON.stringify({ ...v7Record('r1'), recordId: undefined }),
    ]);
    const before = await treeHash(seed.namespace);
    const error = await refusal(execute(seed.storeDir));
    expect((error as InputPreparationRetirementRefusedError).reason).toBe('pinned_record');
    await expectUnchanged(seed, before);
  });

  it('refuses artifacts with no record', async () => {
    const seed = await seedStore([]);
    const before = await treeHash(seed.namespace);
    const error = await refusal(execute(seed.storeDir));
    expect((error as InputPreparationRetirementRefusedError).reason).toBe('orphan_artifacts');
    await expectUnchanged(seed, before);
  });

  it('refuses an unexpected namespace entry', async () => {
    const seed = await seedStore(v7Lines());
    await fs.writeFile(path.join(seed.namespace, 'stray.bin'), 'x');
    const before = await treeHash(seed.namespace);
    const error = await refusal(execute(seed.storeDir));
    expect((error as InputPreparationRetirementRefusedError).reason).toBe('unexpected_entry');
    await expectUnchanged(seed, before);
  });

  it('refuses a symlinked namespace, in both inspection and execution', async () => {
    const seed = await seedStore(v7Lines());
    const elsewhere = path.join(path.dirname(seed.storeDir), 'elsewhere');
    await fs.rename(seed.namespace, elsewhere);
    await fs.symlink(elsewhere, seed.namespace, 'dir');
    const before = await treeHash(elsewhere);
    for (const attempt of [inspectInputPreparationNamespace(seed.storeDir), execute(seed.storeDir)]) {
      const error = await refusal(attempt);
      expect(error).toBeInstanceOf(InputPreparationRetirementRefusedError);
      expect((error as InputPreparationRetirementRefusedError).reason).toBe('symlink');
    }
    expect(await treeHash(elsewhere)).toEqual(before);
    expect((await fs.lstat(seed.namespace)).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(seed.storeDir, 'input-preparation-retired'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked records.jsonl', async () => {
    const seed = await seedStore(v7Lines());
    const elsewhere = path.join(path.dirname(seed.storeDir), 'records-elsewhere.jsonl');
    await fs.rename(path.join(seed.namespace, 'records.jsonl'), elsewhere);
    await fs.symlink(elsewhere, path.join(seed.namespace, 'records.jsonl'));
    const before = await treeHash(seed.namespace);
    const error = await refusal(execute(seed.storeDir));
    expect((error as InputPreparationRetirementRefusedError).reason).toBe('symlink');
    await expectUnchanged(seed, before);
  });

  it('refuses a symlinked input-preparation-retired directory', async () => {
    const seed = await seedStore(v7Lines());
    const elsewhere = path.join(path.dirname(seed.storeDir), 'retired-elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(seed.storeDir, 'input-preparation-retired'), 'dir');
    const before = await treeHash(seed.namespace);
    const error = await refusal(execute(seed.storeDir));
    expect((error as InputPreparationRetirementRefusedError).reason).toBe('symlink');
    expect(await treeHash(seed.namespace)).toEqual(before);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
});

describe('input-preparation retirement: success', () => {
  it('moves the namespace byte-for-byte, writes a matching manifest, leaves Agent memory alone, and reopens empty', async () => {
    const seed = await seedStore(v7Lines(), { 'r1.json': '{"requestBody":"D1"}', 'r9.json': '{"requestBody":"D9"}' });
    const namespaceBefore = await treeHash(seed.namespace);
    const logBytes = await fs.readFile(path.join(seed.namespace, 'records.jsonl'));
    const sentinelsBefore = await sentinelState(seed);

    const result = await execute(seed.storeDir);
    expect(result.status).toBe('retired');
    if (result.status !== 'retired') throw new Error('unreachable');

    const retiredRoot = path.join(seed.storeDir, 'input-preparation-retired');
    expect(result.retiredDir).toBe(path.join(retiredRoot, '2026-09-28T01-02-03-004Z-v6_7'));
    expect(await fs.readdir(retiredRoot)).toEqual(['2026-09-28T01-02-03-004Z-v6_7']);
    expect((await fs.stat(retiredRoot)).mode & 0o777).toBe(0o700);
    const moved = path.join(result.retiredDir, 'input-preparation');
    expect(await treeHash(moved)).toEqual(namespaceBefore);
    await expect(fs.lstat(seed.namespace)).rejects.toMatchObject({ code: 'ENOENT' });

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    expect(manifest).toEqual(result.manifest);
    expect(manifest).toMatchObject({
      command: INPUT_PREPARATION_RETIREMENT_COMMAND,
      retiredAt: FIXED_NOW.toISOString(),
      currentRecordVersion: INPUT_PREPARATION_RECORD_VERSION,
      retiredRecordVersions: [6, 7],
      recordCountsByVersion: { 6: 1, 7: 2 },
      recordCount: 3,
      retiredNamespace: 'input-preparation',
    });
    const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    const movedLog = await fs.readFile(path.join(moved, 'records.jsonl'));
    expect(movedLog).toEqual(logBytes);
    expect(manifest.recordLog).toEqual({ name: 'records.jsonl', sha256: sha(movedLog), sizeBytes: movedLog.length });
    const movedArtifacts = (await fs.readdir(path.join(moved, 'artifacts'))).sort();
    expect(manifest.artifacts).toEqual(
      await Promise.all(movedArtifacts.map(async (name) => {
        const bytes = await fs.readFile(path.join(moved, 'artifacts', name));
        return { name, sha256: sha(bytes), sizeBytes: bytes.length };
      })),
    );

    expect(await sentinelState(seed)).toEqual(sentinelsBefore);

    const store = new InputPreparationStore({ storeDir: seed.storeDir, retentionMs: 60_000, retryHorizonMs: 30_000 });
    await store.open();
    expect(store.list()).toEqual([]);
    store.close();

    // Second run: the namespace the store just recreated is empty, so nothing moves.
    const retiredBefore = await treeHash(retiredRoot);
    const second = await execute(seed.storeDir);
    expect(second.status).toBe('nothing-to-retire');
    expect(await treeHash(retiredRoot)).toEqual(retiredBefore);
  });

  it('retires a record that was pinned and then unpinned later in the log: only the effective line decides', async () => {
    const seed = await seedStore([
      JSON.stringify(v7Record('r1')),
      JSON.stringify(v7Record('r1', { pin: { taskId: 't', manifestDigest: 'm' } })),
      JSON.stringify(v7Record('r2', { state: 'failed', artifactBytes: 0 })),
      JSON.stringify(v7Record('r1')),
    ]);
    const namespaceBefore = await treeHash(seed.namespace);
    expect((await inspectInputPreparationNamespace(seed.storeDir)).pinnedRecordCount).toBe(0);
    const result = await execute(seed.storeDir);
    expect(result.status).toBe('retired');
    if (result.status !== 'retired') throw new Error('unreachable');
    expect(await treeHash(path.join(result.retiredDir, 'input-preparation'))).toEqual(namespaceBefore);
  });

  it('an absent namespace is a no-op that writes nothing to the namespace or the retired root', async () => {
    const seed = await seedStore(v7Lines());
    await fs.rm(seed.namespace, { recursive: true });
    const result = await execute(seed.storeDir);
    expect(result.status).toBe('nothing-to-retire');
    expect(result.inspection.status).toBe('absent');
    await expect(fs.lstat(seed.namespace)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(seed.storeDir, 'input-preparation-retired'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
