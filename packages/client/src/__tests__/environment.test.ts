import { describe, expect, it } from 'vitest';
import { buildRuntimeEnv } from '../daemon/environment';

/** A minimal ambient env with no incidental host cruft — every test builds exactly the vars it cares about, rather than depending on whatever happens to be set on the machine running the suite. */
function ambient(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...vars };
}

describe('buildRuntimeEnv', () => {
  it('includes only the platform baseline when the adapter declares no requirements at all (fail-closed by omission)', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({
        PATH: '/usr/bin',
        HOME: '/home/user',
        AWS_SECRET_ACCESS_KEY: 'leak-me',
        RANDOM_UNRELATED_VAR: 'nope',
      }),
    });
    expect(result).toEqual({ PATH: '/usr/bin', HOME: '/home/user' });
  });

  it('includes the full platform baseline (PATH/HOME/USERPROFILE/TMPDIR/TEMP/TMP/LANG/TZ/TERM/SHELL) when set', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({
        PATH: '/bin',
        HOME: '/home/user',
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
    const result = buildRuntimeEnv({
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

    const onWindows = buildRuntimeEnv({ ambient: env, platform: 'win32' });
    expect(onWindows).toEqual(env);

    const onDarwin = buildRuntimeEnv({ ambient: env, platform: 'darwin' });
    expect(onDarwin).toEqual({});
  });

  it('F1: matches allowlist patterns case-insensitively on win32, so real OS-cased keys (Path, ComSpec, SystemDrive, ProgramFiles) still pass even though every pattern in the lists is SCREAMING_CASE', () => {
    const osCasedEnv = ambient({
      Path: 'C:\\Windows;C:\\Windows\\System32',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemDrive: 'C:',
      ProgramFiles: 'C:\\Program Files',
    });

    const result = buildRuntimeEnv({ ambient: osCasedEnv, platform: 'win32' });
    expect(result).toEqual(osCasedEnv);
  });

  it('F1: hard-denies BYOK_* case-insensitively on win32, so a mixed-case Byok_X / byok_secret cannot leak through even via an explicit locallyAllowedNames entry', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ Path: 'C:\\Windows', byok_secret: 'must-not-leak', Byok_X: 'also-must-not-leak' }),
      platform: 'win32',
      locallyAllowedNames: ['byok_secret', 'Byok_X'],
    });
    expect(result).toEqual({ Path: 'C:\\Windows' });
  });

  it('F1: keeps matching byte-exact/case-sensitive on non-win32 — an OS-cased key spelled the way win32 would spell it (Path) does NOT match the PATH pattern there', () => {
    const result = buildRuntimeEnv({
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
      const result = buildRuntimeEnv({ ambient: ambient(proxyVars), platform });
      expect(result).toEqual(proxyVars);
    }
  });

  it('adds requirements.baseNames and requirements.credentialNames on top of the platform baseline', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({
        PATH: '/bin',
        MY_CONFIG_DIR: '/config',
        MY_API_KEY: 'secret-value',
        UNRELATED: 'nope',
      }),
      requirements: { baseNames: ['MY_CONFIG_DIR'], credentialNames: ['MY_API_KEY'] },
    });
    expect(result).toEqual({ PATH: '/bin', MY_CONFIG_DIR: '/config', MY_API_KEY: 'secret-value' });
  });

  it('supports a `*`-suffixed prefix pattern in requirements', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', FOO_ONE: '1', FOO_TWO: '2', BAR: 'nope' }),
      requirements: { baseNames: ['FOO_*'] },
    });
    expect(result).toEqual({ PATH: '/bin', FOO_ONE: '1', FOO_TWO: '2' });
  });

  it('adds locallyAllowedNames (the per-device operator override) on top of everything else', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', OPERATOR_ALLOWED_VAR: 'yes', OTHER: 'no' }),
      locallyAllowedNames: ['OPERATOR_ALLOWED_VAR'],
    });
    expect(result).toEqual({ PATH: '/bin', OPERATOR_ALLOWED_VAR: 'yes' });
  });

  it('hard-denies BYOK_* even when explicitly listed in requirements.baseNames', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', BYOK_CONTROL_SECRET: 'must-not-leak' }),
      requirements: { baseNames: ['BYOK_CONTROL_SECRET'] },
    });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('hard-denies BYOK_* even when explicitly listed in requirements.credentialNames', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', BYOK_CONTROL_SECRET: 'must-not-leak' }),
      requirements: { credentialNames: ['BYOK_CONTROL_SECRET'] },
    });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('hard-denies BYOK_* even when explicitly listed in locallyAllowedNames (the operator override cannot punch a hole in it)', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', BYOK_CONTROL_SECRET: 'must-not-leak' }),
      locallyAllowedNames: ['BYOK_CONTROL_SECRET'],
    });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('hard-denies any BYOK_*-prefixed name, not just an exact BYOK_ literal', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', BYOK_STORE_DIR: '/secret/store', BYOK_ANYTHING: 'x' }),
      locallyAllowedNames: ['BYOK_STORE_DIR', 'BYOK_ANYTHING'],
    });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('never mutates the ambient object passed in', () => {
    const env = ambient({ PATH: '/bin', SECRET: 'x' });
    const before = { ...env };
    buildRuntimeEnv({ ambient: env, requirements: { baseNames: ['SECRET'] } });
    expect(env).toEqual(before);
  });

  it('returns a fresh object each call, not a reference to ambient', () => {
    const env = ambient({ PATH: '/bin' });
    const result = buildRuntimeEnv({ ambient: env });
    expect(result).not.toBe(env);
  });

  it('skips a variable whose ambient value is undefined', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', GHOST: undefined };
    const result = buildRuntimeEnv({ ambient: env, requirements: { baseNames: ['GHOST'] } });
    expect(result).toEqual({ PATH: '/bin' });
  });

  it('excludes an unrelated variable that matches none of the allow layers', () => {
    const result = buildRuntimeEnv({
      ambient: ambient({ PATH: '/bin', DATABASE_URL: 'postgres://leak' }),
      requirements: { credentialNames: ['SOME_OTHER_KEY'] },
    });
    expect(result).toEqual({ PATH: '/bin' });
  });
});
