import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeRuntimeEnvironment } from '../runtime/environment';
import { captureAndApply } from '../lifecycle/service-environment';
import { captureLoginShellSnapshot, LOGIN_SHELL_SEED_PATH } from '../login-shell-environment';
import { testRuntimeEnv } from './fixtures/runtime-env';
import { resolveBunBin } from './support/test-bun-bin';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-svcenv-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * The injected login shell is `/bin/sh` itself (bash in POSIX mode on macOS,
 * dash on Debian/Ubuntu): run as `-i -l -c`, both read `$HOME/.profile`, so
 * the fixture rc lives there. Using the system shell — not a freshly written
 * executable — keeps first-exec security scanning out of the timings, and
 * keeps the test independent of the developer's own passwd shell and rc.
 */
const shell = '/bin/sh';

async function fixtureHome(rc: string): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = await tempDir();
  await fs.writeFile(path.join(home, '.profile'), rc);
  return { home, env: { HOME: home, PATH: '/usr/bin:/bin' } };
}

const posix = process.platform !== 'win32';

describe.runIf(posix)('lifecycle/service-environment (issue #392)', () => {
  it('rc adds the fake-claude dir to PATH: login-shell, and PATH contains it', async () => {
    const { home, env } = await fixtureHome('export PATH="$HOME/fake-claude-bin:$PATH"\nexport RC_MULTI="line one\nline two"\n');
    const status = await captureAndApply({ shell, env });
    expect(status).toMatchObject({ source: 'login-shell', shell: 'sh' });
    expect(env.PATH?.split(':')).toContain(path.join(home, 'fake-claude-bin'));
    expect(env.RC_MULTI).toBe('line one\nline two');
  });

  it('rc output on stdout and stderr is ignored: still login-shell', async () => {
    const { env } = await fixtureHome('echo "Welcome back!"\necho "nvm: using default" >&2\nexport RC_SET=1\n');
    expect(await captureAndApply({ shell, env })).toMatchObject({ source: 'login-shell' });
    expect(env.RC_SET).toBe('1');
  });

  it('sleep 30: unavailable:timeout, the shell process group is gone, and the environment is untouched', async () => {
    const { home, env } = await fixtureHome('echo $$ > "$HOME/shell.pid"\nsleep 30\n');
    const before = { ...env };
    const started = Date.now();
    expect(await captureAndApply({ shell, env, timeoutMs: 500 })).toEqual({ source: 'unavailable', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(env).toEqual(before);
    const pid = Number((await fs.readFile(path.join(home, 'shell.pid'), 'utf8')).trim());
    // The group leader and its `sleep` were SIGKILLed together.
    await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(), { timeout: 2_000 });
  });

  it('an rc background job holding stdout open does not delay a complete capture; the job is killed', async () => {
    // `sleep 30 &` inherits the stdout pipe, so EOF would not come for 30 s.
    const { home, env } = await fixtureHome('sleep 30 &\necho $! > "$HOME/bg.pid"\nexport RC_SET=1\n');
    const started = Date.now();
    expect(await captureAndApply({ shell, env, timeoutMs: 10_000 })).toMatchObject({ source: 'login-shell', shell: 'sh' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(env.RC_SET).toBe('1');
    const pid = Number((await fs.readFile(path.join(home, 'bg.pid'), 'utf8')).trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
  });

  it('2 MiB of output: unavailable:output-too-large', async () => {
    // A single 2 MiB *export* cannot reach the cap on macOS: exec of
    // /usr/bin/env fails with E2BIG first (ARG_MAX is 1 MiB for argv+env),
    // which is shell-exit-nonzero. 2 MiB of rc output on stdout exercises
    // the same byte cap deterministically on every POSIX host.
    const { env } = await fixtureHome(`head -c ${2 * 1024 * 1024} /dev/zero | tr '\\0' x\n`);
    expect(await captureAndApply({ shell, env })).toEqual({ source: 'unavailable', code: 'output-too-large' });
  });

  it('exit 3: unavailable:shell-exit-nonzero', async () => {
    const { env } = await fixtureHome('exit 3\n');
    expect(await captureAndApply({ shell, env })).toEqual({ source: 'unavailable', code: 'shell-exit-nonzero' });
  });

  it('a shell that cannot be spawned, a relative shell, and win32', async () => {
    const dir = await tempDir();
    expect(await captureAndApply({ shell: path.join(dir, 'missing'), env: {} })).toEqual({ source: 'unavailable', code: 'spawn-failed' });
    expect(await captureAndApply({ shell: 'zsh', env: {} })).toEqual({ source: 'unavailable', code: 'unsupported-shell' });
    expect(await captureAndApply({ platform: 'win32', env: {} })).toEqual({ source: 'windows-session' });
  });

  it('an rc that swallows stdout leaves no frame: unavailable:bad-frame', async () => {
    const { env } = await fixtureHome('exec 1>/dev/null\n');
    expect(await captureAndApply({ shell, env })).toEqual({ source: 'unavailable', code: 'bad-frame' });
  });

  it('rc cannot set BYOK_*: captured BYOK_* is dropped, pre-capture BYOK_* is kept, children get none', async () => {
    const { env } = await fixtureHome('export BYOK_CLAUDE_BIN=/rc/evil-claude\nexport BYOK_CONFIG=/rc/evil.json\nexport RC_SET=1\n');
    env.BYOK_CONFIG = '/own/config.json';
    expect(await captureAndApply({ shell, env })).toMatchObject({ source: 'login-shell' });
    expect(env.BYOK_CONFIG).toBe('/own/config.json');
    expect(env.BYOK_CLAUDE_BIN).toBeUndefined();
    expect(env.RC_SET).toBe('1');
    expect(Object.keys(testRuntimeEnv(env, 'darwin')).filter((name) => name.startsWith('BYOK_'))).toEqual([]);
  });

  it('the login shell never sees this process\'s BYOK_* values; they are restored afterwards', async () => {
    const { env } = await fixtureHome('export SAW_BYOK="${BYOK_TEST_SECRET-unset}"\n');
    env.BYOK_TEST_SECRET = 's3cret';
    expect(await captureAndApply({ shell, env })).toMatchObject({ source: 'login-shell' });
    expect(env.SAW_BYOK).toBe('unset');
    expect(env.BYOK_TEST_SECRET).toBe('s3cret');
  });

  it('#1095: a Host variable set before the capture never enters the snapshot; the seed is a closed list with a fixed PATH', async () => {
    const { home, env } = await fixtureHome('export RC_DEFINED=from-rc\nexport SAW_SEED_PATH="$PATH"\nexport SAW_HOST="${HOST_ONLY_SENTINEL-unset}"\n');
    env.HOST_ONLY_SENTINEL = 'not-a-secret';
    env.LANG = 'en_US.UTF-8';
    env.PATH = '/host/bundle/bin:/usr/bin:/bin';
    const snapshot = await captureLoginShellSnapshot({ shell, env });
    expect(snapshot.status).toMatchObject({ source: 'login-shell' });
    expect(snapshot.env?.HOST_ONLY_SENTINEL).toBeUndefined();
    expect(snapshot.env?.SAW_HOST).toBe('unset');
    // /etc/profile (path_helper on macOS) may extend the seed PATH; the Host's entry is never in it.
    expect(snapshot.env?.SAW_SEED_PATH?.split(':')).toEqual(expect.arrayContaining(LOGIN_SHELL_SEED_PATH.split(':')));
    expect(snapshot.env?.SAW_SEED_PATH?.split(':')).not.toContain('/host/bundle/bin');
    expect(snapshot.env?.RC_DEFINED).toBe('from-rc');
    expect(snapshot.env?.HOME).toBe(home);
    expect(snapshot.env?.LANG).toBe('en_US.UTF-8');
    expect(env.HOST_ONLY_SENTINEL).toBe('not-a-secret');
  });

  it('#1095: after the capture, a Host variable reaches the runtime only when pass names it', async () => {
    const { env } = await fixtureHome('export RC_DEFINED=from-rc\n');
    const snapshot = await captureLoginShellSnapshot({ shell, env });
    const live = { ...env, HOST_LATE_SENTINEL: 'late', HOST_PASSED_SENTINEL: 'passed' };
    const runtime = composeRuntimeEnvironment({ policy: { pass: ['HOST_PASSED_SENTINEL'] }, snapshot, live, platform: 'darwin' });
    expect(runtime.RC_DEFINED).toBe('from-rc');
    expect(runtime.HOST_PASSED_SENTINEL).toBe('passed');
    expect(runtime).not.toHaveProperty('HOST_LATE_SENTINEL');
  });

  it('the account shell is used when none is injected (zsh/bash hosts only)', async (ctx) => {
    const passwd = os.userInfo().shell;
    if (!passwd || !['zsh', 'bash'].includes(path.basename(passwd))) ctx.skip();
    const home = await tempDir();
    for (const file of ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']) {
      await fs.writeFile(path.join(home, file), 'export PATH="/rc-login/bin:$PATH"\n');
    }
    const env: NodeJS.ProcessEnv = { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' };
    expect(await captureAndApply({ env })).toMatchObject({ source: 'login-shell', shell: path.basename(passwd!) });
    expect(env.PATH?.split(':')).toContain('/rc-login/bin');
  });

  it('an account entry that cannot be read or does not hold: unavailable:account-shell-unavailable; an unsupported one: unsupported-shell', async () => {
    const uid = String(process.getuid!());
    const entry = (fields: { uid?: string; shell: string }) => `u:*:${fields.uid ?? uid}:20::0:0:u:/h:${fields.shell}`;
    const status = (accountCommand: readonly [string, ...string[]], platform: NodeJS.Platform = process.platform) =>
      captureAndApply({ accountCommand, env: {}, platform });
    const unavailable = { source: 'unavailable', code: 'account-shell-unavailable' };
    expect(await status([path.join(await tempDir(), 'missing')])).toEqual(unavailable);
    expect(await status(['/usr/bin/false'])).toEqual(unavailable);
    expect(await status(['/bin/echo', entry({ uid: String(Number(uid) + 1), shell: '/bin/sh' })])).toEqual(unavailable);
    expect(await status(['/bin/echo', entry({ shell: 'zsh' })])).toEqual(unavailable);
    expect(await status(['/bin/echo', entry({ shell: '' })])).toEqual(unavailable);
    expect(await status(['/bin/echo', `${entry({ shell: '/bin/sh' })}\n${entry({ shell: '/bin/sh' })}`])).toEqual(unavailable);
    expect(await captureAndApply({ env: {}, platform: 'freebsd' })).toEqual(unavailable);
    expect(await status(['/bin/echo', entry({ shell: '/usr/local/bin/nu' })])).toEqual({ source: 'unavailable', code: 'unsupported-shell' });
    expect(await status(['/bin/echo', entry({ shell: '/bin/sh' })])).toMatchObject({ source: 'login-shell', shell: 'sh' });
  });
});

// Use a real fish binary and isolated rc files; the account-command seam selects it,
// so this also exercises the production supported-shell gate.
const fish = (process.env.PATH ?? '').split(path.delimiter)
  .map(dir => path.join(dir, 'fish')).find(file => existsSync(file));
describe.runIf(posix && fish !== undefined)('fish login-shell capture', () => {
  const fishAccount: readonly [string, ...string[]] = ['/bin/echo', `u:*:${process.getuid?.()}:20::0:0:u:/h:${fish}`];
  async function fishHome(rc: string): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
    const home = await tempDir();
    const config = path.join(home, '.config');
    await fs.mkdir(path.join(config, 'fish'), { recursive: true });
    await fs.writeFile(path.join(config, 'fish/config.fish'), rc);
    return { home, env: { HOME: home, XDG_CONFIG_HOME: config, PATH: '/usr/bin:/bin', BYOK_OWNER_VALUE: 'original' } };
  }

  it('captures fish PATH and multiline exports despite rc noise, isolating BYOK values', async () => {
    const { home, env } = await fishHome('echo welcome\necho warning >&2\nset -gx PATH "$HOME/fish-bin" $PATH\nset -gx RC_MULTI "line one\nline two"\nset -gx BYOK_OWNER_VALUE overwritten\nset -gx BYOK_RC_ONLY secret\n');
    expect(await captureAndApply({ env, accountCommand: fishAccount })).toMatchObject({ source: 'login-shell', shell: 'fish' });
    expect(env.PATH?.split(':')).toContain(path.join(home, 'fish-bin'));
    expect(env.RC_MULTI).toBe('line one\nline two');
    expect(env.BYOK_OWNER_VALUE).toBe('original');
    expect(env.BYOK_RC_ONLY).toBeUndefined();
  });

  it('bounds slow fish rc and leaves the inherited environment untouched on failure', async () => {
    const { env } = await fishHome('sleep 30\nset -gx RC_SET unexpected\n');
    const before = { ...env };
    expect(await captureAndApply({ env, accountCommand: fishAccount, timeoutMs: 100 })).toEqual({ source: 'unavailable', code: 'timeout' });
    expect(env).toEqual(before);
  });
});

/**
 * The login shell is the account's, read from the account database by uid on
 * every runtime: Bun's `os.userInfo().shell` returns `$SHELL`, so a Host's
 * `SHELL` would otherwise choose the shell and become the snapshot authority.
 * The vitest worker runs on Node, whose `os.userInfo()` is getpwuid, so it
 * supplies the expected answer; each runtime then captures in a child.
 */
const accountShell = posix ? os.userInfo().shell ?? undefined : undefined;
const BUN = resolveBunBin();
const MODULE_URL = new URL('../login-shell-environment.ts', import.meta.url).href;
const CHILD = `const { captureLoginShellSnapshot } = await import(${JSON.stringify(MODULE_URL)});
const s = await captureLoginShellSnapshot({});
process.stdout.write(JSON.stringify({ status: s.status, shell: s.env?.SHELL }));`;

function captureIn(runtime: string, home: string, shellVar: string | undefined): Promise<{ status: { source: string; shell?: string; code?: string }; shell?: string }> {
  const env: NodeJS.ProcessEnv = { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...(shellVar === undefined ? {} : { SHELL: shellVar }) };
  return new Promise((resolve, reject) => {
    execFile(runtime, ['--input-type=module', '-e', CHILD], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${runtime}: ${error.message}\n${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

describe.runIf(posix && accountShell !== undefined && path.basename(accountShell) !== 'sh')('the account shell, not $SHELL (#1095)', () => {
  for (const [name, runtime] of [['node', process.execPath], ['bun', BUN]] as const) {
    it.skipIf(runtime === undefined)(`${name}: SHELL=/bin/sh and SHELL unset both capture with the account shell, which is also the seeded SHELL`, async () => {
      const home = await tempDir();
      for (const shellVar of ['/bin/sh', undefined]) {
        const result = await captureIn(runtime!, home, shellVar);
        expect(result.status).toMatchObject({ source: 'login-shell', shell: path.basename(accountShell!) });
        expect(result.shell).toBe(accountShell);
      }
    });
  }
});
