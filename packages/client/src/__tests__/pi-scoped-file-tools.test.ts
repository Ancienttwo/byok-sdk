import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createPiFileScopeExtension } from '../adapters/pi/file-scope-extension';
import { assertPiFileScopeRegistry } from '../adapters/pi/file-scope-registry';
import { resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity } from '../file-scope-guard';
import type { ScopedFileDenial } from '../file-scope-tools';

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

async function grantFixture(): Promise<{ home: string; grant: FileScopeGrant }> {
  const home = await tmpDir('byok-real-home-');
  return {
    home,
    grant: await resolveFileScopeGrant({ fileScope: { mode: 'home' }, home: { path: home, identity: await identityOf(home) } }),
  };
}

describe('scoped tools in a real Pi 1.4.0 session (#1061 slice 3)', () => {
  it('shadows all six native file tools and guards execution', async () => {
    const { home, grant } = await grantFixture();
    const agentDir = await tmpDir('byok-real-agent-');
    const outside = await tmpDir('byok-real-outside-');
    const outsideFile = path.join(outside, 'secret.txt');
    await fs.writeFile(outsideFile, 'outside');
    const inScope = path.join(home, 'notes.txt');
    const denials: ScopedFileDenial[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: home, agentDir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{
        name: 'byok-file-scope',
        factory: createPiFileScopeExtension({
          grant,
          gate: { url: 'http://127.0.0.1:9/file-scope-audit', token: 'a'.repeat(64), timeoutMs: 100 },
          onTransportFailure: (denial) => { denials.push(denial); },
        }),
      }] as never,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: home, agentDir, resourceLoader,
      settingsManager: SettingsManager.inMemory({}),
      sessionManager: SessionManager.inMemory(home),
    });
    try {
      assertPiFileScopeRegistry(session, { required: ['read', 'write', 'edit', 'find', 'grep', 'ls'], forbidden: [] });
      const tools = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
      for (const name of ['read', 'write', 'edit', 'find', 'grep', 'ls']) {
        expect(tools.get(name)?.sourceInfo?.path, name).not.toBe('builtin:' + name);
      }

      const read = session.getToolDefinition('read')!;
      const write = session.getToolDefinition('write')!;
      const edit = session.getToolDefinition('edit')!;
      const find = session.getToolDefinition('find')!;
      const grep = session.getToolDefinition('grep')!;
      const list = session.getToolDefinition('ls')!;
      type Exec = (id: string, p: unknown, s: undefined, u: undefined, c: never) => Promise<{ content: { text: string }[] }>;
      const run = (tool: { execute: unknown }): Exec => tool.execute as never as Exec;
      const ctx = { cwd: home } as never;
      await (write.execute as never as (id: string, p: unknown, s: undefined, u: undefined, c: never) => Promise<unknown>)(
        'write-1', { path: inScope, content: 'alpha\nbeta\n' }, undefined, undefined, ctx,
      );
      expect(await fs.readFile(inScope, 'utf8')).toBe('alpha\nbeta\n');
      const readResult = await (read.execute as never as (id: string, p: unknown, s: undefined, u: undefined, c: never) => Promise<{ content: { text: string }[] }>)(
        'read-1', { path: inScope }, undefined, undefined, ctx,
      );
      expect(readResult.content.map((part) => part.text).join('')).toBe('alpha\nbeta\n');
      await (edit.execute as never as (id: string, p: unknown, s: undefined, u: undefined, c: never) => Promise<unknown>)(
        'edit-1', { path: inScope, edits: [{ oldText: 'beta', newText: 'gamma' }] }, undefined, undefined, ctx,
      );
      expect(await fs.readFile(inScope, 'utf8')).toBe('alpha\ngamma\n');

      expect((await run(find)('find-1', { pattern: '*.txt', path: home }, undefined, undefined, ctx)).content.map((part) => part.text).join(''))
        .toBe('notes.txt');
      expect((await run(list)('ls-1', { path: home }, undefined, undefined, ctx)).content.map((part) => part.text).join(''))
        .toBe('notes.txt');
      expect((await run(grep)('grep-1', { pattern: 'gamma', path: home }, undefined, undefined, ctx)).content.map((part) => part.text).join(''))
        .toBe('notes.txt:2: gamma');

      await expect((read.execute as never as (id: string, p: unknown, s: undefined, u: undefined, c: never) => Promise<unknown>)(
        'read-outside', { path: outsideFile }, undefined, undefined, ctx,
      )).rejects.toThrow(/file_scope_denied: path is outside the authorized file scope \(outside_scope\)/);
      await expect(run(find)('find-outside', { pattern: '*', path: outside }, undefined, undefined, ctx))
        .rejects.toThrow(/file_scope_denied: path is outside the authorized file scope \(outside_scope\)/);
      expect(denials).toEqual([
        expect.objectContaining({ toolName: 'read', toolCallId: 'read-outside', reason: 'outside_scope' }),
        expect.objectContaining({ toolName: 'find', toolCallId: 'find-outside', reason: 'outside_scope' }),
      ]);
    } finally {
      session.dispose();
    }
  }, 30_000);
});
