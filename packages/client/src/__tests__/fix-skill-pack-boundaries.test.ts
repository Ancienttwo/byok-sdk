import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contentHash,
  parseSkillPackManifest,
  skillPackContentHashInput,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  type CapabilityDeclaration,
} from '@byok-sdk/core';
import type { AuthManager } from '../daemon/auth-manager';
import { authedFetch } from '../daemon/http-client';
import {
  installSkillPacks,
  listInstalledSkillPacks,
  projectSkillPack,
  SKILL_PACK_AUDIT_FILENAME,
  SKILL_PACK_LOCK_FILENAME,
  skillPacksRoot,
} from '../daemon/skill-pack-installer';

vi.mock('../daemon/http-client', () => ({ authedFetch: vi.fn() }));

const name = 'boundary-fixture';
const contents = new Map([
  ['SKILL.md', `---\nname: ${name}\ndescription: A local boundary fixture.\n---\nFixture.\n`],
  ['references/ledger.md', '# Ledger\n'],
]);
const sha256 = (value: string) => contentHash(`sha256:${createHash('sha256').update(value).digest('hex')}`);
const addressed = {
  name,
  version: '1.0.0',
  description: 'A local boundary fixture.',
  files: [...contents].map(([filePath, content]) => ({
    path: filePath, byteSize: Buffer.byteLength(content), contentHash: sha256(content),
  })),
};
const manifest = parseSkillPackManifest({
  schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
  ...addressed,
  contentHash: sha256(skillPackContentHashInput(addressed)),
});
const declaration: CapabilityDeclaration = { schema: 'byok-capabilities-v1', version: 1, capabilities: ['skills.pack'] };
let temporary: string;
let dataDir: string;
let target: string;
let outside: string;
const revision = () => path.join(skillPacksRoot(dataDir), name, manifest.contentHash.slice('sha256:'.length));
const install = () => installSkillPacks({ dataDir, serverUrl: 'https://fixture.invalid', auth: {} as AuthManager, declaration });
const project = () => projectSkillPack(dataDir, name, target);
const unsafe = expect.objectContaining({ name: 'SkillPackInstallError', code: 'store_unsafe' });

async function audit(): Promise<string> {
  return fs.readFile(path.join(skillPacksRoot(dataDir), SKILL_PACK_AUDIT_FILENAME), 'utf8');
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-boundary-'));
  dataDir = path.join(temporary, 'data');
  target = path.join(temporary, 'target');
  outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  vi.mocked(authedFetch).mockImplementation(async (url) => {
    const requested = decodeURIComponent(new URL(String(url)).pathname);
    const file = [...contents].find(([relative]) => requested.endsWith(`/${relative}`));
    return Response.json(file ? { content: file[1] } : { packs: [manifest] });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('14-1 skill-pack filesystem boundaries', () => {
  it('installs, lists, projects nested files, and preserves unchanged installation', async () => {
    expect((await install()).installed).toHaveLength(1);
    expect(await listInstalledSkillPacks(dataDir)).toHaveLength(1);
    expect((await project()).files).toEqual([...contents.keys()]);
    for (const [relative, content] of contents) {
      expect(await fs.readFile(path.join(target, relative), 'utf8')).toBe(content);
    }
    expect(await install()).toEqual({ installed: [], unchanged: [name] });
  });

  it.each([199, 200, 201])('applies the public path limit to the %i-character pack path, not its store prefix', async (length) => {
    const relative = `references/${'a'.repeat(length - 'references/'.length - '.md'.length)}.md`;
    const files = new Map([...contents, [relative, 'Long-path content.\n']]);
    const rows = [...files].map(([filePath, content]) => ({
      path: filePath, byteSize: Buffer.byteLength(content), contentHash: sha256(content),
    }));
    const extended = { ...addressed, files: rows };
    const published = {
      schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
      ...extended,
      contentHash: sha256(skillPackContentHashInput(extended)),
    };
    vi.mocked(authedFetch).mockImplementation(async (url) => {
      const requested = decodeURIComponent(new URL(String(url)).pathname);
      const file = [...files].find(([filePath]) => requested.endsWith(`/${filePath}`));
      return Response.json(file ? { content: file[1] } : { packs: [published] });
    });
    expect(relative).toHaveLength(length);
    if (length > 200) {
      await expect(install()).rejects.toThrowError(expect.objectContaining({ code: 'manifest_invalid' }));
      await expect(fs.lstat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    const installed = await install();
    expect(installed.installed).toHaveLength(1);
    expect(await fs.readFile(path.join(installed.installed[0]!.directory, relative), 'utf8')).toBe(files.get(relative));
    expect((await project()).files).toContain(relative);
    expect(await fs.readFile(path.join(target, relative), 'utf8')).toBe(files.get(relative));
    expect(await listInstalledSkillPacks(dataDir)).toHaveLength(1);
    expect(await install()).toEqual({ installed: [], unchanged: [name] });
  });

  it('still refuses an over-limit public path in a modified local lock', async () => {
    await install();
    const lockPath = path.join(skillPacksRoot(dataDir), name, SKILL_PACK_LOCK_FILENAME);
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    lock.files[0].path = 'a'.repeat(201);
    await fs.writeFile(lockPath, JSON.stringify(lock));
    await expect(project()).rejects.toThrowError(unsafe);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([true, false])('refuses a destination parent link with existing outside leaf=%s', async (existing) => {
    await install();
    await fs.mkdir(target);
    await fs.symlink(outside, path.join(target, 'references'), 'dir');
    const sentinel = path.join(outside, 'ledger.md');
    if (existing) await fs.writeFile(sentinel, 'outside sentinel');
    const before = await audit();
    await expect(project()).rejects.toThrowError(unsafe);
    if (existing) expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
    else await expect(fs.lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await audit()).toBe(before);
    await expect(fs.lstat(path.join(target, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a source intermediate link even when the outside bytes match the lock', async () => {
    await install();
    await fs.rename(path.join(revision(), 'references'), path.join(outside, 'references'));
    await fs.symlink(path.join(outside, 'references'), path.join(revision(), 'references'), 'dir');
    const before = await audit();
    await expect(project()).rejects.toThrowError(unsafe);
    expect(await audit()).toBe(before);
    await expect(fs.lstat(path.join(target, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked projection root', async () => {
    await install();
    await fs.symlink(outside, target, 'dir');
    await expect(project()).rejects.toThrowError(unsafe);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(['store', 'pack', 'revision', 'nested'])('refuses an install through a %s directory link', async (component) => {
    const link = component === 'store' ? skillPacksRoot(dataDir)
      : component === 'pack' ? path.join(skillPacksRoot(dataDir), name)
      : component === 'revision' ? revision() : path.join(revision(), 'references');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(outside, link, 'dir');
    await fs.writeFile(path.join(outside, 'ledger.md'), 'outside sentinel');
    await expect(install()).rejects.toThrowError(unsafe);
    expect(await fs.readdir(outside)).toEqual(['ledger.md']);
    expect(await fs.readFile(path.join(outside, 'ledger.md'), 'utf8')).toBe('outside sentinel');
    await expect(fs.lstat(path.join(skillPacksRoot(dataDir), name, SKILL_PACK_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });


  it.each(['revision', 'store'])('refuses a linked %s when projecting an installed pack', async (component) => {
    await install();
    const original = component === 'revision' ? revision() : skillPacksRoot(dataDir);
    const moved = path.join(outside, 'moved');
    await fs.rename(original, moved);
    await fs.symlink(moved, original, 'dir');
    await expect(project()).rejects.toThrowError(unsafe);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked lock instead of reading it outside the store', async () => {
    await install();
    const lock = path.join(skillPacksRoot(dataDir), name, SKILL_PACK_LOCK_FILENAME);
    const moved = path.join(outside, 'lock.json');
    await fs.rename(lock, moved);
    await fs.symlink(moved, lock);
    await expect(project()).rejects.toThrowError(unsafe);
    await expect(listInstalledSkillPacks(dataDir)).rejects.toThrowError(unsafe);
  });

  it('refuses a symlinked audit file without appending outside the store', async () => {
    await install();
    const auditPath = path.join(skillPacksRoot(dataDir), SKILL_PACK_AUDIT_FILENAME);
    const moved = path.join(outside, 'audit.jsonl');
    await fs.rename(auditPath, moved);
    const before = await fs.readFile(moved, 'utf8');
    await fs.symlink(moved, auditPath);
    await expect(project()).rejects.toThrowError(unsafe);
    expect(await fs.readFile(moved, 'utf8')).toBe(before);
  });

  it('allows platform aliases above a real host-selected root', async () => {
    await install();
    const alias = path.join(temporary, 'parent-alias');
    await fs.symlink(outside, alias, 'dir');
    target = path.join(alias, 'real-root', 'new-target');
    expect((await project()).files).toEqual([...contents.keys()]);
    expect(await fs.readFile(path.join(outside, 'real-root', 'new-target', 'references/ledger.md'), 'utf8')).toBe(contents.get('references/ledger.md'));
  });

  it('refuses a non-directory destination ancestor with a typed error', async () => {
    await install();
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'references'), 'ordinary file');
    await expect(project()).rejects.toThrowError(unsafe);
  });
});
