import { describe, expect, it } from 'vitest';
import { claudeAgentUserContextSettings } from '../adapters/claude/agent-user-context';
import { RuntimeExecutionFailure } from '../runtime-failure';

const lease = (canonicalHome: string) => ({ leaseId: 'lease-1', canonicalHome });
const unusedHomedir = () => { throw new Error('homedir fallback must not be read'); };
const same = (dir: string) => dir;
const parent = (dir: string) => [`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/.claude/CLAUDE.md`, `${dir}/.claude/rules/**`];
const AUTO_MEMORY_OFF = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

describe('claudeAgentUserContextSettings', () => {
  const home = '/Users/u/app/agents/a1';
  const expected = [
    '/Users/u/.claude/CLAUDE.md', '/Users/u/.claude/rules/**',
    ...parent('/Users/u/app/agents'),
    ...parent('/Users/u/app'),
    // `/Users/u/.claude/…` already came from the config directory.
    '/Users/u/CLAUDE.md', '/Users/u/CLAUDE.local.md',
    ...parent('/Users'),
  ];

  it('excludes the config directory and every parent of a POSIX home, but nothing at or below the home', () => {
    const settings = claudeAgentUserContextSettings({ lease: lease(home), cwd: home }, { HOME: '/Users/u' }, 'darwin', unusedHomedir, same);
    expect(settings).toEqual({ claudeMdExcludes: expected, env: AUTO_MEMORY_OFF });
    expect(settings.claudeMdExcludes.some(pattern => pattern.startsWith(`${home}/`))).toBe(false);
    // Claude's walk stops before the root.
    expect(settings.claudeMdExcludes.some(pattern => /^\/[^/]+$/.test(pattern) || pattern.startsWith('/.claude'))).toBe(false);
  });

  it('gives a memory reader in its run directory the same patterns, anchored on the home', () => {
    const settings = claudeAgentUserContextSettings({ lease: lease(home), cwd: `${home}/.byok/runs/t1` }, { HOME: '/Users/u' }, 'darwin', unusedHomedir, same);
    expect(settings.claudeMdExcludes).toEqual(expected);
  });

  it('follows CLAUDE_CONFIG_DIR and falls back to the injected home directory when HOME is unset', () => {
    const settings = claudeAgentUserContextSettings({ lease: lease('/srv/agents/a1'), cwd: '/srv/agents/a1' }, { CLAUDE_CONFIG_DIR: '/etc/claude (cfg)/' }, 'linux', () => '/home/x', same);
    expect(settings.claudeMdExcludes).toEqual([
      '/etc/claude (cfg)/CLAUDE.md', '/etc/claude ?cfg?/rules/**',
      ...parent('/srv/agents'),
      ...parent('/srv'),
    ]);
    const fallback = claudeAgentUserContextSettings({ lease: lease('/srv/agents/a1'), cwd: '/srv/agents/a1' }, {}, 'linux', () => '/home/x', same);
    expect(fallback.claudeMdExcludes.slice(0, 2)).toEqual(['/home/x/.claude/CLAUDE.md', '/home/x/.claude/rules/**']);
  });

  it('keeps a config directory that lies inside the Agent home', () => {
    const settings = claudeAgentUserContextSettings({ lease: lease('/srv/agents/a1'), cwd: '/srv/agents/a1' }, { CLAUDE_CONFIG_DIR: '/srv/agents/a1/.claude' }, 'linux', unusedHomedir, same);
    expect(settings.claudeMdExcludes).toEqual([...parent('/srv/agents'), ...parent('/srv')]);
  });

  it('keeps a config directory whose real path lies inside the Agent home', () => {
    const realpath = (dir: string) => dir === '/etc/claude-link' ? '/srv/agents/a1/.claude' : dir;
    const settings = claudeAgentUserContextSettings({ lease: lease('/srv/agents/a1'), cwd: '/srv/agents/a1' }, { CLAUDE_CONFIG_DIR: '/etc/claude-link' }, 'linux', unusedHomedir, realpath);
    expect(settings.claudeMdExcludes).toEqual([...parent('/srv/agents'), ...parent('/srv')]);
  });

  it('replaces glob syntax with ? in the directory part of a rules pattern only', () => {
    const settings = claudeAgentUserContextSettings({ lease: lease('/srv/brk [1]/brace {a,b}/star*q?!@+|^$/a1'), cwd: '/srv/brk [1]/brace {a,b}/star*q?!@+|^$/a1' }, { HOME: '/home/x' }, 'linux', unusedHomedir, same);
    expect(settings.claudeMdExcludes).toEqual([
      '/home/x/.claude/CLAUDE.md', '/home/x/.claude/rules/**',
      '/srv/brk [1]/brace {a,b}/star*q?!@+|^$/CLAUDE.md', '/srv/brk [1]/brace {a,b}/star*q?!@+|^$/CLAUDE.local.md',
      '/srv/brk [1]/brace {a,b}/star*q?!@+|^$/.claude/CLAUDE.md', '/srv/brk ?1?/brace ?a,b?/star?q???????/.claude/rules/**',
      '/srv/brk [1]/brace {a,b}/CLAUDE.md', '/srv/brk [1]/brace {a,b}/CLAUDE.local.md',
      '/srv/brk [1]/brace {a,b}/.claude/CLAUDE.md', '/srv/brk ?1?/brace ?a,b?/.claude/rules/**',
      '/srv/brk [1]/CLAUDE.md', '/srv/brk [1]/CLAUDE.local.md', '/srv/brk [1]/.claude/CLAUDE.md', '/srv/brk ?1?/.claude/rules/**',
      ...parent('/srv'),
    ]);
  });

  it('uses USERPROFILE and forward slashes for a win32 home, and stops before the drive root', () => {
    const winHome = 'C:\\Users\\u\\AppData\\Roaming\\App (x86)\\agents\\a1';
    const settings = claudeAgentUserContextSettings({ lease: lease(winHome), cwd: `${winHome}\\.byok\\runs\\t1` }, { USERPROFILE: 'C:\\Users\\u', HOME: '/ignored' }, 'win32', unusedHomedir, same);
    expect(settings).toEqual({
      claudeMdExcludes: [
        'C:/Users/u/.claude/CLAUDE.md', 'C:/Users/u/.claude/rules/**',
        'C:/Users/u/AppData/Roaming/App (x86)/agents/CLAUDE.md', 'C:/Users/u/AppData/Roaming/App (x86)/agents/CLAUDE.local.md',
        'C:/Users/u/AppData/Roaming/App (x86)/agents/.claude/CLAUDE.md', 'C:/Users/u/AppData/Roaming/App ?x86?/agents/.claude/rules/**',
        'C:/Users/u/AppData/Roaming/App (x86)/CLAUDE.md', 'C:/Users/u/AppData/Roaming/App (x86)/CLAUDE.local.md',
        'C:/Users/u/AppData/Roaming/App (x86)/.claude/CLAUDE.md', 'C:/Users/u/AppData/Roaming/App ?x86?/.claude/rules/**',
        ...parent('C:/Users/u/AppData/Roaming'),
        ...parent('C:/Users/u/AppData'),
        'C:/Users/u/CLAUDE.md', 'C:/Users/u/CLAUDE.local.md',
        ...parent('C:/Users'),
      ],
      env: AUTO_MEMORY_OFF,
    });
  });

  it.each([
    ['no lease', { cwd: home }, {}, 'darwin'],
    ['a lease without an id', { lease: { leaseId: '', canonicalHome: home }, cwd: home }, {}, 'darwin'],
    ['a relative home', { lease: lease('agents/a1'), cwd: home }, {}, 'darwin'],
    ['a home that is not normalized', { lease: lease('/Users/u/app/../app/agents/a1'), cwd: home }, {}, 'darwin'],
    ['no cwd', { lease: lease(home) }, {}, 'darwin'],
    ['a cwd outside the home', { lease: lease(home), cwd: '/Users/u/other' }, {}, 'darwin'],
    ['a cwd that only shares the home prefix', { lease: lease(home), cwd: `${home}0` }, {}, 'darwin'],
    ['a cwd above the home', { lease: lease(home), cwd: '/Users/u/app/agents' }, {}, 'darwin'],
    ['a cwd on another drive', { lease: lease('C:\\agents\\a1'), cwd: 'D:\\agents\\a1' }, { USERPROFILE: 'C:\\Users\\u' }, 'win32'],
    ['a relative CLAUDE_CONFIG_DIR', { lease: lease(home), cwd: home }, { HOME: '/Users/u', CLAUDE_CONFIG_DIR: 'cfg' }, 'darwin'],
    ['an empty CLAUDE_CONFIG_DIR', { lease: lease(home), cwd: home }, { HOME: '/Users/u', CLAUDE_CONFIG_DIR: '' }, 'darwin'],
  ] as const)('refuses %s as a non-retryable authority failure that names no path', (_label, manifest, env, platform) => {
    let failure: unknown;
    try { claudeAgentUserContextSettings(manifest, env, platform, () => '/Users/u', same); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
    const reason = (failure as Error).message;
    expect(reason).not.toMatch(/agents|Users|cfg|[A-Z]:\\/);
  });
});
