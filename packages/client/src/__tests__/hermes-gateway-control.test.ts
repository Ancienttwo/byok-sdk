import { describe, expect, it } from 'vitest';
import { hermesGatewayPipeName, servesHermesHome } from '../adapters/hermes/gateway-identity';
import { descendsFrom, parseWindowsProcessTable, type WindowsProcessEntry } from '../adapters/hermes/gateway-ownership';

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
