import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeEnv } from '../daemon/environment';
import { captureAndApply } from '../lifecycle/service-environment';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-svcenv-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
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
    expect(await captureAndApply({ platform: 'win32', env: {} })).toEqual({ source: 'inherited' });
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
    expect(Object.keys(buildRuntimeEnv({ ambient: env, platform: 'darwin' })).filter((name) => name.startsWith('BYOK_'))).toEqual([]);
  });

  it('the passwd shell is used when none is injected (zsh/bash hosts only)', async (ctx) => {
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
});
