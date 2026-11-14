import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRuntimeEnvironmentPolicy, buildAllowlistedEnv, buildRuntimeEnvironment, composeRuntimeEnvironment, parseWindowsRegistryExport, readWindowsLogonRegistry,
  readWindowsRegistryKey, RuntimeEnvironmentUnavailableError, setWindowsLogonRegistrySource, WINDOWS_MACHINE_ENVIRONMENT_KEY, WINDOWS_USER_ENVIRONMENT_KEY,
  type RuntimeEnvironmentPolicy, type WindowsLogonRegistry, type WindowsRegistryString,
} from '../runtime/environment';
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
    expect(result).toEqual({ PATH: osCasedEnv.Path, COMSPEC: osCasedEnv.ComSpec, SYSTEMDRIVE: osCasedEnv.SystemDrive, PROGRAMFILES: osCasedEnv.ProgramFiles });
  });

  it('win32 canonicalizes duplicate names in sorted order like runtime composition', () => {
    const live = { Path: 'a', PATH: 'b', Byok_Secret: 'secret' };
    const result = buildAllowlistedEnv({ ambient: live, platform: 'win32', allow: ['Byok_Secret'] });
    expect(result).toEqual({ PATH: 'b' });
    expect(composeRuntimeEnvironment({ policy: { base: 'allowlist', allow: ['Byok_Secret'] }, live, platform: 'win32' }).env)
      .toEqual({ ...result, NO_PROXY: '127.0.0.1,localhost' });
  });

  it('F1: hard-denies BYOK_* case-insensitively on win32, so a mixed-case Byok_X / byok_secret cannot leak through even via an explicit allow entry', () => {
    const result = buildAllowlistedEnv({
      ambient: ambient({ Path: 'C:\\Windows', byok_secret: 'must-not-leak', Byok_X: 'also-must-not-leak' }),
      platform: 'win32',
      allow: ['byok_secret', 'Byok_X'],
    });
    expect(result).toEqual({ PATH: 'C:\\Windows' });
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

  it('login-shell: HOME is the daemon\'s live HOME, not the one the rc exported; values the rc derived from it stay (#2084)', () => {
    const shell = { PATH: '/rc/elsewhere/bin:/usr/bin', HOME: '/rc/elsewhere', XDG_CONFIG_HOME: '/rc/elsewhere/.config' };
    const live = { PATH: '/usr/bin', HOME: '/tmp/scratch' };
    const build = (policy: RuntimeEnvironmentPolicy) => composeRuntimeEnvironment({ policy, snapshot: snapshot(shell), live, platform: 'darwin' });
    const pinned = build({});
    expect(pinned.env).toEqual({ ...shell, HOME: '/tmp/scratch', ...LOOPBACK });
    expect(pinned.report.names).toContainEqual({ name: 'HOME', source: 'sdk' });
    expect(build({ pass: ['HOME'] }).report.names).toContainEqual({ name: 'HOME', source: 'pass' });
    expect(build({ base: 'allowlist' }).env).toEqual({ ...live, ...LOOPBACK });
    expect(compose({}, shell, { PATH: '/usr/bin' })).toEqual({ ...shell, ...LOOPBACK });
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

  it('explains the allowlist remedy when base capture fails', () => {
    const error = new RuntimeEnvironmentUnavailableError('timeout');
    expect(error.message).toContain("runtimeEnvironment.base to 'allowlist'");
    expect(error).toMatchObject({ code: 'runtime_environment_unavailable', reason: 'timeout' });
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

  it('win32: PATH is the logon registry value, not a profile-edited session PATH; the other session baseline names match and deny case-insensitively', () => {
    const live = { Path: 'C:\\Windows;C:\\Users\\u\\fnm', USERNAME: 'u', ProgramData: 'C:\\ProgramData', HOST_ONLY_SENTINEL: 'x', ClaudeCode: '1', byok_secret: 'must-not-leak', no_proxy: 'corp.example' };
    expect(composeRuntimeEnvironment({ policy: {}, live, windowsLogon: logonRegistry({ Path: sz('C:\\Windows') }), platform: 'win32' }).env)
      .toEqual({ PATH: 'C:\\Windows', USERNAME: 'u', PROGRAMDATA: 'C:\\ProgramData', NO_PROXY: 'corp.example,127.0.0.1,localhost' });
  });

  it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'])('win32: the session %s reaches the runtime, as the login-shell snapshot keeps it elsewhere (#1595)', (name) => {
    const live = { Path: 'C:\\Windows', [name.toLowerCase()]: 'D:\\custom-home', HOST_ONLY_SENTINEL: 'x' };
    expect(composeRuntimeEnvironment({ policy: {}, live, windowsLogon: logonRegistry({ Path: sz('C:\\Windows') }), platform: 'win32' }).env)
      .toEqual({ PATH: 'C:\\Windows', [name]: 'D:\\custom-home', NO_PROXY: '127.0.0.1,localhost' });
  });

  it.each<RuntimeEnvironmentPolicy>([{}, { pass: ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_*'] }, { base: 'allowlist', allow: ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_*'] }])('win32: canonicalizes session names and keeps the first sorted duplicate under %j (#1611)', (policy) => {
    const live = Object.freeze({ Codex_Home: 'D:\\other', CODEX_HOME: 'D:\\first', claude_config_dir: 'D:\\claude', xdg_config_home: 'D:\\xdg' });
    const { env, report } = composeRuntimeEnvironment({ policy, live, windowsLogon: logonRegistry({}), platform: 'win32' });
    expect(env).toEqual({ CODEX_HOME: 'D:\\first', CLAUDE_CONFIG_DIR: 'D:\\claude', XDG_CONFIG_HOME: 'D:\\xdg', NO_PROXY: '127.0.0.1,localhost' });
    const source = policy.base === 'allowlist' ? 'allowlist' : policy.pass ? 'pass' : 'windows-session';
    expect(report.names).toEqual([{ name: 'CLAUDE_CONFIG_DIR', source }, { name: 'CODEX_HOME', source }, { name: 'NO_PROXY', source: 'sdk' }, { name: 'XDG_CONFIG_HOME', source }]);
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
      .toEqual({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'sk-ant-host', NO_PROXY: '127.0.0.1,localhost' });
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
    expect(composeRuntimeEnvironment({ policy: {}, live: { Path: 'C:\\Windows', no_proxy: 'corp.example', HOST_ONLY_SENTINEL: 'x' }, windowsLogon: logonRegistry({ Path: sz('C:\\Windows') }), platform: 'win32' }).report)
      .toEqual({ names: [{ name: 'NO_PROXY', source: 'sdk' }, { name: 'PATH', source: 'windows-session' }], removed: [] });
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

const sz = (value: string): WindowsRegistryString => ({ expand: false, value });
const ex = (value: string): WindowsRegistryString => ({ expand: true, value });
const keyValues = (values: Record<string, WindowsRegistryString>) => new Map(Object.entries(values).map(([name, value]) => [name.toUpperCase(), value]));

function logonRegistry(machine: Record<string, WindowsRegistryString>, user: Record<string, WindowsRegistryString> = {}): WindowsLogonRegistry {
  return { source: 'registry', machine: keyValues(machine), user: keyValues(user) };
}

/** A `reg export` file of `key`: BOM, header, section, then `lines`. */
function regExport(key: string, lines: readonly string[]): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(['Windows Registry Editor Version 5.00', '', `[${key}]`, ...lines, '', ''].join('\r\n'), 'utf16le')]);
}

/** `"<name>"=hex(2):..` for `text`, wrapped after 10 bytes as reg export wraps. */
function hex2Line(name: string, text: string): string {
  const octets = [...Buffer.from(`${text}\0`, 'utf16le')].map((octet) => octet.toString(16).padStart(2, '0'));
  return `"${name}"=hex(2):${octets.slice(0, 10).join(',')},\\\r\n  ${octets.slice(10).join(',')}`;
}

describe('win32 logon registry base (#1317)', () => {
  const session = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', USERNAME: 'u', HOMEDRIVE: 'C:', TMPDIR: 'C:\\t', HOST_ONLY: 'C:\\h' };
  // One row per rule measured in #1395 (issuecomment-6599686570, -6599840085).
  const rows: readonly { rule: string; machine: Record<string, WindowsRegistryString>; user: Record<string, WindowsRegistryString>; Path?: string; PATHEXT?: string }[] = [
    { rule: 'Path is machine then user, joined by ;, empty entries skipped', machine: { Path: sz('C:\\M1;C:\\M2') }, user: { Path: sz(';C:\\U1;;C:\\U2;') }, Path: 'C:\\M1;C:\\M2;C:\\U1;C:\\U2' },
    { rule: 'an empty user Path adds nothing', machine: { Path: sz('C:\\M1') }, user: { Path: ex('') }, Path: 'C:\\M1' },
    { rule: 'a user %PATH% is the machine value; user entries byte-equal to a machine entry are dropped', machine: { Path: sz('C:\\M1;C:\\M2') }, user: { Path: ex('%PATH%;C:\\U;c:\\m1;C:\\U') }, Path: 'C:\\M1;C:\\M2;C:\\U;c:\\m1;C:\\U' },
    { rule: 'two %PATH% written together join the last and first machine entries into one kept entry (B9)', machine: { Path: sz('C:\\M1;C:\\M2') }, user: { Path: ex('C:\\U9a;%PATH%%PATH%;C:\\U9b') }, Path: 'C:\\M1;C:\\M2;C:\\U9a;C:\\M2C:\\M1;C:\\U9b' },
    { rule: 'a %PATH% glued to other text keeps the glued entries (B10)', machine: { Path: sz('C:\\M1;C:\\M2') }, user: { Path: ex('C:\\U10a%PATH%C:\\U10b') }, Path: 'C:\\M1;C:\\M2;C:\\U10aC:\\M1;C:\\M2C:\\U10b' },
    { rule: 'a machine entry with a trailing backslash is a different entry (B14)', machine: { Path: sz('C:\\M1;C:\\M2') }, user: { Path: sz('C:\\U14;C:\\M1\\;C:\\U14z') }, Path: 'C:\\M1;C:\\M2;C:\\U14;C:\\M1\\;C:\\U14z' },
    { rule: 'a user entry that expands to a machine entry is dropped (B16)', machine: { Path: sz('C:\\Windows\\system32;C:\\M2') }, user: { Path: ex('%SystemRoot%\\system32;C:\\U16') }, Path: 'C:\\Windows\\system32;C:\\M2;C:\\U16' },
    { rule: 'a user Path left empty by that adds no trailing ;', machine: { Path: sz('C:\\M1') }, user: { Path: ex('%PATH%') }, Path: 'C:\\M1' },
    { rule: 'the user PATHEXT replaces the machine one', machine: { PATHEXT: sz('.COM;.EXE') }, user: { PATHEXT: sz('.EXE;.PS1') }, PATHEXT: '.EXE;.PS1' },
    { rule: 'a user %PATHEXT% is the machine value', machine: { PATHEXT: sz('.COM;.EXE') }, user: { PATHEXT: ex('%PATHEXT%;.PS1') }, PATHEXT: '.COM;.EXE;.PS1' },
    { rule: 'REG_SZ is never expanded', machine: {}, user: { Path: sz('%USERPROFILE%\\bin') }, Path: '%USERPROFILE%\\bin' },
    { rule: 'profile names expand only at the user stage', machine: { Path: ex('%SystemRoot%\\system32;%USERPROFILE%\\m') }, user: { Path: ex('%USERPROFILE%\\u;%APPDATA%\\u') }, Path: 'C:\\Windows\\system32;%USERPROFILE%\\m;C:\\Users\\u\\u;C:\\Users\\u\\AppData\\Roaming\\u' },
    { rule: 'machine variables feed the expansion', machine: { JAVA_HOME: sz('C:\\jdk'), Path: ex('%JAVA_HOME%\\bin') }, user: {}, Path: 'C:\\jdk\\bin' },
    { rule: 'an expandable value sees every plain value, but only the expandable values before it', machine: {}, user: { Path: ex('%NVM_HOME%;%NVM_SYMLINK%'), NVM_HOME: sz('C:\\nvm'), NVM_SYMLINK: ex('%NVM_HOME%\\link') }, Path: 'C:\\nvm;%NVM_SYMLINK%' },
    { rule: 'volatile, Host-set and session-only names never expand; USERNAME is the machine key value', machine: { USERNAME: sz('SYSTEM') }, user: { Path: ex('%HOMEDRIVE%\\a;%TMPDIR%\\b;%HOST_ONLY%\\c;C:\\%USERNAME%;%UNDEFINED%') }, Path: '%HOMEDRIVE%\\a;%TMPDIR%\\b;%HOST_ONLY%\\c;C:\\SYSTEM;%UNDEFINED%' },
  ];
  it.each(rows)('$rule', async ({ machine, user, Path, PATHEXT }) => {
    const asked: string[] = [];
    const windowsLogon = await readWindowsLogonRegistry(async (key) => { asked.push(key); return keyValues(key === WINDOWS_MACHINE_ENVIRONMENT_KEY ? machine : user); });
    expect(asked).toEqual([WINDOWS_MACHINE_ENVIRONMENT_KEY, WINDOWS_USER_ENVIRONMENT_KEY]);
    const { env } = composeRuntimeEnvironment({ policy: {}, live: { ...session, Path: 'C:\\session-only' }, windowsLogon, platform: 'win32' });
    expect({ Path: env.PATH, PATHEXT: env.PATHEXT }).toEqual({ Path, PATHEXT });
    expect(env).not.toHaveProperty('JAVA_HOME');
  });

  it('a passed PATH replaces the logon Path whatever its spelling', () => {
    const { env, report } = composeRuntimeEnvironment({ policy: { pass: ['PATH'] }, live: { PATH: 'C:\\shims;C:\\Windows' }, windowsLogon: logonRegistry({ Path: sz('C:\\Windows') }), platform: 'win32' });
    expect(env).toEqual({ PATH: 'C:\\shims;C:\\Windows', NO_PROXY: '127.0.0.1,localhost' });
    expect(report.names).toEqual([{ name: 'NO_PROXY', source: 'sdk' }, { name: 'PATH', source: 'pass' }]);
  });

  it('exports one key at a time, machine first', async () => {
    let running = 0;
    let most = 0;
    await readWindowsLogonRegistry(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return new Map();
    });
    expect(most).toBe(1);
  });

  it('a failed registry read fails closed with logon-registry-unavailable', async () => {
    const windowsLogon = await readWindowsLogonRegistry(async () => { throw new Error('reg export exited 1'); });
    expect(windowsLogon).toEqual({ source: 'unavailable' });
    expect(() => composeRuntimeEnvironment({ policy: {}, live: session, windowsLogon, platform: 'win32' }))
      .toThrow(expect.objectContaining({ code: 'runtime_environment_unavailable', reason: 'logon-registry-unavailable' }));
  });

  const key = 'HKCU\\Environment';
  const section = 'HKEY_CURRENT_USER\\Environment';
  const parses: readonly { case: string; bytes: Uint8Array; values?: [string, WindowsRegistryString][] }[] = [
    {
      case: 'REG_SZ escapes, REG_EXPAND_SZ over a continued line, other types and a subkey skipped',
      bytes: regExport(section, ['"PathExt"="C:\\\\工具\\\\\\"q\\";.JS"', hex2Line('Path', 'C:\\byok 空間 é\\bin;%USERPROFILE%'), '"Count"=dword:00000005', '"Bin"=hex:01,02', '"Multi"=hex(7):41,00,00,00,00,00', '@="default"', '', `[${section}\\Sub]`, '"Inner"="x"']),
      values: [['PATHEXT', sz('C:\\工具\\"q";.JS')], ['PATH', ex('C:\\byok 空間 é\\bin;%USERPROFILE%')]],
    },
    { case: 'no byte order mark', bytes: regExport(section, []).slice(2) },
    { case: 'an export of another key than the one requested (#1395 E1g)', bytes: regExport('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', []) },
    { case: 'a line that is no value', bytes: regExport(section, ['"Path"="C:\\\\a', 'b"']) },
    { case: 'an odd-length expandable string', bytes: regExport(section, ['"Path"=hex(2):41']) },
  ];
  it.each(parses)('parses reg export: $case', ({ bytes, values }) => {
    if (values === undefined) expect(() => parseWindowsRegistryExport(bytes, key)).toThrow();
    else expect([...parseWindowsRegistryExport(bytes, key)]).toEqual(values);
  });

  it.runIf(process.platform === 'win32')('reads a non-ASCII value and the real logon keys through reg export', async () => {
    const reg = path.win32.join(process.env.SystemRoot!, 'System32', 'reg.exe');
    const scratch = `HKCU\\Software\\byok-sdk-test-1317-${process.pid}`;
    const value = 'C:\\byok 空間 é\\bin;%USERPROFILE%\\x';
    execFileSync(reg, ['add', scratch, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f']);
    execFileSync(reg, ['add', scratch, '/v', 'Count', '/t', 'REG_DWORD', '/d', '5', '/f']);
    try {
      expect([...await readWindowsRegistryKey(scratch)]).toEqual([['PATH', ex(value)]]);
    } finally {
      execFileSync(reg, ['delete', scratch, '/f']);
    }
    setWindowsLogonRegistrySource(undefined);
    const { env, report } = await buildRuntimeEnvironment({});
    expect(env.PATH).toMatch(/system32/iu);
    expect(report.names).toContainEqual({ name: 'PATH', source: 'windows-session' });
  });
});
