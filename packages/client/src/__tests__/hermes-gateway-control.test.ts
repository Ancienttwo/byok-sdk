import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hermesGatewayPipeName, identifyHermesGateway, servesHermesHome } from '../adapters/hermes/gateway-identity';
import { mayStopForeignHermesGateway } from '../adapters/hermes/gateway-ownership';
import { loadKoffi } from '../adapters/win32-job-object';
import { descendsFrom, parseWindowsProcessTable, type WindowsProcessEntry } from '../adapters/hermes/windows-process-table';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe('Hermes gateway control pipe name', () => {
  // Reference values: Hermes's own `_home_hash` (`os.path.normcase`, SHA-256, 16 hex digits).
  // The first one was computed by Python on windows-latest for that runner's real temp home.
  it('matches Hermes windows_pipe_name for the same home', () => {
    for (const home of [
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bh-ur5bsI',
      'C:/Users/runneradmin/AppData/Local/Temp/bh-ur5bsI',
      'C:\\USERS\\RUNNERADMIN\\APPDATA\\LOCAL\\TEMP\\BH-UR5BSI',
    ]) expect(hermesGatewayPipeName(home)).toBe('\\\\.\\pipe\\hermes-gateway-0fcd86a0de1913e4');
    expect(hermesGatewayPipeName('D:\\a\\_temp\\profiles\\byok-空間')).toBe('\\\\.\\pipe\\hermes-gateway-e781593f5d5140d8');
  });

  it('compares served homes without case only on Windows', () => {
    const identity = { pid: 1, state: 'ready', servedHomes: ['C:\\Root\\profiles\\byok-a'] };
    expect(servesHermesHome(identity, 'C:\\Root\\profiles\\byok-a')).toBe(true);
    expect(servesHermesHome(identity, 'c:\\root\\profiles\\byok-a')).toBe(process.platform === 'win32');
    expect(servesHermesHome(identity, 'C:\\Root\\profiles\\byok-b')).toBe(false);
  });

  // #712: letters whose lower case is longer than one UTF-16 unit (U+0130) or depends on the
  // next letter (a final U+03A3). Hermes 0b10b9f hashes os.path.normcase(home)
  // (gateway/control_socket.py:40-41). On Windows, CPython 3.11 to 3.14 (Hermes needs >=3.11,<3.15)
  // ntpath.normcase is `_winapi.LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, s.replace('/', '\\'))`.
  it.runIf(process.platform === 'win32')('names the pipe Hermes names when a home has U+0130 or a final U+03A3', async () => {
    const koffi = await loadKoffi() as {
      load(path: string): { func(convention: string, name: string, result: string, args: string[]): (...args: unknown[]) => number };
    };
    // LCMapStringEx(lpLocaleName, dwMapFlags, lpSrcStr, cchSrc, lpDestStr, cchDest, lpVersionInformation, lpReserved, sortHandle)
    const lcMapStringEx = koffi.load('kernel32.dll').func('__stdcall', 'LCMapStringEx', 'int',
      ['str16', 'uint32_t', 'void *', 'int', 'void *', 'int', 'void *', 'void *', 'intptr_t']);
    const LCMAP_LOWERCASE = 0x100;
    const normcase = (home: string): string => {
      const source = Buffer.from(home.replaceAll('/', '\\'), 'utf16le');
      const target = Buffer.alloc(source.length * 2);
      // LOCALE_NAME_INVARIANT is the empty string.
      const written = lcMapStringEx('', LCMAP_LOWERCASE, source, source.length / 2, target, target.length / 2, null, null, 0);
      expect(written).toBeGreaterThan(0);
      return target.subarray(0, written * 2).toString('utf16le');
    };
    const escaped = (text: string): string => text.replace(/[^\x20-\x7e]/gu, (letter) => `\\u{${letter.codePointAt(0)!.toString(16)}}`);
    for (const home of ['C:\\Users\\\u0130lker\\hermes', 'C:\\Users\\\u039A\u03A9\u03A3\\hermes']) {
      const lowered = normcase(home);
      const hermes = `\\\\.\\pipe\\hermes-gateway-${createHash('sha256').update(lowered, 'utf8').digest('hex').slice(0, 16)}`;
      expect(hermesGatewayPipeName(home), `Windows normcase: ${escaped(lowered)}; JS toLowerCase: ${escaped(home.toLowerCase())}`).toBe(hermes);
    }
  });
});

describe('Hermes gateway ownership on Windows', () => {
  const entry = (parent: number, created: bigint): WindowsProcessEntry => ({ parent, created });

  it('parses the process table and skips lines that are not pid, parent and creation time', () => {
    const table = parseWindowsProcessTable('10 4 134371008096388500\r\n20 10 134371008121945180\r\n\r\nWARNING: x\r\n30 20 0\r\n');
    expect([...table]).toEqual([[10, entry(4, 134371008096388500n)], [20, entry(10, 134371008121945180n)], [30, entry(20, 0n)]]);
  });

  it('accepts a gateway below the spawned pid, through a console-script launcher and a custody launcher', () => {
    // custody launcher 10 -> hermes.exe 20 -> venv python 30 -> interpreter 40
    const table = new Map([[4, entry(1, 100n)], [10, entry(4, 200n)], [20, entry(10, 300n)], [30, entry(20, 400n)], [40, entry(30, 500n)]]);
    expect(descendsFrom(table, 10, 40)).toBe(true);
    expect(descendsFrom(table, 20, 40)).toBe(true);
    expect(descendsFrom(table, 30, 40)).toBe(true);
    expect(descendsFrom(table, 40, 30)).toBe(false);
    expect(descendsFrom(table, 99, 40)).toBe(false);
  });

  it('stops a foreign gateway on POSIX only when it serves the profile, and on Windows only below the owned viewer', async () => {
    const identity = { pid: 2_000_000_000, state: 'ready', servedHomes: ['/root/profiles/byok-a'] };
    if (process.platform === 'win32') {
      expect(await mayStopForeignHermesGateway(identity, '/root/profiles/byok-a', undefined)).toBe(false);
      expect(await mayStopForeignHermesGateway(identity, '/root/profiles/byok-a', process.pid)).toBe(false);
    } else {
      expect(await mayStopForeignHermesGateway(identity, '/root/profiles/byok-a', undefined)).toBe(true);
      expect(await mayStopForeignHermesGateway(identity, '/root/profiles/byok-b', undefined)).toBe(false);
    }
  }, 30_000); // Windows: a cold process-table read takes seconds.

  it('refuses a reused parent pid, a missing parent, an unknown creation time and a chain deeper than four links', () => {
    // pid 10 was reused by a process created after its supposed child 20
    expect(descendsFrom(new Map([[10, entry(4, 900n)], [20, entry(10, 300n)]]), 10, 20)).toBe(false);
    expect(descendsFrom(new Map([[20, entry(10, 300n)]]), 10, 20)).toBe(false);
    expect(descendsFrom(new Map([[10, entry(4, 0n)], [20, entry(10, 300n)]]), 10, 20)).toBe(false);
    expect(descendsFrom(new Map([[10, entry(4, 200n)], [20, entry(10, 0n)]]), 10, 20)).toBe(false);
    expect(descendsFrom(new Map([[99, entry(1, 1n)]]), 1, 50)).toBe(false);
    const deep = new Map([[1, entry(0, 10n)], [2, entry(1, 20n)], [3, entry(2, 30n)], [4, entry(3, 40n)], [5, entry(4, 50n)], [6, entry(5, 60n)]]);
    expect(descendsFrom(deep, 2, 6)).toBe(true);
    expect(descendsFrom(deep, 1, 6)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('Hermes gateway pipe client on Windows', () => {
  /** A pipe server in this process, so the kernel names this pid as its server. */
  async function serve(answer: (request: string) => string): Promise<{ home: string; received: string[] }> {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-')));
    const received: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        received.push(String(chunk));
        if (buffer.includes('\n')) socket.end(answer(buffer));
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(hermesGatewayPipeName(home), resolve));
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(home, { recursive: true, force: true });
    });
    return { home, received };
  }
  const ready = (pid: number, home: string) => `${JSON.stringify({ ok: true, result: { pid, state: 'ready', served_profiles: [{ home }] } })}\n`;

  it('writes nothing to a server the caller does not own and reports the kernel pid', async () => {
    const { home, received } = await serve(() => ready(process.pid, 'x'));
    expect(await identifyHermesGateway(home)).toEqual({ pid: process.pid, state: 'unverified', servedHomes: [] });
    expect(await identifyHermesGateway(home, { owned: (pid) => pid !== process.pid })).toEqual({ pid: process.pid, state: 'unverified', servedHomes: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
  });

  it('asks an owned server identify and keeps an answer that names the kernel pid', async () => {
    const { home, received } = await serve(() => ready(process.pid, 'C:\\served'));
    expect(await identifyHermesGateway(home, { owned: (pid) => pid === process.pid }))
      .toEqual({ pid: process.pid, state: 'ready', servedHomes: ['C:\\served'] });
    expect(received.join('')).toBe('{"protocol":1,"id":1,"verb":"identify"}\n');
  });

  it('marks an answer that names another pid than the kernel as a mismatch, under the kernel pid', async () => {
    const { home } = await serve(() => ready(process.pid + 100_000, 'C:\\served'));
    expect(await identifyHermesGateway(home, { owned: (pid) => pid === process.pid }))
      .toEqual({ pid: process.pid, state: 'mismatch', servedHomes: [] });
  });

  it('reports no gateway when nothing serves the pipe', async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-')));
    cleanup.push(() => fs.rm(home, { recursive: true, force: true }));
    expect(await identifyHermesGateway(home, { owned: () => true })).toBeUndefined();
  });
});
