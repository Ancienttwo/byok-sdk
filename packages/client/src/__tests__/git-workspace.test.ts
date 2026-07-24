import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitWorkspaceError,
  GitWorkspaceManager,
  LOCAL_GIT_WORKSPACE_GUIDANCE,
  type GitCommandResult,
  type GitRunner,
} from '../daemon/git-workspace';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-git-workspace-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function runnerFromGit(): GitRunner {
  return async (args, options) => {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => execFile('git', [...args], { cwd: options?.cwd, env: options?.env, shell: false }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    }));
  };
}

describe('GitWorkspaceManager', () => {
  it('validates the disabled/strict config shape', () => {
    expect(GitWorkspaceManager.validateConfig(undefined)).toBeUndefined();
    expect(GitWorkspaceManager.validateConfig({ mode: 'local-checkpoints' })).toEqual({ mode: 'local-checkpoints' });
    expect(() => GitWorkspaceManager.validateConfig({ mode: 'other' })).toThrow(GitWorkspaceError);
    expect(() => GitWorkspaceManager.validateConfig({ mode: 'local-checkpoints', extra: true })).toThrow(GitWorkspaceError);
  });

  it('preflights, initializes an exact temp repository, and observes real Git state without paths', async () => {
    const root = await tempDir();
    const manager = new GitWorkspaceManager(root, { run: runnerFromGit(), ownerId: 'test-owner' });
    await manager.preflight();
    const workspace = path.join(root, 'task-1');
    const baseline = await manager.prepareFresh(workspace);
    expect(baseline.workspaceDir).toBe(await fs.realpath(workspace));
    expect(baseline.head).toBeUndefined();
    await fs.writeFile(path.join(workspace, 'secret-name.txt'), 'x');
    const dirty = await manager.observe(workspace, baseline.head);
    expect(dirty.untracked).toBe(1);
    expect(JSON.stringify(dirty)).not.toContain('secret-name.txt');
    expect(JSON.stringify(dirty)).toContain('workspaceDir');
  });

  it('uses no shell and supplies bounded options and optional-lock env', async () => {
    const calls: Array<{ args: readonly string[]; options?: object }> = [];
    const run: GitRunner = async (args, options) => {
      calls.push({ args, options });
      const command = args[0];
      if (command === '--version') return { code: 0, stdout: 'git version 2', stderr: '' };
      if (command === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: options?.cwd ?? '', stderr: '' };
      if (command === 'rev-parse') return { code: 1, stdout: '', stderr: 'private path' };
      if (command === 'status') return { code: 0, stdout: ' M filename\0?? other\0', stderr: 'private stderr' };
      return { code: 0, stdout: '0', stderr: '' };
    };
    const root = await tempDir();
    const manager = new GitWorkspaceManager(root, { run, timeoutMs: 17, maxOutputBytes: 99, ownerId: 'opts' });
    await manager.preflight();
    await manager.observe(path.join(root, 'task'));
    expect(calls.every((call) => !('shell' in (call.options ?? {})))).toBe(true);
    expect(calls.some((call) => call.options && (call.options as { timeout?: number }).timeout === 17)).toBe(true);
    expect(calls.some((call) => (call.options as { env?: NodeJS.ProcessEnv }).env?.GIT_OPTIONAL_LOCKS === '0')).toBe(true);
    expect(calls.some((call) => call.args.some((arg) => /add|commit|push|fetch|reset|clean|config/.test(arg)))).toBe(false);
  });

  it('sanitizes Git routing/config environment case-insensitively and blocks templates', async () => {
    const root = await tempDir();
    const template = await tempDir();
    await fs.mkdir(path.join(template, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(template, 'hooks', 'pre-commit'), '#!/bin/sh\n');
    await fs.writeFile(path.join(template, 'template-marker'), 'hostile template\n');
    const hostile: Record<string, string> = {
      Git_Dir: path.join(template, 'dir'),
      Git_Config: path.join(template, 'config'),
      gIt_Config_Key_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: path.join(template, 'hooks'),
      Git_Template_Dir: template,
      GIT_OPTIONAL_LOCKS: '1',
    };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(hostile)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const git = runnerFromGit();
    const run: GitRunner = async (args, options) => {
      calls.push({ args, env: options?.env });
      return git(args, options);
    };
    try {
      const manager = new GitWorkspaceManager(root, { run, ownerId: 'env-filter' });
      await manager.preflight();
      const workspace = path.join(root, 'task');
      await manager.prepareFresh(workspace);
      for (const call of calls) {
        for (const key of Object.keys(hostile)) {
          if (key !== 'GIT_OPTIONAL_LOCKS') expect(call.env).not.toHaveProperty(key);
        }
        expect(call.env).not.toHaveProperty('GIT_DIR');
        expect(call.env).not.toHaveProperty('GIT_CONFIG');
        expect(call.env).not.toHaveProperty('GIT_CONFIG_KEY_1');
        expect(call.env).not.toHaveProperty('GIT_CONFIG_VALUE_1');
        expect(call.env).not.toHaveProperty('GIT_TEMPLATE_DIR');
      }
      expect(calls.find((call) => call.args[0] === '--version')?.env?.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(calls.find((call) => call.args[0] === 'init')?.env).not.toHaveProperty('GIT_OPTIONAL_LOCKS');
      expect(calls.some((call) => call.env?.PATH)).toBe(true);
      expect(await fs.stat(path.join(workspace, '.git'))).toBeDefined();
      await expect(fs.access(path.join(workspace, 'template-marker'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(workspace, '.git', 'hooks', 'pre-commit'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects traversal before creating a directory or invoking Git', async () => {
    const root = await tempDir();
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      return { code: 0, stdout: 'git version test', stderr: '' };
    };
    const manager = new GitWorkspaceManager(root, { run, ownerId: 'traversal' });
    await manager.preflight();
    calls.splice(0);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-escaped-task`);
    await expect(manager.prepareFresh(path.join(root, '..', path.basename(outside)))).rejects.toMatchObject({ category: 'workspace-root-invalid' });
    expect(calls).toHaveLength(0);
    await expect(fs.access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an intermediate symlink escape before creating a directory or invoking Git', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await fs.symlink(outside, path.join(root, 'escaped'));
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      return { code: 0, stdout: 'git version test', stderr: '' };
    };
    const manager = new GitWorkspaceManager(root, { run, ownerId: 'symlink-escape' });
    await manager.preflight();
    calls.splice(0);
    await expect(manager.prepareFresh(path.join(root, 'escaped', 'nested-task'))).rejects.toMatchObject({ category: 'workspace-root-invalid' });
    expect(calls).toHaveLength(0);
    await expect(fs.access(path.join(outside, 'nested-task'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects outside roots, conflicts, and busy leases; release is idempotent', async () => {
    const root = await tempDir();
    const manager = new GitWorkspaceManager(root, { run: runnerFromGit(), ownerId: 'one' });
    await manager.preflight();
    await expect(manager.prepareFresh(path.join(path.dirname(root), 'outside'))).rejects.toMatchObject({ category: 'workspace-root-invalid' });
    const second = new GitWorkspaceManager(root, { run: runnerFromGit(), ownerId: 'two' });
    await expect(second.preflight()).rejects.toMatchObject({ category: 'workspace-root-conflict' });
    const lease = await manager.acquireLease(path.join(root, 'task'), 'session');
    await expect(manager.acquireLease(path.join(root, 'task'), 'other')).rejects.toMatchObject({ category: 'lease-busy' });
    await expect(manager.acquireLease(path.join(root, 'other'), 'session')).rejects.toMatchObject({ category: 'lease-busy' });
    lease.release(); lease.release();
    await expect(manager.acquireLease(path.join(root, 'task'), 'session')).resolves.toBeDefined();
  });


  it('prepends fixed guidance exactly and never includes local identifiers', () => {
    const instruction = 'original instruction';
    const result = GitWorkspaceManager.prependGuidance(instruction);
    expect(result.endsWith(instruction)).toBe(true);
    expect(result).toContain(LOCAL_GIT_WORKSPACE_GUIDANCE);
    expect(result).not.toContain('task-');
  });
});
