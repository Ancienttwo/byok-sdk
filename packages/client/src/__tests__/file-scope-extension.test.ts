import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPiFileScopeExtension } from '../adapters/pi/file-scope-extension';
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
  const home = await tmpDir('byok-ext-home-');
  return {
    home,
    grant: await resolveFileScopeGrant({ fileScope: { mode: 'home' }, home: { path: home, identity: await identityOf(home) } }),
  };
}

describe('Pi file-scope extension (#1061 slice 3)', () => {
  it('registers the scoped tools and blocks an out-of-scope call before approval', async () => {
    const { home, grant } = await grantFixture();
    const outside = await tmpDir('byok-ext-outside-');
    const outsideFile = path.join(outside, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    const inScope = path.join(home, 'ok.txt');
    await fs.writeFile(inScope, 'ok');
    const denials: ScopedFileDenial[] = [];
    const tools: string[] = [];
    const handlers: ((event: unknown, context: { cwd: string }) => Promise<unknown>)[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => { tools.push(tool.name); },
      on: (_event: string, handler: (event: unknown, context: { cwd: string }) => Promise<unknown>) => { handlers.push(handler); },
    };
    const factory = createPiFileScopeExtension({
      grant,
      gate: { url: 'http://127.0.0.1:9/file-scope-audit', token: 'a'.repeat(64), timeoutMs: 100 },
      onTransportFailure: (denial) => { denials.push(denial); },
    });
    factory(pi as never);
    expect(tools).toEqual(['read', 'write', 'edit']);
    expect(handlers).toHaveLength(1);

    const blocked = await handlers[0]!({
      toolName: 'read', toolCallId: 'call-out', input: { path: outsideFile },
    }, { cwd: home });
    expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_denied') });
    expect(blocked).toMatchObject({ reason: expect.stringContaining('outside_scope') });
    expect(denials).toEqual([expect.objectContaining({ toolName: 'read', toolCallId: 'call-out', reason: 'outside_scope' })]);

    expect(await handlers[0]!({ toolName: 'read', toolCallId: 'call-in', input: { path: inScope } }, { cwd: home })).toBeUndefined();
    expect(denials).toHaveLength(1);
    // Non-file tools are never inspected by this extension.
    expect(await handlers[0]!({ toolName: 'bash', toolCallId: 'call-bash', input: { command: 'cat ' + outsideFile } }, { cwd: home })).toBeUndefined();
  });
});
