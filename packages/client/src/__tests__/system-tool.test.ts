import { describe, expect, it } from 'vitest';
import { runDeviceCommand } from '../daemon/device-credential-store';
import { defaultRunner } from '../util/exec-runner';
import { resolveSystemTool, SystemToolUnavailableError, type SystemToolHost } from '../util/system-tool';

function fakeHost(platform: NodeJS.Platform, files: readonly string[], systemRoot?: string): SystemToolHost & { probed: string[] } {
  const probed: string[] = [];
  return { platform, systemRoot, probed, isFile: (file) => (probed.push(file), files.includes(file)) };
}

function failure(tool: string, host: SystemToolHost): unknown {
  try {
    resolveSystemTool(tool, host);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The tools each CI host must find at their trusted location. */
const HOST_TOOLS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['launchctl', 'ioreg'],
  linux: ['systemctl'],
  win32: ['taskkill', 'sc.exe', 'reg', 'icacls'],
};

describe('system tools start from a trusted location, never PATH (#1304)', () => {
  it('Linux takes the first fixed system directory that holds the tool', () => {
    const host = fakeHost('linux', ['/bin/systemctl', '/sbin/systemctl']);
    expect(resolveSystemTool('systemctl', host)).toBe('/bin/systemctl');
    expect(host.probed).toEqual(['/usr/bin/systemctl', '/bin/systemctl']);
  });

  it('Windows takes the tool from %SystemRoot%\\System32', () => {
    expect(resolveSystemTool('taskkill', fakeHost('win32', ['C:\\Windows\\System32\\taskkill.exe'], 'C:\\Windows'))).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it.each([
    ['is at none of its locations', 'secret-tool', fakeHost('linux', []), 'not found at /usr/bin/secret-tool, /bin/secret-tool, /usr/sbin/secret-tool, /sbin/secret-tool'],
    ['would resolve against a relative SystemRoot', 'reg', fakeHost('win32', ['Windows\\System32\\reg.exe'], 'Windows'), 'SystemRoot is not a drive-qualified absolute path'],
    ['has no location on the platform', 'launchctl', fakeHost('linux', ['/bin/launchctl']), 'it has no trusted location on linux'],
  ])('a tool that %s fails closed with the named error', (_case, tool, host, detail) => {
    const error = failure(tool, host);
    expect(error).toBeInstanceOf(SystemToolUnavailableError);
    expect(error).toMatchObject({ name: 'SystemToolUnavailableError', tool, message: `system tool ${tool} is unavailable: ${detail}` });
  });

  it('the real runners start nothing for a bare name without a trusted location', async () => {
    await expect(defaultRunner('byok-no-such-tool', [])).rejects.toMatchObject({ name: 'SystemToolUnavailableError', tool: 'byok-no-such-tool' });
    await expect(runDeviceCommand('byok-no-such-tool', [])).resolves.toEqual({ exitCode: 127, stdout: '', stderr: 'command unavailable' });
  });

  it.runIf(HOST_TOOLS[process.platform] !== undefined)('this host has every tool at its trusted location', () => {
    for (const tool of HOST_TOOLS[process.platform]!) expect(() => resolveSystemTool(tool)).not.toThrow();
  });
});
