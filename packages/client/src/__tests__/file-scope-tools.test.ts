import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { nodeFileScopeIo, resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity, type FileScopeIo } from '../file-scope-guard';
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

async function fixture(access: 'read' | 'write' = 'write'): Promise<{ home: string; root: string; grant: FileScopeGrant }> {
  const home = await tmpDir('byok-tools-home-');
  const root = await tmpDir('byok-tools-root-');
  const grant = await resolveFileScopeGrant({
    fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: root, access }] },
    home: { path: home, identity: await identityOf(home) },
  });
  return { home, root, grant };
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

describe('scoped file tools (#1061 slice 3)', () => {
  it('writes, reads, edits and reports exact bytes for an authorized target', async () => {
    const { root, grant } = await fixture();
    const tools = createScopedFileTools({ grant });
    const write = toolByName(tools, 'write');
    const read = toolByName(tools, 'read');
    const edit = toolByName(tools, 'edit');
    const file = path.join(root, 'nested', 'notes.md');

    expect(await textOf(write('call-w', { path: file, content: 'alpha\nbeta\n' }, root))).toContain('Wrote 11 bytes');
    expect(await fs.readFile(file, 'utf8')).toBe('alpha\nbeta\n');
    expect(await textOf(read('call-r', { path: file }, root))).toBe('alpha\nbeta\n');
    expect(await textOf(edit('call-e', { path: file, edits: [{ oldText: 'beta', newText: 'gamma' }] }, root))).toContain('1 replacement');
    expect(await fs.readFile(file, 'utf8')).toBe('alpha\ngamma\n');
  });

  it('refuses an outside root without creating the target and audits the denial only', async () => {
    const { root, grant } = await fixture();
    const outside = await tmpDir('byok-tools-outside-');
    const target = path.join(outside, 'created.txt');
    const denials: ScopedFileDenial[] = [];
    const tools = createScopedFileTools({ grant, onDenial: (denial) => { denials.push(denial); } });
    const message = await failureOf(toolByName(tools, 'write')('call-out', { path: target, content: 'x' }, root));
    expect(message).toContain('file_scope_denied');
    expect(message).toContain('outside_scope');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(denials).toEqual([expect.objectContaining({ toolCallId: 'call-out', toolName: 'write', code: 'file_scope_denied', reason: 'outside_scope' })]);

    // A successful in-scope call never produces an audit record.
    await textOf(toolByName(tools, 'write')('call-in', { path: path.join(root, 'ok.txt'), content: 'ok' }, root));
    expect(denials).toHaveLength(1);
  });

  it('refuses a mid-path symlink and leaves the outside sentinel unchanged', async () => {
    const { root, grant } = await fixture();
    const outside = await tmpDir('byok-tools-symlink-');
    const sentinel = path.join(outside, 'secret.txt');
    await fs.writeFile(sentinel, 'unchanged');
    await fs.symlink(outside, path.join(root, 'link'), 'dir');
    const tools = createScopedFileTools({ grant });
    const message = await failureOf(toolByName(tools, 'read')('call-sym', { path: path.join(root, 'link', 'secret.txt') }, root));
    expect(message).toContain('symlink');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it('refuses a hard link for read and write', async () => {
    const { root, grant } = await fixture();
    const original = path.join(root, 'original.txt');
    const alias = path.join(root, 'alias.txt');
    await fs.writeFile(original, 'data');
    await fs.link(original, alias);
    const tools = createScopedFileTools({ grant });
    for (const [name, params] of [['read', { path: alias }], ['write', { path: alias, content: 'changed' }]] as const) {
      const message = await failureOf(toolByName(tools, name)(String(name), params, root));
      expect(message).toContain('hardlink');
    }
    expect(await fs.readFile(original, 'utf8')).toBe('data');
  });

  it('refuses a cross-device target through the injectable IO seam', async () => {
    const { root, grant } = await fixture();
    const file = path.join(root, 'cross.txt');
    await fs.writeFile(file, 'data');
    const io: FileScopeIo = {
      ...nodeFileScopeIo,
      lstat: async (candidate: string) => {
        const value = await nodeFileScopeIo.lstat(candidate);
        return candidate === file ? { ...value, dev: value.dev + 1n } : value;
      },
    };
    const tools = createScopedFileTools({ grant, io });
    const message = await failureOf(toolByName(tools, 'read')('call-cross', { path: file }, root));
    expect(message).toContain('cross_device');
  });

  it('refuses .byok internals, read-only writes, and a cwd outside every root', async () => {
    const { home, root, grant } = await fixture();
    const tools = createScopedFileTools({ grant });
    expect(await failureOf(toolByName(tools, 'read')('call-byok', { path: path.join(home, '.byok', 'agent-home.lease') }, root)))
      .toContain('internal_path');

    const readOnly = await fixture('read');
    const readOnlyTools = createScopedFileTools({ grant: readOnly.grant });
    const target = path.join(readOnly.root, 'nope.txt');
    expect(await failureOf(toolByName(readOnlyTools, 'write')('call-ro', { path: target, content: 'x' }, readOnly.root)))
      .toContain('read_only');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const outsideCwd = await tmpDir('byok-tools-cwd-');
    expect(await failureOf(toolByName(tools, 'read')('call-cwd', { path: 'relative.txt' }, outsideCwd)))
      .toContain('cwd_outside_scope');
  });

  it('expands ~ to the OS home and refuses it as outside the scope', async () => {
    const { root, grant } = await fixture();
    const osHome = await tmpDir('byok-tools-oshome-');
    const tools = createScopedFileTools({ grant, osHome });
    const message = await failureOf(toolByName(tools, 'read')('call-tilde', { path: '~/secret.txt' }, root));
    expect(message).toContain('outside_scope');
  });

  it('fails closed on Windows unsupported before touching a file', async () => {
    const { root, grant } = await fixture();
    const tools = createScopedFileTools({ grant, platform: 'win32' });
    const message = await failureOf(toolByName(tools, 'read')('call-win', { path: path.join(root, 'x.txt') }, root));
    expect(message).toContain('file_scope_unsupported');
    expect(message).toContain('unsupported_platform');
  });
});
