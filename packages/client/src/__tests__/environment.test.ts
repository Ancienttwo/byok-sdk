import { describe, expect, it } from 'vitest';
import { assertRuntimeEnvironmentPolicy, buildAllowlistedEnv, composeRuntimeEnvironment, RuntimeEnvironmentUnavailableError, type RuntimeEnvironmentPolicy } from '../runtime/environment';
import type { LoginShellSnapshot } from '../login-shell-environment';

/** A minimal ambient env with no incidental host cruft — every test builds exactly the vars it cares about, rather than depending on whatever happens to be set on the machine running the suite. */
function ambient(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...vars };
}

describe('buildAllowlistedEnv', () => {
  it('includes only the platform baseline when the caller allows no extra names (fail-closed by omission)', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({
        PATH: '/usr/bin',
        HOME: '/home/user',
        USER: 'user',
        AWS_SECRET_ACCESS_KEY: 'leak-me',
        RANDOM_UNRELATED_VAR: 'nope',
      }),
    });
    expect(result).toEqual({ PATH: '/usr/bin', HOME: '/home/user', USER: 'user' });
  });

  it('includes the full platform baseline (PATH/HOME/USER/USERPROFILE/TMPDIR/TEMP/TMP/LANG/TZ/TERM/SHELL) when set', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({
        PATH: '/bin',
        HOME: '/home/user',
        USER: 'user',
        USERPROFILE: 'C:\\Users\\user',
        TMPDIR: '/tmp',
        TEMP: '/temp',
        TMP: '/t',
        LANG: 'en_US.UTF-8',
        TZ: 'UTC',
        TERM: 'xterm',
        SHELL: '/bin/zsh',
      }),
    });
    expect(result).toEqual({
      PATH: '/bin',
      HOME: '/home/user',
      USER: 'user',
      USERPROFILE: 'C:\\Users\\user',
      TMPDIR: '/tmp',
      TEMP: '/temp',
      TMP: '/t',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
      TERM: 'xterm',
      SHELL: '/bin/zsh',
    });
  });

  it('matches LC_* and XDG_* as prefixes, not exact names', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({
        LC_ALL: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        XDG_CONFIG_HOME: '/home/user/.config',
        XDG_DATA_HOME: '/home/user/.local/share',
        LOCALE_SOMETHING_ELSE: 'not a match',
      }),
    });
    expect(result).toEqual({
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/home/user/.config',
      XDG_DATA_HOME: '/home/user/.local/share',
    });
  });

  it('includes the Windows-only base vars when platform is win32, and excludes them otherwise', () => {
    const env = ambient({
      SystemRoot: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.EXE',
      windir: 'C:\\Windows',
      SYSTEMDRIVE: 'C:',
      PROGRAMFILES: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
    });

    const onWindows = buildAllowlistedEnv({ ambient: env, platform: 'win32' });
    expect(onWindows).toEqual(env);

    const onDarwin = buildAllowlistedEnv({ ambient: env, platform: 'darwin' });
    expect(onDarwin).toEqual({});
  });

  it('F1: matches allowlist patterns case-insensitively on win32, so real OS-cased keys (Path, ComSpec, SystemDrive, ProgramFiles) still pass even though every pattern in the lists is SCREAMING_CASE', () => {
    const osCasedEnv = ambient({
      Path: 'C:\\Windows;C:\\Windows\\System32',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemDrive: 'C:',
      ProgramFiles: 'C:\\Program Files',
    });

    const result = buildAllowlistedEnv({ ambient: osCasedEnv, platform: 'win32' });
    expect(result).toEqual(osCasedEnv);
  });

  it('F1: hard-denies BYOK_* case-insensitively on win32, so a mixed-case Byok_X / byok_secret cannot leak through even via an explicit allow entry', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ Path: 'C:\\Windows', byok_secret: 'must-not-leak', Byok_X: 'also-must-not-leak' }),
      platform: 'win32',
      allow: ['byok_secret', 'Byok_X'],
    });
    expect(result).toEqual({ Path: 'C:\\Windows' });
  });

  it('F1: keeps matching byte-exact/case-sensitive on non-win32 — an OS-cased key spelled the way win32 would spell it (Path) does NOT match the PATH pattern there', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ Path: 'wrong-case-should-not-match', PATH: '/usr/bin' }),
      platform: 'darwin',
    });
    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('F3: includes the standard proxy variables (both SCREAMING_CASE and lowercase) on linux and darwin', () => {
    const proxyVars = {
      HTTP_PROXY: 'http://proxy.example.com:8080',
      HTTPS_PROXY: 'http://proxy.example.com:8443',
      NO_PROXY: 'localhost,127.0.0.1',
      ALL_PROXY: 'socks5://proxy.example.com:1080',
      http_proxy: 'http://proxy.example.com:8080',
      https_proxy: 'http://proxy.example.com:8443',
      no_proxy: 'localhost,127.0.0.1',
      all_proxy: 'socks5://proxy.example.com:1080',
    };

    for (const platform of ['linux', 'darwin'] as const) {
      const result = buildAllowlistedEnv({ ambient: ambient(proxyVars), platform });
      expect(result).toEqual(proxyVars);
    }
  });

  it('adds allow names on top of the platform baseline', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({
        PATH: '/bin',
        MY_CONFIG_DIR: '/config',
        MY_API_KEY: 'secret-value',
        UNRELATED: 'nope',
      }),
      allow: ['MY_CONFIG_DIR', 'MY_API_KEY'],
    });
    expect(result).toEqual({ PATH: '/bin', MY_CONFIG_DIR: '/config', MY_API_KEY: 'secret-value' });
  });

  it('supports a `*`-suffixed prefix pattern in allow', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ PATH: '/bin', FOO_ONE: '1', FOO_TWO: '2', BAR: 'nope' }),
      allow: ['FOO_*'],
    });
    expect(result).toEqual({ PATH: '/bin', FOO_ONE: '1', FOO_TWO: '2' });
  });

  it('hard-denies BYOK_* even when explicitly listed in allow', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ PATH: '/bin', BYOK_CONTROL_SECRET: 'must-not-leak' }),
      allow: ['BYOK_CONTROL_SECRET'],
    });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('hard-denies any BYOK_*-prefixed name, not just an exact BYOK_ literal', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ PATH: '/bin', BYOK_STORE_DIR: '/secret/store', BYOK_ANYTHING: 'x' }),
      allow: ['BYOK_STORE_DIR', 'BYOK_ANYTHING'],
    });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('never mutates the ambient object passed in', () => {
    const env = ambient({ PATH: '/bin', SECRET: 'x' });
    const before = { ...env };
    buildAllowlistedEnv({ ambient: env, allow: ['SECRET'] });
    expect(env).toEqual(before);
  });

  it('returns a fresh object each call, not a reference to ambient', () => {
    const env = ambient({ PATH: '/bin' });
    const result = buildAllowlistedEnv({ ambient: env });
    expect(result).not.toBe(env);
  });

  it('skips a variable whose ambient value is undefined', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', GHOST: undefined };
    const result = buildAllowlistedEnv({ ambient: env, allow: ['GHOST'] });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('excludes an unrelated variable that matches none of the allow layers', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ PATH: '/bin', DATABASE_URL: 'postgres://leak' }),
      allow: ['SOME_OTHER_KEY'],
    });
    expect(result).toEqual({ PATH: '/bin' });
  });
});

function snapshot(env: Record<string, string>): LoginShellSnapshot {
  return { status: { source: 'login-shell', shell: 'zsh', durationMs: 1 }, env };
}

const LOOPBACK = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

function compose(policy: RuntimeEnvironmentPolicy, shell: Record<string, string>, live: Record<string, string | undefined>, platform: NodeJS.Platform = 'darwin', conflicts?: (passed: ReadonlySet<string>) => readonly string[]): Record<string, string> {
  return composeRuntimeEnvironment({ policy, snapshot: snapshot(shell), live, platform, ...(conflicts === undefined ? {} : { conflicts }) }).env;
}

describe('composeRuntimeEnvironment (#1095)', () => {
  it('login-shell: the snapshot is the base, user variables and provider keys included; the live environment is not', () => {
    const shell = { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/home/user', MY_TEAM_SETTING: 'from-the-user-shell', ANTHROPIC_API_KEY: 'sk-ant-user', CODEX_HOME: '/home/user/.codex' };
    const live = { ...shell, PATH: '/app/bundle/bin:/usr/bin', HOST_ONLY_SENTINEL: 'not-a-secret' };
    expect(compose({}, shell, live)).toEqual({ ...shell, ...LOOPBACK });
  });

  it('pass copies the named live variables at every build, Host writes after start included; the hard deny still wins', () => {
    const live: Record<string, string | undefined> = { PATH: '/usr/bin' };
    const policy = assertRuntimeEnvironmentPolicy({ pass: ['HOST_TOKEN_FILE', 'ACME_*'] }, 'policy');
    expect(compose(policy, { PATH: '/usr/bin' }, live)).toEqual({ PATH: '/usr/bin', ...LOOPBACK });
    live.HOST_TOKEN_FILE = '/run/acme/token';
    live.ACME_REGION = 'eu';
    live.ACME_OTHER = undefined;
    live.UNLISTED = 'x';
    expect(compose(policy, { PATH: '/usr/bin' }, live)).toEqual({ PATH: '/usr/bin', HOST_TOKEN_FILE: '/run/acme/token', ACME_REGION: 'eu', ...LOOPBACK });
    expect(compose({ pass: ['B*', 'CLAUDE*'] }, { PATH: '/usr/bin' }, { BYOK_SECRET: 's', CLAUDECODE: '1', BUILD: 'b' })).toEqual({ PATH: '/usr/bin', BUILD: 'b', ...LOOPBACK });
  });

  it('drops CLAUDECODE and every BYOK_* name from the snapshot and keeps the loader names', () => {
    const result = compose({}, {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      BYOK_STORE_DIR: '/secret/store',
      NODE_OPTIONS: '--require /tmp/x.js',
      LD_PRELOAD: '/tmp/x.so',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
    }, {}, 'linux');
    expect(result).toEqual({ PATH: '/usr/bin', NODE_OPTIONS: '--require /tmp/x.js', LD_PRELOAD: '/tmp/x.so', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', ...LOOPBACK });
  });

  it('a failed capture fails closed with the capture code; allowlist needs no snapshot', () => {
    const failed: LoginShellSnapshot = { status: { source: 'unavailable', code: 'timeout' } };
    let caught: unknown;
    try { composeRuntimeEnvironment({ policy: {}, snapshot: failed, live: { PATH: '/usr/bin' }, platform: 'darwin' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RuntimeEnvironmentUnavailableError);
    expect(caught).toMatchObject({ code: 'runtime_environment_unavailable', reason: 'timeout' });
    expect(composeRuntimeEnvironment({ policy: { base: 'allowlist', allow: ['ACME_HOME'] }, snapshot: failed, live: { PATH: '/usr/bin', ACME_HOME: '/a', OTHER: 'x' }, platform: 'darwin' }).env)
      .toEqual({ PATH: '/usr/bin', ACME_HOME: '/a', ...LOOPBACK });
  });

  it('win32: the base is the session baseline from the live environment, matched and denied case-insensitively', () => {
    const live = { Path: 'C:\\Windows', USERNAME: 'u', ProgramData: 'C:\\ProgramData', HOST_ONLY_SENTINEL: 'x', ClaudeCode: '1', byok_secret: 'must-not-leak', no_proxy: 'corp.example' };
    expect(composeRuntimeEnvironment({ policy: {}, live, platform: 'win32' }).env).toEqual({ Path: 'C:\\Windows', USERNAME: 'u', ProgramData: 'C:\\ProgramData', NO_PROXY: 'corp.example,127.0.0.1,localhost' });
  });

  it('an adapter conflict rule removes base names only when pass supplied the trigger', () => {
    const rule = (passed: ReadonlySet<string>) => passed.has('ANTHROPIC_BASE_URL') ? ['ANTHROPIC_*', 'CLAUDE_CODE_USE_BEDROCK'] : [];
    const shell = { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'shell-model' };
    expect(compose({ pass: ['ANTHROPIC_BASE_URL'] }, shell, {}, 'darwin', rule)).toEqual({ ...shell, ...LOOPBACK });
    expect(compose({ pass: ['ANTHROPIC_BASE_URL'] }, shell, { ANTHROPIC_BASE_URL: 'https://gw.example' }, 'darwin', rule))
      .toEqual({ PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://gw.example', ...LOOPBACK });
  });

  it('win32: a conflict rule sees a mixed-case passed name in upper case, so its trigger fires', () => {
    const rule = (passed: ReadonlySet<string>) => passed.has('ANTHROPIC_API_KEY') ? ['ANTHROPIC_*', 'CLAUDE_CODE_USE_BEDROCK'] : [];
    const live = { Path: 'C:\\Windows', Claude_Code_Use_Bedrock: '1', Anthropic_Api_Key: 'sk-ant-host' };
    expect(composeRuntimeEnvironment({ policy: { base: 'allowlist', allow: ['CLAUDE_CODE_*'], pass: ['ANTHROPIC_API_KEY'] }, live, platform: 'win32', conflicts: rule }).env)
      .toEqual({ Path: 'C:\\Windows', Anthropic_Api_Key: 'sk-ant-host', NO_PROXY: '127.0.0.1,localhost' });
  });

  it('NO_PROXY: merges both spellings with the loopback names, without duplicates', () => {
    expect(compose({}, { NO_PROXY: 'corp.example, localhost', no_proxy: '.internal,corp.example', HTTPS_PROXY: 'http://proxy:3128' }, {}))
      .toEqual({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'corp.example,localhost,.internal,127.0.0.1', no_proxy: 'corp.example,localhost,.internal,127.0.0.1' });
  });

  it('returns a fresh object and never mutates the snapshot or the live environment', () => {
    const shell = { PATH: '/bin' };
    const live: NodeJS.ProcessEnv = { PATH: '/bin', GHOST: undefined };
    const result = compose({}, shell, live);
    result.PATH = 'changed';
    expect(shell).toEqual({ PATH: '/bin' });
    expect(live).toEqual({ PATH: '/bin', GHOST: undefined });
  });

  it('reports every name with its source and every removed name with its rule, never a value', () => {
    const rule = (passed: ReadonlySet<string>) => passed.has('ANTHROPIC_BASE_URL') ? ['ANTHROPIC_*', 'CLAUDE_CODE_USE_BEDROCK'] : [];
    const shell = { PATH: '/usr/bin', HOME: '/home/user', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'shell-model', ANTHROPIC_BASE_URL: 'https://shell.example' };
    const live = { ANTHROPIC_BASE_URL: 'https://gw.example', BYOK_TOKEN: 'b-secret', BUILD: 'host-build', HOST_ONLY_SENTINEL: 'not-a-secret' };
    const { env, report } = composeRuntimeEnvironment({ policy: { pass: ['ANTHROPIC_BASE_URL', 'B*'] }, snapshot: snapshot(shell), live, platform: 'darwin', conflicts: rule });
    expect(report).toEqual({
      names: [
        { name: 'ANTHROPIC_BASE_URL', source: 'pass' },
        { name: 'BUILD', source: 'pass' },
        { name: 'HOME', source: 'login-shell' },
        { name: 'NO_PROXY', source: 'sdk' },
        { name: 'PATH', source: 'login-shell' },
        { name: 'no_proxy', source: 'sdk' },
      ],
      removed: [
        { name: 'ANTHROPIC_MODEL', rule: 'conflict' },
        { name: 'BYOK_TOKEN', rule: 'deny' },
        { name: 'CLAUDECODE', rule: 'deny' },
        { name: 'CLAUDE_CODE_USE_BEDROCK', rule: 'conflict' },
      ],
    });
    // The report names exactly the built keys, and no value appears in it.
    expect(report.names.map(({ name }) => name).sort()).toEqual(Object.keys(env).sort());
    const serialized = JSON.stringify(report);
    for (const value of [...Object.values(shell), ...Object.values(live)]) expect(serialized).not.toContain(value);
  });

  it('reports the base it used: allowlist and windows-session', () => {
    expect(composeRuntimeEnvironment({ policy: { base: 'allowlist', allow: ['ACME_HOME'] }, live: { PATH: '/usr/bin', ACME_HOME: '/a', OTHER: 'x' }, platform: 'darwin' }).report.names)
      .toEqual([{ name: 'ACME_HOME', source: 'allowlist' }, { name: 'NO_PROXY', source: 'sdk' }, { name: 'PATH', source: 'allowlist' }, { name: 'no_proxy', source: 'sdk' }]);
    expect(composeRuntimeEnvironment({ policy: {}, live: { Path: 'C:\\Windows', no_proxy: 'corp.example', HOST_ONLY_SENTINEL: 'x' }, platform: 'win32' }).report)
      .toEqual({ names: [{ name: 'NO_PROXY', source: 'sdk' }, { name: 'Path', source: 'windows-session' }], removed: [] });
  });

  it('validates a policy at the boundary', () => {
    expect(assertRuntimeEnvironmentPolicy(undefined, 'p')).toEqual({});
    expect(assertRuntimeEnvironmentPolicy({ base: 'allowlist', allow: ['A'], pass: ['B_*'] }, 'p')).toEqual({ base: 'allowlist', allow: ['A'], pass: ['B_*'] });
    expect(() => assertRuntimeEnvironmentPolicy({ base: 'inherit' }, 'p')).toThrow('p.base must be login-shell or allowlist');
    expect(() => assertRuntimeEnvironmentPolicy({ allow: ['A'] }, 'p')).toThrow('p.allow is not a login-shell policy field');
    expect(() => assertRuntimeEnvironmentPolicy({ pass: ['BYOK_KEY'] }, 'p')).toThrow('p.pass must not name CLAUDECODE or BYOK_*');
    expect(() => assertRuntimeEnvironmentPolicy({ pass: ['A*B'] }, 'p')).toThrow('p.pass entries must be variable names or *-suffixed prefixes');
    expect(() => assertRuntimeEnvironmentPolicy({ pass: 'A' }, 'p')).toThrow('p.pass must be an array of variable names');
  });
});
