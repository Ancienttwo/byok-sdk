import { describe, expect, it } from 'vitest';
import { buildAllowlistedEnv, buildRuntimeEnv } from '../daemon/environment';

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

describe('buildRuntimeEnv', () => {
  it('inherits the full ambient environment, user variables and provider keys included', () => {
    const env = ambient({
      PATH: '/usr/bin',
      HOME: '/home/user',
      MY_TEAM_SETTING: 'from-the-user-shell',
      ANTHROPIC_API_KEY: 'sk-ant-user',
      OPENAI_API_KEY: 'sk-openai-user',
      CLAUDE_CONFIG_DIR: '/home/user/.claude-work',
      CODEX_HOME: '/home/user/.codex',
    });
    expect(buildRuntimeEnv({ ambient: env, platform: 'darwin' })).toEqual(env);
  });

  it('drops CLAUDECODE, every BYOK_* name and the loader injection names', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        BYOK_STORE_DIR: '/secret/store',
        BYOK_ANYTHING: 'x',
        NODE_OPTIONS: '--require /tmp/x.js',
        LD_PRELOAD: '/tmp/x.so',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      }),
      platform: 'linux',
    });
    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('F1: drops mixed-case CLAUDECODE and BYOK_* names on win32 and keeps OS-cased names', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ Path: 'C:\\Windows', ClaudeCode: '1', byok_secret: 'must-not-leak', Byok_X: 'also-must-not-leak' }),
      platform: 'win32',
    });
    expect(result).toEqual({ Path: 'C:\\Windows' });
  });

  it('returns a fresh object, skips undefined values and never mutates ambient', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', GHOST: undefined, CLAUDECODE: '1' };
    const before = { ...env };
    const result = buildRuntimeEnv({ ambient: env });
    expect(result).toEqual({ PATH: '/bin' });
    expect(result).not.toBe(env);
    expect(env).toEqual(before);
  });
});
