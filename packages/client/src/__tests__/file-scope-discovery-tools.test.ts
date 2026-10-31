import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  nodeFileScopeIo, resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity, type FileScopeIo,
} from '../file-scope-guard';
import { createScopedFileTools, type ScopedFileDenial } from '../file-scope-tools';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function identityOf(filePath: string): Promise<FileScopeIdentity> {
  const value = await fs.stat(filePath, { bigint: true });
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

interface Fixture {
  readonly home: string;
  readonly root: string;
  readonly outside: string;
  readonly grant: FileScopeGrant;
}

async function fixture(access: 'read' | 'write' = 'write'): Promise<Fixture> {
  const home = await tmpDir('byok-discovery-home-');
  const root = await tmpDir('byok-discovery-root-');
  const outside = await tmpDir('byok-discovery-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  await fs.mkdir(path.join(root, 'dir'));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\ngamma\n');
  await fs.writeFile(path.join(root, 'notes.md'), 'alpha notes\nBETA\n');
  await fs.writeFile(path.join(root, 'dir', 'b.txt'), 'nested beta\n');
  await fs.writeFile(path.join(root, 'dir', 'skip.md'), 'nested markdown\n');
  await fs.mkdir(path.join(root, '.byok'));
  await fs.writeFile(path.join(root, '.byok', 'agent-home.lease'), 'internal');
  await fs.symlink(outside, path.join(root, 'link'), 'dir');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'), 'file');
  const grant = await resolveFileScopeGrant({
    fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: root, access }] },
    home: { path: home, identity: await identityOf(home) },
  });
  return { home, root, outside, grant };
}

type Run = (id: string, params: unknown, cwd: string) => Promise<{ content: { type: string; text: string }[] }>;

function toolByName(tools: readonly ToolDefinition[], name: string): Run {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error('missing tool ' + name);
  const execute = tool.execute as unknown as (
    id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[] }>;
  return (id, params, cwd) => execute.call(tool, id, params, undefined, undefined, { cwd });
}

async function textOf(run: Promise<{ content: { type: string; text: string }[] }>): Promise<string> {
  return (await run).content.map((part) => part.text).join('');
}

async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the scoped tool to refuse');
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

describe('scoped find/grep/ls tools (#1061 slice 5)', () => {
  it('finds, lists and greps text inside the configured roots', async () => {
    const { root, grant } = await fixture();
    const tools = createScopedFileTools({ grant });

    const found = lines(await textOf(toolByName(tools, 'find')('find-1', { pattern: '*.txt', path: root }, root)));
    expect(found.sort()).toEqual(['a.txt', 'dir/b.txt']);

    const nested = lines(await textOf(toolByName(tools, 'find')('find-2', { pattern: 'dir/*.md', path: root }, root)));
    expect(nested).toEqual(['dir/skip.md']);

    const listed = lines(await textOf(toolByName(tools, 'ls')('ls-1', { path: root }, root)));
    expect(listed).toEqual(['a.txt', 'dir/', 'notes.md']);

    const grepped = lines(await textOf(toolByName(tools, 'grep')('grep-1', { pattern: 'beta', path: root }, root)));
    expect(grepped.sort()).toEqual(['a.txt:2: beta', 'dir/b.txt:1: nested beta']);

    const globbed = lines(await textOf(toolByName(tools, 'grep')('grep-2', { pattern: 'beta', path: root, glob: '*.md', ignoreCase: true }, root)));
    expect(globbed).toEqual(['notes.md:2: BETA']);

    const context = await textOf(toolByName(tools, 'grep')('grep-3', { pattern: 'beta', path: path.join(root, 'a.txt'), context: 1 }, root));
    expect(context).toBe('a.txt-1- alpha\na.txt:2: beta\na.txt-3- gamma');
  });

  it('never follows a symlink entry or reads the outside target', async () => {
    const { root, outside, grant } = await fixture();
    const tools = createScopedFileTools({ grant });
    const found = lines(await textOf(toolByName(tools, 'find')('find-sym', { pattern: '*', path: root }, root)));
    expect(found).not.toContain('link/secret.txt');
    expect(found).not.toContain('file-link.txt');
    const grepped = await textOf(toolByName(tools, 'grep')('grep-sym', { pattern: 'outside secret', path: root }, root));
    expect(grepped).toBe('No matches found');
    const listed = lines(await textOf(toolByName(tools, 'ls')('ls-sym', { path: root }, root)));
    expect(listed).not.toContain('link/');
    expect(listed).not.toContain('file-link.txt');
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret');
  });

  it('refuses an outside root, a mid-path symlink and .byok with a closed denial reason', async () => {
    const { root, outside, grant } = await fixture();
    const denials: ScopedFileDenial[] = [];
    const tools = createScopedFileTools({ grant, onDenial: (denial) => { denials.push(denial); } });
    const find = toolByName(tools, 'find');
    const list = toolByName(tools, 'ls');
    const grep = toolByName(tools, 'grep');

    for (const [name, run] of [
      ['find', find('find-out', { pattern: '*', path: outside }, root)],
      ['ls', list('ls-out', { path: outside }, root)],
      ['grep', grep('grep-out', { pattern: 'secret', path: path.join(outside, 'secret.txt') }, root)],
    ] as const) {
      const message = await failureOf(run);
      expect(message, name).toContain('file_scope_denied');
      expect(message, name).toContain('outside_scope');
    }
    expect(denials.map((denial) => denial.toolName).sort()).toEqual(['find', 'grep', 'ls']);
    expect(denials.every((denial) => denial.reason === 'outside_scope' && denial.code === 'file_scope_denied')).toBe(true);

    expect(await failureOf(find('find-link', { pattern: '*', path: path.join(root, 'link') }, root))).toContain('symlink');
    expect(await failureOf(grep('grep-link', { pattern: 'secret', path: path.join(root, 'link', 'secret.txt') }, root))).toContain('symlink');
    expect(await failureOf(find('find-byok', { pattern: '*', path: path.join(root, '.byok') }, root))).toContain('internal_path');
    expect(await failureOf(list('ls-byok', { path: path.join(root, '.byok') }, root))).toContain('internal_path');
    expect(await failureOf(grep('grep-byok', { pattern: 'internal', path: path.join(root, '.byok') }, root))).toContain('internal_path');
  });

  it('refuses a hard-linked file for content search', async () => {
    const { root, grant } = await fixture();
    const original = path.join(root, 'hard.txt');
    const alias = path.join(root, 'hard-alias.txt');
    await fs.writeFile(original, 'needle\n');
    await fs.link(original, alias);
    const tools = createScopedFileTools({ grant });
    const message = await failureOf(toolByName(tools, 'grep')('grep-hard', { pattern: 'needle', path: alias }, root));
    expect(message).toContain('hardlink');
    expect(await fs.readFile(original, 'utf8')).toBe('needle\n');
  });

  it('refuses a cross-device file through the injectable IO seam', async () => {
    const { root, grant } = await fixture();
    const file = path.join(root, 'a.txt');
    const io: FileScopeIo = {
      ...nodeFileScopeIo,
      lstat: async (candidate: string) => {
        const value = await nodeFileScopeIo.lstat(candidate);
        return candidate === file ? { ...value, dev: value.dev + 1n } : value;
      },
    };
    const tools = createScopedFileTools({ grant, io });
    const message = await failureOf(toolByName(tools, 'grep')('grep-cross', { pattern: 'alpha', path: file }, root));
    expect(message).toContain('cross_device');
  });

  it('reads a read-only root and still refuses its writes', async () => {
    const { root, grant } = await fixture('read');
    const tools = createScopedFileTools({ grant });
    expect(lines(await textOf(toolByName(tools, 'find')('find-ro', { pattern: '*.txt', path: root }, root)))).toContain('a.txt');
    expect(lines(await textOf(toolByName(tools, 'ls')('ls-ro', { path: root }, root)))).toContain('notes.md');
    expect(lines(await textOf(toolByName(tools, 'grep')('grep-ro', { pattern: 'alpha', path: root }, root)))).toContain('a.txt:1: alpha');
    expect(await failureOf(toolByName(tools, 'write')('write-ro', { path: path.join(root, 'new.txt'), content: 'x' }, root)))
      .toContain('read_only');
  });

  it('refuses a cwd outside every root and expands ~ outside the scope', async () => {
    const { root, grant } = await fixture();
    const outsideCwd = await tmpDir('byok-discovery-cwd-');
    const osHome = await tmpDir('byok-discovery-oshome-');
    const tools = createScopedFileTools({ grant, osHome });
    for (const run of [
      toolByName(tools, 'find')('find-cwd', { pattern: '*' }, outsideCwd),
      toolByName(tools, 'ls')('ls-cwd', {}, outsideCwd),
      toolByName(tools, 'grep')('grep-cwd', { pattern: 'x' }, outsideCwd),
    ]) {
      expect(await failureOf(run)).toContain('cwd_outside_scope');
    }
    await fs.mkdir(path.join(osHome, 'home-dir'));
    expect(await failureOf(toolByName(tools, 'find')('find-tilde', { pattern: '*', path: '~/home-dir' }, root)))
      .toContain('outside_scope');
    expect(await failureOf(toolByName(tools, 'grep')('grep-tilde', { pattern: 'x', path: '~/secret.txt' }, root)))
      .toContain('outside_scope');
  });

  it('fails closed on Windows before touching a path', async () => {
    const { root, grant } = await fixture();
    const tools = createScopedFileTools({ grant, platform: 'win32' });
    for (const run of [
      toolByName(tools, 'find')('find-win', { pattern: '*', path: root }, root),
      toolByName(tools, 'ls')('ls-win', { path: root }, root),
      toolByName(tools, 'grep')('grep-win', { pattern: 'alpha', path: root }, root),
    ]) {
      const message = await failureOf(run);
      expect(message).toContain('file_scope_unsupported');
      expect(message).toContain('unsupported_platform');
    }
  });

  it('skips binary files and applies the documented result limits', async () => {
    const { root, grant } = await fixture();
    await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    const tools = createScopedFileTools({ grant });
    const grepped = await textOf(toolByName(tools, 'grep')('grep-bin', { pattern: 'needle', path: root }, root));
    expect(grepped).toBe('No matches found');

    const limitedFind = await textOf(toolByName(tools, 'find')('find-limit', { pattern: '*.txt', path: root, limit: 1 }, root));
    expect(limitedFind).toContain('1 results limit reached');
    const limitedLs = await textOf(toolByName(tools, 'ls')('ls-limit', { path: root, limit: 1 }, root));
    expect(limitedLs).toContain('1 entries limit reached');
    const limitedGrep = await textOf(toolByName(tools, 'grep')('grep-limit', { pattern: 'a', path: root, limit: 1 }, root));
    expect(limitedGrep).toContain('1 matches limit reached');
  });
});
