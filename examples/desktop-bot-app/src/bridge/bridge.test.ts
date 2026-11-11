import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BridgeClient, type HostChild } from './client.ts';
import { BRIDGE_VERSION, encodeMessage } from './protocol.ts';

// Dev mode: the Host child runs under plain Node, as main spawns it.
const stubHost = (): HostChild =>
  spawn(process.execPath, [fileURLToPath(new URL('./stub-host.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] });

describe('desktop bridge', () => {
  it('connects to the dev Host under Node, reads status and shuts it down cleanly', async () => {
    const child = stubHost();
    const host = await BridgeClient.connect(child);
    expect(await host.call('status', undefined)).toEqual({ state: 'running', pid: child.pid });
    expect(await host.call('shutdown', undefined)).toBeNull();
    expect(await host.exited).toBe(0);
  });

  it('fails closed on a bridge version mismatch from either side', async () => {
    const host = stubHost();
    host.stdin.write(encodeMessage({ id: 1, method: 'hello', params: { bridgeVersion: BRIDGE_VERSION + 1 } }));
    const [line] = await once(createInterface({ input: host.stdout }), 'line') as [string];
    expect(JSON.parse(line)).toMatchObject({ id: 1, error: { code: 'bridge_version_mismatch' } });
    expect((await once(host, 'exit'))[0]).toBe(1);

    const script = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => process.stdout.write(
      JSON.stringify({ id: JSON.parse(line).id, result: { bridgeVersion: ${BRIDGE_VERSION + 1} } }) + '\\n'))`;
    const shell = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = once(shell, 'exit');
    await expect(BridgeClient.connect(shell)).rejects.toMatchObject({ code: 'bridge_version_mismatch' });
    expect((await exited)[1]).toBe('SIGTERM');
  });
});
