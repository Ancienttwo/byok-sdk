import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLastAuditEvent } from '../bin/audit-log';
import { connectControlClient } from '../bin/control-client';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { TestServer } from './fixtures/test-server';

/**
 * Issue #392 acceptance, end to end against the built package: a process
 * launched the way launchd/systemd launch it — an `env -i`-style minimal
 * environment (HOME, PATH=/usr/bin:/bin) — where only the user's real passwd
 * login shell (zsh or bash, rc files read from the fixture HOME) puts the
 * fake `claude` on PATH.
 *
 * The daemon half runs in `fixtures/service-environment-child.mjs`, which
 * pairs in-process: the test suite's device-credential double is
 * process-local, so a separately spawned `byok-agent start` could never
 * read a credential paired by another process. The CLI half proves the
 * `--service` wiring of `dist/bin/byok-agent.js` itself.
 */
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/service-environment-child.mjs', import.meta.url));
const passwdShell = process.platform === 'win32' ? undefined : os.userInfo().shell ?? undefined;
const supportedShell = passwdShell !== undefined && ['zsh', 'bash'].includes(path.basename(passwdShell));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(serverUrl: string): Promise<{ home: string; storeDir: string; configPath: string }> {
  const home = await tmpDir('byok-lse-home-');
  const storeDir = await tmpDir('byok-lse-st-');
  const fakeBin = path.join(home, 'fakebin');
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  // A freshly written executable's first exec can stall for seconds on a
  // busy macOS host (provenance scan) — longer than the adapter's detect
  // timeout. Exec it once here so detection below measures PATH, not that.
  spawnSync(path.join(fakeBin, 'claude'), ['--version'], { timeout: 60_000 });
  // BYOK_CLAUDE_BIN from the rc would redirect claude resolution to a
  // nonexistent binary; claude being detected proves the rc value was dropped.
  const rc = `echo "rc noise on stdout"\necho "rc noise on stderr" >&2\nexport PATH="${fakeBin}:$PATH"\nexport BYOK_CLAUDE_BIN=/nonexistent/claude\n`;
  for (const file of ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']) await fs.writeFile(path.join(home, file), rc);
  const configPath = path.join(home, 'agent.json');
  await fs.writeFile(configPath, JSON.stringify({
    productName: 'Acme',
    productId: 'acme-login-shell',
    serverUrl,
    workspaceRoot: home,
    storeDir,
    runtimeAllowlist: ['claude'],
  }));
  return { home, storeDir, configPath };
}

function minimalEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // launchd also gives a user agent its per-user TMPDIR; keeping the suite's
  // short TMPDIR keeps socket paths short and avoids crawling a huge default one.
  return { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...extra };
}

interface ChildReport {
  ready: true;
  environment: { source: string; shell?: string };
  detected: string[];
  byokNames: string[];
  pathHasFakeBin: boolean;
}

async function runChild(home: string, configPath: string, service: boolean): Promise<{ report: ChildReport; child: ChildProcess }> {
  const child = spawn(process.execPath, [CHILD, configPath, ...(service ? ['--service'] : [])], {
    env: minimalEnv(home, { BYOK_TEST_DEVICE_CREDENTIAL_STORE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  await vi.waitFor(() => expect(stdout.includes('"ready":true'), stderr).toBe(true), { timeout: 30_000, interval: 100 });
  return { report: JSON.parse(stdout.split('\n').find((line) => line.includes('"ready":true'))!) as ChildReport, child };
}

/** The running child daemon's own control `status` — what `byok-agent status` shows online. */
async function controlStatus(storeDir: string): Promise<ControlStatusResult> {
  const conn = await connectControlClient({ storeDir, productId: 'acme-login-shell' });
  if (!conn.ok) throw new Error(`control socket not reachable: ${conn.reason}`);
  try {
    return await conn.client.request<ControlStatusResult>('status');
  } finally {
    conn.client.close();
  }
}

async function stop(child: ChildProcess): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  return exited;
}

describe.runIf(supportedShell)('service login-shell environment, end to end (issue #392)', () => {
  it('--service: login-shell environment, conn.hello lists claude, rc BYOK_* dropped, own BYOK_* kept', async () => {
    const server = await TestServer.start();
    cleanups.push(() => server.close());
    const { home, storeDir, configPath } = await fixture(server.url);
    const { report, child } = await runChild(home, configPath, true);

    expect(report.environment).toMatchObject({ source: 'login-shell', shell: path.basename(passwdShell!) });
    expect(report.pathHasFakeBin).toBe(true);
    expect(report.detected).toEqual(['claude']);
    expect(report.byokNames).toEqual(['BYOK_TEST_DEVICE_CREDENTIAL_STORE']);
    const hello = await server.waitFor((envelope) => envelope.type === 'conn.hello', 10_000);
    expect((hello.payload as { runtimes: Array<{ id: string }> }).runtimes.map((runtime) => runtime.id)).toEqual(['claude']);
    const status = await controlStatus(storeDir);
    expect(status.environment).toMatchObject({ source: 'login-shell', shell: path.basename(passwdShell!) });
    expect(status.runtimes).toEqual([expect.objectContaining({ id: 'claude', outcome: 'available' })]);
    expect(JSON.stringify(status)).not.toContain(home);
    expect(await stop(child)).toBe(0);
  }, 60_000);

  it('without --service: inherited, and claude stays not-found', async () => {
    const server = await TestServer.start();
    cleanups.push(() => server.close());
    const { home, storeDir, configPath } = await fixture(server.url);
    const { report, child } = await runChild(home, configPath, false);

    expect(report.environment).toEqual({ source: 'inherited' });
    expect(report.pathHasFakeBin).toBe(false);
    expect(report.detected).toEqual([]);
    const hello = await server.waitFor((envelope) => envelope.type === 'conn.hello', 10_000);
    expect((hello.payload as { runtimes: unknown[] }).runtimes).toEqual([]);
    const status = await controlStatus(storeDir);
    expect(status.environment).toEqual({ source: 'inherited' });
    expect(status.runtimes).toEqual([{ id: 'claude', outcome: 'not-found' }]);
    expect(await stop(child)).toBe(0);
  }, 60_000);

  it('dist byok-agent start --service applies the capture before anything else (service log line, no paths)', async () => {
    const { home, storeDir, configPath } = await fixture('http://127.0.0.1:9');
    // Unpaired, so start halts right after the capture; the CLI wiring is what is under test.
    const run = spawnSync(process.execPath, [path.resolve('dist/bin/byok-agent.js'), 'start', '--config', configPath, '--service'], {
      // The test credential store makes the unpaired halt reachable on hosts
      // without an OS credential provider (Linux CI), where start would
      // otherwise crash on the missing provider first (#394 tells the two apart).
      env: minimalEnv(home, { BYOK_TEST_DEVICE_CREDENTIAL_STORE: '1' }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.stdout.split('\n')[0]).toMatch(new RegExp(`^environment: login-shell shell=${path.basename(passwdShell!)} durationMs=\\d+$`, 'u'));
    expect(run.stdout).not.toContain(home);
    // #394: an unpaired device is a halt, and a halt under --service exits 0
    // so the supervisor leaves it stopped.
    expect(run.stderr).toContain('daemon halted: reason=unpaired');
    expect(run.status).toBe(0);
    // Only a daemon past the single-owner bind emits the environment-resolved event.
    expect(await readLastAuditEvent(storeDir, 'environment-resolved')).toBeUndefined();
  }, 60_000);
});
