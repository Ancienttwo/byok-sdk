import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boundServiceRedirectLogs,
  DAEMON_LOG_FILENAME,
  inspectServiceLogs,
  openDaemonLog,
  SERVICE_REDIRECT_LIMITS,
  SERVICE_REDIRECT_STDERR_FILENAME,
  SERVICE_REDIRECT_STDOUT_FILENAME,
} from '../lifecycle/service-log';

let logDir: string;
beforeEach(async () => {
  logDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-service-log-')), 'logs');
});
afterEach(async () => {
  await fs.rm(path.dirname(logDir), { recursive: true, force: true });
});

async function sizes(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of (await fs.readdir(logDir)).sort()) out[name] = (await fs.stat(path.join(logDir, name))).size;
  return out;
}

describe('lifecycle/service-log (#1097): daemon log rotation', () => {
  it('rotates by size and keeps at most maxFiles files, newest copy first', async () => {
    const log = openDaemonLog({ logDir, maxBytes: 20, maxFiles: 3 });
    for (let index = 0; index < 10; index += 1) log.write(`line-${index}-xxxx`); // 12 bytes each
    log.close();

    expect(Object.keys(await sizes())).toEqual([DAEMON_LOG_FILENAME, `${DAEMON_LOG_FILENAME}.1`, `${DAEMON_LOG_FILENAME}.2`]);
    for (const size of Object.values(await sizes())) expect(size).toBeLessThanOrEqual(20);
    expect(await fs.readFile(path.join(logDir, DAEMON_LOG_FILENAME), 'utf8')).toBe('line-9-xxxx\n');
    expect(await fs.readFile(path.join(logDir, `${DAEMON_LOG_FILENAME}.1`), 'utf8')).toBe('line-8-xxxx\n');
  });

  it('appends to an existing log and counts its size before rotating', async () => {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, DAEMON_LOG_FILENAME), '0123456789012345\n');
    const log = openDaemonLog({ logDir, maxBytes: 20, maxFiles: 2 });
    log.write('next');
    log.close();
    expect(await fs.readFile(path.join(logDir, DAEMON_LOG_FILENAME), 'utf8')).toBe('next\n');
    expect(await fs.readFile(path.join(logDir, `${DAEMON_LOG_FILENAME}.1`), 'utf8')).toBe('0123456789012345\n');
  });

  it('maxFiles 1 truncates instead of keeping a copy', async () => {
    const log = openDaemonLog({ logDir, maxBytes: 10, maxFiles: 1 });
    log.write('aaaaaaaa');
    log.write('bbbbbbbb');
    log.close();
    expect(await sizes()).toEqual({ [DAEMON_LOG_FILENAME]: 9 });
  });

  it('rejects a non-positive limit', () => {
    expect(() => openDaemonLog({ logDir, maxBytes: 0 })).toThrow(RangeError);
    expect(() => openDaemonLog({ logDir, maxFiles: 0 })).toThrow(RangeError);
  });
});

describe('lifecycle/service-log (#1097): service manager redirect bound', () => {
  it('rotates an oversized redirect file to its single .1 copy and leaves a small one alone', async () => {
    await fs.mkdir(logDir, { recursive: true });
    const big = Buffer.alloc(SERVICE_REDIRECT_LIMITS.maxBytes + 1, 'x');
    await fs.writeFile(path.join(logDir, SERVICE_REDIRECT_STDERR_FILENAME), big);
    await fs.writeFile(path.join(logDir, `${SERVICE_REDIRECT_STDERR_FILENAME}.1`), 'older');
    await fs.writeFile(path.join(logDir, SERVICE_REDIRECT_STDOUT_FILENAME), 'small');

    boundServiceRedirectLogs(logDir);

    expect(await sizes()).toEqual({
      [SERVICE_REDIRECT_STDERR_FILENAME + '.1']: big.length,
      [SERVICE_REDIRECT_STDOUT_FILENAME]: 5,
    });
  });

  it('is a no-op for a missing directory', () => {
    expect(() => boundServiceRedirectLogs(logDir)).not.toThrow();
  });
});

describe('lifecycle/service-log (#1097): inspectServiceLogs', () => {
  it('reports location, total size and each file kind', async () => {
    expect(await inspectServiceLogs(logDir)).toEqual({ dir: logDir, status: 'missing', totalBytes: 0, files: [], truncated: false });
    const log = openDaemonLog({ logDir });
    log.write('hello');
    log.close();
    await fs.writeFile(path.join(logDir, SERVICE_REDIRECT_STDERR_FILENAME), 'boot crash\n');
    await fs.writeFile(path.join(logDir, 'unrelated.txt'), 'ignored');

    expect(await inspectServiceLogs(logDir)).toEqual({
      dir: logDir,
      status: 'present',
      totalBytes: 17,
      files: [
        { name: DAEMON_LOG_FILENAME, kind: 'daemon', sizeBytes: 6 },
        { name: SERVICE_REDIRECT_STDERR_FILENAME, kind: 'service-manager', sizeBytes: 11 },
      ],
      truncated: false,
    });
  });
});
