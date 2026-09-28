import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  retireInputPreparation,
  InputPreparationRetirementConfirmationRequiredError,
  InputPreparationRetirementDaemonRunningError,
  InputPreparationRetirementRefusedError,
  InputPreparationRetirementStoreBusyError,
  type RetireInputPreparationInput,
} from '../index';
import type { ConnectControlResult, ControlClient } from '../bin/control-client';
import { acquireDaemonOwner } from '../daemon/daemon-owner';
import { runInputPreparationRetirement } from '../daemon/input-preparation-retirement';
import { INPUT_PREPARATION_RECORD_VERSION } from '../daemon/input-preparation-store';

/**
 * The public, programmatic retirement (`retireInputPreparation`) that the
 * `byok-agent retire-input-preparation` CLI renders. Real temporary stores,
 * the real control-socket probe and the real owner lease.
 */

const PRODUCT = 'retire-api-product';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function record(recordId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 'byok.input-preparation.record', version: 7, recordId, state: 'prepared', artifactBytes: 3, ...extra });
}

async function seed(lines: string[]): Promise<{ storeDir: string; namespace: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-ip-retire-api-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const storeDir = path.join(root, 'store');
  const namespace = path.join(storeDir, 'input-preparation');
  await fs.mkdir(path.join(namespace, 'artifacts'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(namespace, 'records.jsonl'), lines.map((line) => `${line}\n`).join(''));
  await fs.writeFile(path.join(namespace, 'artifacts', 'r1.json'), '{"D":1}');
  return { storeDir, namespace };
}

async function treeHash(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await fs.readdir(current)).sort()) {
      const full = path.join(current, entry);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) out[path.relative(dir, full)] = `link:${await fs.readlink(full)}`;
      else if (stat.isDirectory()) {
        out[path.relative(dir, full)] = 'dir';
        await walk(full);
      } else out[path.relative(dir, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

const EXECUTE: RetireInputPreparationInput = { mode: 'execute', confirmed: true };

describe('retireInputPreparation (public API)', () => {
  it('preview inspects and writes nothing, not even an owner lease file', async () => {
    const { storeDir } = await seed([record('r1'), record('r2', { version: 6 })]);
    const before = await treeHash(storeDir);
    const result = await retireInputPreparation({ productId: PRODUCT, storeDir }, { mode: 'preview' });
    expect(result).toMatchObject({
      status: 'inspected',
      inspection: { status: 'present', recordCount: 2, versionCounts: { 6: 1, 7: 1 }, pinnedRecordCount: 0, artifactFileCount: 1 },
    });
    expect(await treeHash(storeDir)).toEqual(before);
  });

  it('execute moves the namespace with a manifest, then is a no-op', async () => {
    const { storeDir, namespace } = await seed([record('r1')]);
    const recordBytes = await fs.readFile(path.join(namespace, 'records.jsonl'));
    const first = await retireInputPreparation({ productId: PRODUCT, storeDir }, EXECUTE);
    if (first.status !== 'retired') throw new Error(`expected retired, got ${first.status}`);
    expect(first.manifest).toMatchObject({
      command: 'retire-input-preparation',
      retiredRecordVersions: [7],
      currentRecordVersion: INPUT_PREPARATION_RECORD_VERSION,
      recordLog: { sha256: createHash('sha256').update(recordBytes).digest('hex'), sizeBytes: recordBytes.length },
    });
    await expect(fs.lstat(namespace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(first.retiredDir, 'input-preparation', 'records.jsonl'))).toEqual(recordBytes);
    expect(JSON.parse(await fs.readFile(first.manifestPath, 'utf8'))).toEqual(first.manifest);

    const after = await treeHash(storeDir);
    const second = await retireInputPreparation({ productId: PRODUCT, storeDir }, EXECUTE);
    expect(second.status).toBe('nothing-to-retire');
    expect(await treeHash(storeDir)).toEqual(after);
  });

  it('execute requires explicit confirmation and a known mode', async () => {
    const { storeDir } = await seed([record('r1')]);
    const before = await treeHash(storeDir);
    expect(await failure(retireInputPreparation({ productId: PRODUCT, storeDir }, { mode: 'execute' } as unknown as RetireInputPreparationInput)))
      .toBeInstanceOf(InputPreparationRetirementConfirmationRequiredError);
    expect(await failure(retireInputPreparation({ productId: PRODUCT, storeDir }, { mode: 'delete' } as unknown as RetireInputPreparationInput)))
      .toBeInstanceOf(TypeError);
    expect(await treeHash(storeDir)).toEqual(before);
  });

  it.each([
    ['a mixed log holding a current-version row', [record('r1'), record('r2', { version: INPUT_PREPARATION_RECORD_VERSION })], 'current_version_present'],
    ['an unknown future version', [record('r1', { version: 99 })], 'unsupported_version'],
    ['a row with no version', [record('r1', { version: undefined })], 'unsupported_version'],
    ['an unparseable line', [record('r1'), '{not json'], 'unparseable_line'],
    ['a live pin', [record('r1', { pin: { taskId: 't', manifestDigest: 'm' } })], 'pinned_record'],
  ])('execute refuses %s and writes nothing', async (_label, lines, reason) => {
    const { storeDir } = await seed(lines);
    const before = await treeHash(storeDir);
    const error = await failure(retireInputPreparation({ productId: PRODUCT, storeDir }, EXECUTE));
    expect(error).toBeInstanceOf(InputPreparationRetirementRefusedError);
    expect((error as InputPreparationRetirementRefusedError).reason).toBe(reason);
    expect(await treeHash(storeDir)).toEqual(before);
  });

  it('execute refuses a symlinked namespace in both preview and execute', async () => {
    const { storeDir, namespace } = await seed([record('r1')]);
    const elsewhere = path.join(path.dirname(storeDir), 'elsewhere');
    await fs.rename(namespace, elsewhere);
    await fs.symlink(elsewhere, namespace);
    const before = await treeHash(path.dirname(storeDir));
    for (const input of [{ mode: 'preview' } as const, EXECUTE]) {
      const error = await failure(retireInputPreparation({ productId: PRODUCT, storeDir }, input));
      expect((error as InputPreparationRetirementRefusedError).reason).toBe('symlink');
    }
    expect(await treeHash(path.dirname(storeDir))).toEqual(before);
  });

  it('execute refuses while another process holds the store owner lease', async () => {
    const { storeDir, namespace } = await seed([record('r1')]);
    const before = await treeHash(namespace);
    const lease = await acquireDaemonOwner(storeDir, 'daemon');
    try {
      expect(await failure(retireInputPreparation({ productId: PRODUCT, storeDir }, EXECUTE)))
        .toBeInstanceOf(InputPreparationRetirementStoreBusyError);
    } finally {
      await lease.release();
    }
    expect(await treeHash(namespace)).toEqual(before);
  });

  it('execute refuses while the daemon control socket answers, before taking the lease', async () => {
    const { storeDir } = await seed([record('r1')]);
    const before = await treeHash(storeDir);
    const close = vi.fn();
    const client: ControlClient = { request: vi.fn() as never, subscribe: () => ({ close: vi.fn() }), close };
    const connectControl = vi.fn(async (): Promise<ConnectControlResult> => ({ ok: true, client }));
    const error = await failure(runInputPreparationRetirement({ productId: PRODUCT, storeDir }, EXECUTE, { connectControl }));
    expect(error).toBeInstanceOf(InputPreparationRetirementDaemonRunningError);
    expect(connectControl).toHaveBeenCalledWith({ storeDir, productId: PRODUCT });
    expect(close).toHaveBeenCalled();
    expect(await treeHash(storeDir)).toEqual(before);
  });
});
