import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { daemonExitCode, EXIT_CODE_CONTRACT, serviceExitDisposition } from '../lifecycle/exit-codes';
import { generateLaunchdPlist } from '../lifecycle/launchd';
import { generateSystemdUnit } from '../lifecycle/systemd';
import { generateWinswXml } from '../lifecycle/winsw';
import { DAEMON_HALT_REASONS } from '../daemon/daemon-lifecycle';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * Every numeric exit status the executables use: `process.exit(N)`,
 * `process.exitCode = N`, and the `*EXIT*` constants they pass instead.
 */
function exitCodesInSource(): Map<number, string[]> {
  const found = new Map<number, string[]>();
  const patterns = [/process\.exit\((\d+)\)/g, /process\.exitCode\s*=\s*(\d+)/g, /\b[A-Z_]*EXIT[A-Z_]*\s*=\s*(\d+)\b/g];
  for (const file of [...sourceFiles(path.join(SRC, 'bin')), path.join(SRC, 'lifecycle', 'exit-codes.ts')]) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const code = Number(match[1]);
        found.set(code, [...(found.get(code) ?? []), path.relative(SRC, file)]);
      }
    }
  }
  return found;
}

/** A `StartOutcome` halt, as `start` returns it. */
function halted(reason: (typeof DAEMON_HALT_REASONS)[number]): { kind: 'halted'; reason: string } {
  return { kind: 'halted', reason };
}

describe('lifecycle/exit-codes (#1097): the exit-code contract', () => {
  it('classifies every exit status the source uses as restart or stop', () => {
    const found = exitCodesInSource();
    expect(found.size).toBeGreaterThan(0);
    for (const [code, files] of found) {
      expect(Object.hasOwn(EXIT_CODE_CONTRACT, code), `exit ${code} in ${files.join(', ')} has no EXIT_CODE_CONTRACT entry`).toBe(true);
    }
    for (const [code, entry] of Object.entries(EXIT_CODE_CONTRACT)) expect(serviceExitDisposition(Number(code))).toBe(entry.service);
  });

  it('only 0 stops a service; a signal or unknown status restarts', () => {
    expect(serviceExitDisposition(0)).toBe('stop');
    for (const code of [1, 2, 78, 137, 143, 255]) expect(serviceExitDisposition(code)).toBe('restart');
  });

  it('start --service exits only 0 (stop, halt) — a crash throws and exits 1', () => {
    expect(daemonExitCode({ kind: 'stopped' }, true)).toBe(0);
    expect(daemonExitCode({ kind: 'stopped' }, false)).toBe(0);
    for (const reason of DAEMON_HALT_REASONS) {
      expect(daemonExitCode(halted(reason), true)).toBe(0);
      expect(daemonExitCode(halted(reason), false)).toBe(78);
    }
  });

  it('every generated unit encodes the same contract', () => {
    expect(generateLaunchdPlist({ label: 'x', launcherPath: '/l.sh', workingDirectory: '/h', logDir: '/logs' }))
      .toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
    expect(generateSystemdUnit({ name: 'x', displayName: 'X', launcherPath: '/l.sh', workingDirectory: '/h', logDir: '/logs' }))
      .toContain('Restart=always\nRestartPreventExitStatus=0\n');
    // WinSW fires <onfailure> on a non-zero exit only.
    expect(generateWinswXml({ id: 'x', displayName: 'X', program: { command: 'node', args: [] }, logDir: 'C:\\logs' }))
      .toContain('<onfailure action="restart" delay="10 sec"/>');
  });
});
