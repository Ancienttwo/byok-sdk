import { afterEach, expect, it, vi } from 'vitest';

// The Windows process-table read runs PowerShell through `execFile`; this test answers for it.
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile }));

const { mayStopForeignHermesGateway } = await import('../adapters/hermes/gateway-ownership');

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const systemRoot = process.env.SystemRoot;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
  execFile.mockReset();
});

it('stops a foreign gateway on Windows when its kernel pid runs below the owned viewer', async () => {
  // Run the Windows branch on any host.
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
  // viewer launcher 100 -> hermes.exe 200 -> gateway 300; 400 is outside the viewer's tree
  execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '4 0 10\r\n100 4 100\r\n200 100 200\r\n300 200 300\r\n400 4 400\r\n'));
  expect(await mayStopForeignHermesGateway({ pid: 300, state: 'ready', servedHomes: [] }, 'C:\\root\\profiles\\byok-a', 100)).toBe(true);
  expect(await mayStopForeignHermesGateway({ pid: 400, state: 'ready', servedHomes: [] }, 'C:\\root\\profiles\\byok-a', 100)).toBe(false);
  expect(execFile).toHaveBeenCalledTimes(2);
});
