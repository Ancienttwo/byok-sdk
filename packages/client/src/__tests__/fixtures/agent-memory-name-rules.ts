import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

import {
  AgentMemoryRevisionConflictError,
  AgentMemoryService,
  captureAgentMemoryHomeSnapshot,
  captureAgentMemorySnapshot,
  cleanupAgentMemoryHomeForRestore,
  compareAndSwapAgentMemoryHomeFile,
  observeAgentMemoryHomeFile,
  recordAgentMemoryHomeEntries,
  type AgentMemoryTaskContext,
} from '../../daemon/agent-memory';

const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

/**
 * One home with a Windows device name, a case pair or alias, and hard links.
 * Recall and save refuse each of them with `refusal`, the snapshot leaves them
 * out, and the outside file does not change. The same steps run against the
 * native Linux backend and the Go helper.
 */
export async function expectAgentMemoryNameRules(context: AgentMemoryTaskContext, outside: string, refusal: { readonly caseAlias: string; readonly hardLink: string }): Promise<void> {
  const notes = path.join(context.canonicalHome, 'notes');
  // Win32 maps `con.md` to the console device; the `\\?\` form names the file.
  const deviceFile = path.toNamespacedPath(path.join(notes, 'con.md'));
  await fs.writeFile(deviceFile, 'device name', 'utf8');
  await fs.writeFile(path.join(notes, 'plain.md'), 'plain', 'utf8');
  await fs.writeFile(path.join(notes, 'Upper.md'), 'upper', 'utf8');
  const caseInsensitive = await fs.lstat(path.join(notes, 'UPPER.md')).then(() => true, () => false);
  if (!caseInsensitive) await fs.writeFile(path.join(notes, 'upper.md'), 'lower', 'utf8');
  const sentinel = path.join(outside, 'sentinel.md');
  await fs.writeFile(sentinel, 'outside sentinel', 'utf8');
  await fs.link(sentinel, path.join(notes, 'linked.md'));
  const service = new AgentMemoryService(context);

  await expect(service.recall({ path: 'notes/con.md' })).rejects.toThrow('notes/<safe-relative>.md');
  for (const alias of caseInsensitive ? ['notes/upper.md'] : ['notes/upper.md', 'notes/Upper.md']) {
    await expect(service.recall({ path: alias })).rejects.toThrow(refusal.caseAlias);
    await expect(service.save({ op: 'replace', path: alias, expectedRevision: sha256(caseInsensitive ? 'upper' : 'lower'), content: 'next' })).rejects.toThrow(refusal.caseAlias);
  }
  await expect(service.recall({ path: 'notes/linked.md' })).rejects.toThrow(refusal.hardLink);
  await expect(service.save({ op: 'replace', path: 'notes/linked.md', expectedRevision: sha256('outside sentinel'), content: 'next' })).rejects.toThrow(refusal.hardLink);
  await expect(service.save({ op: 'delete', path: 'notes/linked.md', expectedRevision: sha256('outside sentinel') })).rejects.toThrow(refusal.hardLink);
  if (caseInsensitive) expect((await service.recall({ path: 'notes/Upper.md' })).content).toBe('upper');

  const snapshot = await captureAgentMemorySnapshot(context);
  expect(snapshot.files.map((file) => file.path)).toEqual(caseInsensitive ? ['MEMORY.md', 'notes/Upper.md', 'notes/plain.md'] : ['MEMORY.md', 'notes/plain.md']);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
  expect((await fs.readdir(notes)).sort()).toEqual(caseInsensitive ? ['Upper.md', 'con.md', 'linked.md', 'plain.md'] : ['Upper.md', 'con.md', 'linked.md', 'plain.md', 'upper.md']);
  // A recursive cleanup could not name the device file on Windows.
  await fs.rm(deviceFile);
}

const present = (file: string | Buffer): Promise<boolean> => fs.lstat(file).then(() => true, () => false);

/**
 * A compare hashes raw bytes: a file the read path refuses can be replaced or
 * deleted with its revision, and with no other. The expected value is the
 * sha256 of the bytes, so the native backend and the Go helper agree on it. A
 * symlink, a FIFO and a hard link stay refused.
 */
export async function expectAgentMemoryRawByteCompare(context: AgentMemoryTaskContext, outside: string): Promise<void> {
  const notes = path.join(context.canonicalHome, 'notes');
  const file = path.join(notes, 'raw.md');
  const revisionOf = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  for (const bytes of [Buffer.alloc(300 * 1024, 'x'), Buffer.from([0xff, 0xfe, 0x00, 0x41])]) {
    for (const operation of ['replace', 'delete'] as const) {
      const swap = (expectedRevision: string) => compareAndSwapAgentMemoryHomeFile(context, { operation, path: 'notes/raw.md', expectedRevision, ...(operation === 'replace' ? { content: 'next' } : {}) });
      await fs.writeFile(file, bytes);
      expect(await observeAgentMemoryHomeFile(context, 'notes/raw.md')).toEqual({ exists: true, revision: revisionOf(bytes) });
      await expect(swap(sha256('stale'))).rejects.toBeInstanceOf(AgentMemoryRevisionConflictError);
      expect((await fs.readFile(file)).equals(bytes)).toBe(true);
      await swap(revisionOf(bytes));
    }
    expect(await present(file)).toBe(false);
  }
  expect(await observeAgentMemoryHomeFile(context, 'notes/absent/raw.md')).toEqual({ exists: false, revision: sha256('') });

  if (process.platform === 'win32') return;
  const sentinel = path.join(outside, 'compare-sentinel.md');
  await fs.writeFile(sentinel, 'outside sentinel', 'utf8');
  await fs.symlink(sentinel, path.join(notes, 'symlink.md'));
  await fs.link(sentinel, path.join(notes, 'hardlink.md'));
  execFileSync('mkfifo', [path.join(notes, 'fifo.md')]);
  for (const name of ['symlink.md', 'hardlink.md', 'fifo.md']) {
    const relative = `notes/${name}`;
    await expect(observeAgentMemoryHomeFile(context, relative)).rejects.toThrow();
    for (const operation of ['replace', 'delete'] as const) {
      await expect(compareAndSwapAgentMemoryHomeFile(context, { operation, path: relative, expectedRevision: sha256('outside sentinel'), ...(operation === 'replace' ? { content: 'next' } : {}) })).rejects.toThrow();
    }
    expect(await present(path.join(notes, name))).toBe(true);
    await fs.rm(path.join(notes, name));
  }
  expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
}

/**
 * One Attempt's changes against its start record, on both backends. The native
 * walk skips a FIFO, so one that was there at the start stays; the helper walk
 * refuses a FIFO, so only the native side can start with one.
 */
export async function expectAgentMemoryRestoreCleanup(context: AgentMemoryTaskContext, outside: string): Promise<void> {
  if (process.platform === 'win32') {
    await expect(cleanupAgentMemoryHomeForRestore(context, { files: ['MEMORY.md'], entries: [] })).rejects.toThrow('unsupported');
    return;
  }
  const home = context.canonicalHome;
  const notes = path.join(home, 'notes');
  const inNotes = (relative: string): string => path.join(notes, ...relative.split('/'));
  const sentinel = path.join(outside, 'cleanup-sentinel.md');
  await fs.writeFile(sentinel, 'outside sentinel', 'utf8');
  const native = context.filesystem === undefined;

  for (const directory of ['sub', 'many', 'retyped-directory', 'con']) await fs.mkdir(inNotes(directory));
  for (const [relative, content] of Object.entries({
    'kept.md': 'kept', 'sub/kept.md': 'kept below', 'case.md': 'kept', 'gained-link.md': 'one link at the start', 'retyped.md': 'a file at the start',
    'old.json': 'older than the Attempt', 'con/opaque.md': 'older than the Attempt',
  })) await fs.writeFile(inNotes(relative), content, 'utf8');
  await fs.link(sentinel, inNotes('linked.md'));
  await fs.writeFile(inNotes('pair.md'), 'a case pair', 'utf8');
  const foldsCase = await present(inNotes('PAIR.md'));
  if (!foldsCase) await fs.writeFile(inNotes('PAIR.md'), 'a case pair', 'utf8');
  if (native) execFileSync('mkfifo', [inNotes('old-pipe.md')]);
  if (process.platform === 'linux') await fs.writeFile(Buffer.concat([Buffer.from(`${notes}/`), Buffer.from([0xff])]), 'a name that is not UTF-8', 'utf8');
  const files = (await captureAgentMemoryHomeSnapshot(context)).files.map((file) => file.path);
  const entries = await recordAgentMemoryHomeEntries(context);
  expect(entries).toContainEqual({ path: 'notes/sub', kind: 'directory' });
  expect(entries).toContainEqual({ path: 'notes/linked.md', kind: 'file' });
  expect(entries).toContainEqual({ path: 'notes/old.json', kind: 'file' });

  for (const [relative, content] of Object.entries({ 'new.md': 'new', 'data.json': 'new', 'con/also-opaque.md': 'stays with its directory' })) await fs.writeFile(inNotes(relative), content, 'utf8');
  await fs.writeFile(inNotes('big.md'), Buffer.alloc(300 * 1024, 'x'));
  await fs.writeFile(inNotes('not-utf8.md'), Buffer.from([0xff, 0xfe]));
  await fs.mkdir(inNotes('tree/below'), { recursive: true });
  await fs.writeFile(inNotes('tree/below/a.txt'), 'goes with its directory', 'utf8');
  // Linux takes any bytes as a name, and a directory goes with such a file in it.
  if (process.platform === 'linux') await fs.writeFile(Buffer.concat([Buffer.from(`${inNotes('tree/below')}/`), Buffer.from([0xfe])]), 'not a UTF-8 name', 'utf8');
  for (let index = 0; index < 513; index += 1) await fs.writeFile(inNotes(`many/n${index}.md`), 'new', 'utf8');
  await fs.symlink(sentinel, inNotes('link.md'));
  await fs.symlink(outside, inNotes('sub/link'));
  execFileSync('mkfifo', [inNotes('new-pipe.md')]);
  await fs.link(inNotes('gained-link.md'), path.join(outside, 'second-link'));
  await fs.rm(inNotes('retyped.md'));
  await fs.mkdir(inNotes('retyped.md'));
  await fs.rmdir(inNotes('retyped-directory'));
  await fs.writeFile(inNotes('retyped-directory'), 'a directory at the start', 'utf8');
  if (!foldsCase) await fs.writeFile(inNotes('CASE.md'), 'a case variant the Attempt added', 'utf8');
  if (!foldsCase) await fs.mkdir(path.join(home, 'Notes'));
  if (!foldsCase) await fs.writeFile(path.join(home, 'memory.md'), 'older than the Attempt', 'utf8');

  await expect(cleanupAgentMemoryHomeForRestore(context, { files, entries })).resolves.toEqual({ deleted: 524 + (foldsCase ? 0 : 1) });

  for (const gone of ['new.md', 'data.json', 'big.md', 'not-utf8.md', 'tree', 'link.md', 'sub/link', 'new-pipe.md', 'gained-link.md', 'retyped.md', 'retyped-directory', ...(foldsCase ? [] : ['CASE.md'])]) expect(await present(inNotes(gone)), gone).toBe(false);
  expect(await fs.readdir(inNotes('many'))).toEqual([]);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
  expect(await fs.readFile(path.join(outside, 'second-link'), 'utf8')).toBe('one link at the start');
  expect(await fs.readFile(inNotes('kept.md'), 'utf8')).toBe('kept');
  expect(await fs.readFile(inNotes('sub/kept.md'), 'utf8')).toBe('kept below');
  expect(await fs.readFile(inNotes('old.json'), 'utf8')).toBe('older than the Attempt');
  for (const stays of ['linked.md', 'con/opaque.md', 'con/also-opaque.md', 'pair.md', ...(foldsCase ? [] : ['PAIR.md']), ...(native ? ['old-pipe.md'] : [])]) expect(await present(inNotes(stays)), stays).toBe(true);
  if (process.platform === 'linux') expect(await present(Buffer.concat([Buffer.from(`${notes}/`), Buffer.from([0xff])]))).toBe(true);
  expect(await present(path.join(home, 'MEMORY.md'))).toBe(true);
  if (!foldsCase) for (const stays of ['Notes', 'memory.md']) expect(await present(path.join(home, stays)), stays).toBe(true);

  const memory = path.join(home, 'MEMORY.md');
  await fs.rm(memory);
  await fs.symlink(sentinel, memory);
  const remaining = { files: ['MEMORY.md'], entries };
  await expect(cleanupAgentMemoryHomeForRestore(context, remaining)).resolves.toEqual({ deleted: 1 });
  expect(await present(memory)).toBe(false);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');

  await expect(cleanupAgentMemoryHomeForRestore(context, { files: ['notes/kept.md'], entries })).rejects.toThrow('restore record is invalid');
  await expect(cleanupAgentMemoryHomeForRestore(context, { files: ['MEMORY.md', 'notes/absent.md'], entries })).rejects.toThrow('restore record is invalid');
  await expect(cleanupAgentMemoryHomeForRestore(context, { files: ['MEMORY.md'], entries: [...entries, entries[0]!] })).rejects.toThrow('restore record is invalid');
  expect(await fs.readFile(inNotes('kept.md'), 'utf8')).toBe('kept');

  await fs.rm(notes, { recursive: true });
  await fs.writeFile(notes, 'a file where the directory goes', 'utf8');
  await expect(cleanupAgentMemoryHomeForRestore(context, { files: ['MEMORY.md'], entries: [] })).resolves.toEqual({ deleted: 1 });
  expect(await present(notes)).toBe(false);
}
