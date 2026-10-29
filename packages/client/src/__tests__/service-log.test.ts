import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const SERVICE_LOG_SOURCE = fileURLToPath(new URL('../lifecycle/service-log.ts', import.meta.url));
const CLIENT_SOURCE = fileURLToPath(new URL('..', import.meta.url));

describe('lifecycle/service-log (#1097): --service process output', () => {
  it('routes every console and stream write into the rotating daemon log; the real stdout/stderr stay empty', async () => {
    // A child process, so the writes hit its real fd 1/2 (the service manager's redirect) unless routed.
    const script = `
      const { routeProcessOutputToDaemonLog } = await import(${JSON.stringify(pathToFileURL(SERVICE_LOG_SOURCE).href)});
      const sink = routeProcessOutputToDaemonLog({ logDir: process.argv[1], maxBytes: 64, maxFiles: 8 });
      console.log('log'); console.info('info'); console.debug('debug'); console.warn('warn'); console.error('error');
      process.stdout.write('stdout\\n'); process.stderr.write(Buffer.from('stderr\\n'));
      await new Promise((resolve) => process.stdout.write('callback\\n', resolve));
      for (let index = 0; index < 10; index += 1) console.warn('heartbeat-' + index);
      sink.close();
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, logDir], { encoding: 'utf8', timeout: 30_000 });

    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('');
    expect(run.status).toBe(0);
    const files = (await fs.readdir(logDir)).filter((name) => name.startsWith(DAEMON_LOG_FILENAME));
    // Rotated by size while the process ran.
    expect(files.length).toBeGreaterThan(1);
    for (const size of Object.values(await sizes())) expect(size).toBeLessThanOrEqual(64);
    const copyIndex = (name: string): number => (name === DAEMON_LOG_FILENAME ? 0 : Number(name.slice(DAEMON_LOG_FILENAME.length + 1)));
    const oldestFirst = files.sort((a, b) => copyIndex(b) - copyIndex(a));
    let content = '';
    for (const name of oldestFirst) content += await fs.readFile(path.join(logDir, name), 'utf8');
    const heartbeats = Array.from({ length: 10 }, (_, index) => `heartbeat-${index}\n`).join('');
    expect(content).toBe(`log\ninfo\ndebug\nwarn\nerror\nstdout\nstderr\ncallback\n${heartbeats}`);
  });

  it('no client source writes to fd 1/2 directly or lets a child inherit them, which would bypass the routing', async () => {
    const bypass = /writeSync\(\s*[12]\s*[,)]|process\.(?:stdout|stderr)\.fd\b|stdio:\s*(?:'inherit'|\[[^\]]*'inherit')|\/dev\/std(?:out|err)/;
    const offenders: string[] = [];
    for (const entry of await fs.readdir(CLIENT_SOURCE, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (bypass.test(await fs.readFile(file, 'utf8'))) offenders.push(path.relative(CLIENT_SOURCE, file));
    }
    expect(offenders).toEqual([]);
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
