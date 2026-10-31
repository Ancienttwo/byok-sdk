import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutoToolAuthorizationGate } from '../tool-authorization';
import { bindFileScopeGate } from '../file-scope-gate-binding';
import { resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity } from '../file-scope-guard';
import type { ScopedFileDenial } from '../file-scope-tools';
import { reportFileScopeDenial, startToolAuthorizationIpc } from '../tool-authorization-ipc';

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

async function grantFixture(): Promise<FileScopeGrant> {
  const home = await tmpDir('byok-audit-home-');
  return resolveFileScopeGrant({
    fileScope: { mode: 'home' }, home: { path: home, identity: await identityOf(home) },
  });
}

function gate() {
  return createAutoToolAuthorizationGate({
    workspace: os.tmpdir(), timeoutMs: 2_000,
    requestAuthorization: async () => ({ approved: false }),
  });
}

describe('scoped file-tool deny audit (#1061 slice 3, D12)', () => {
  it('records every denial over the per-task loopback channel and never an allow', async () => {
    const grant = await grantFixture();
    const denials: ScopedFileDenial[] = [];
    const authorization = gate();
    bindFileScopeGate(authorization, {
      grant, taskId: 'task-1', lane: 'rpc', homeAccess: 'writer',
      onDeny: (denial) => { denials.push(denial); },
    });
    const ipc = await startToolAuthorizationIpc(authorization);
    try {
      expect(ipc.fileScope).toBe(grant);
      expect(await reportFileScopeDenial(ipc.config, {
        toolCallId: 'call-1', toolName: 'read', code: 'file_scope_denied', reason: 'outside_scope', rootId: 'home', access: 'read',
      })).toBe(true);
      expect(denials).toEqual([{
        toolCallId: 'call-1', toolName: 'read', code: 'file_scope_denied', reason: 'outside_scope', rootId: 'home', access: 'read',
      }]);
      // A body outside the closed denied-call shape is rejected, not recorded.
      const bad = await fetch(new URL('/file-scope-audit', ipc.config.url), {
        method: 'POST', headers: { authorization: 'Bearer ' + ipc.config.token, 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'bash', code: 'file_scope_denied', reason: 'outside_scope' }),
      });
      expect(bad.status).toBe(400);
      expect(denials).toHaveLength(1);
    } finally {
      await ipc.close();
    }
  });

  it('reports no scope and refuses audit without a bound grant', async () => {
    const authorization = gate();
    const ipc = await startToolAuthorizationIpc(authorization);
    try {
      expect(ipc.fileScope).toBeUndefined();
      expect(await reportFileScopeDenial(ipc.config, {
        toolName: 'read', code: 'file_scope_denied', reason: 'outside_scope',
      })).toBe(false);
    } finally {
      await ipc.close();
    }
  });
});
