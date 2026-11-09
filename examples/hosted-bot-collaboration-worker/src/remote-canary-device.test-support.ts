/** Example-private hc transport. Operator credentials and member keys stay in the driver process. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TenantId } from '@byok-sdk/cloud';
import type { CanaryCloud } from '../../hosted-bot-collaboration/src/canary-cloud.test-support';
import { HostedMember } from '../../hosted-bot-collaboration/src/e2ee-member.test-support';
import type { DeviceCommand, DeviceEvent } from './device-session.js';

export interface RemoteDeviceConfig { machine: string; cwd: string; root: string }
const exec = promisify(execFile);
export async function canaryHc(args: string[]): Promise<string> {
  try { return (await exec('hc', args, { timeout: 70_000, maxBuffer: 1_000_000 })).stdout; }
  catch { throw new Error('canary device transport failed'); }
}

export async function openRemoteCanaryDevice(cloud: CanaryCloud, tenant: TenantId, base: string,
  config: RemoteDeviceConfig, hc = canaryHc) {
  async function call<T>(args: string[]): Promise<T> {
    try { return JSON.parse(await hc(args)) as T; }
    catch { throw new Error('canary device transport returned no valid response'); }
  }
  const member = await HostedMember.create(cloud, tenant);
  const { code } = await cloud.createPairingCode(tenant, { productId: 'hosted-collaboration-worker' });
  const { address } = await call<{ address: string }>(['run', '--bg', '--json', '--no-notify', '--on', config.machine, '--cwd', config.cwd,
    'node', '--import', 'tsx', 'examples/hosted-bot-collaboration-worker/src/device-runner.ts',
    '--server-url', base, '--pairing-code', code, '--verification-secret', member.verificationSecret,
    '--root', config.root, '--runtime', 'stub']);
  const send = (command: DeviceCommand) => hc(['send', address, JSON.stringify(command)]);
  async function event(type: DeviceEvent['type'], taskId?: string): Promise<DeviceEvent> {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const { text } = await call<{ text: string }>(['read', '--json', '--lines', '1000', address]);
      // hc's PTY also contains echoed stdin and SDK stderr. Only runner metadata is an event.
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        let value: DeviceEvent & { runtime?: string };
        try { value = JSON.parse(line); } catch { continue; }
        if (value.runtime !== 'stub') continue;
        if (value.type === 'error') throw new Error('remote canary device reported failure');
        if (value.type === type && (taskId === undefined || ('taskId' in value && value.taskId === taskId))) return value;
      }
      const state = await call<{ state: string }>(['get', '--json', address]);
      if (state.state === 'finished') throw new Error('remote canary device exited before its event');
      await hc(['wait', '--json', '--timeout', '1', '--output', `"type":"${type}"`, address]);
    }
    throw new Error('remote canary device event timed out');
  }
  async function close() {
    try {
      await send({ type: 'stop' });
      const state = await call<{ ended: boolean; exit_code: number | null }>(['wait', '--json', '--timeout', '10', address]);
      if (!state.ended || state.exit_code !== 0) throw new Error('remote canary device did not stop cleanly');
    } finally {
      await hc(['kill', address]);
      await hc(['rm', address]);
    }
  }
  try {
    const paired = await event('paired');
    if (paired.type !== 'paired') throw new Error('remote canary pairing event missing');
    const deviceId = paired.deviceId;
    await member.putScope('scope-zero-hit', await member.approve(deviceId), ['task-input', 'task-output']);
    const ready = await event('ready');
    if (ready.type !== 'ready' || ready.deviceId !== deviceId) throw new Error('remote canary device identity changed');
    return { deviceId, member, close,
      async begin(taskId: string, text: string, sealed: boolean) {
        await event('started', taskId);
        await send({ type: 'canary', taskId, text, sealed });
      },
      async finish(taskId: string) { await event('finished', taskId); },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
