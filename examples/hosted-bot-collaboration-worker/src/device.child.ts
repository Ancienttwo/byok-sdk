/**
 * One device as its own OS process: its own pairing (enrollment), SDK store dir, workspace and Agent home, and a synthetic
 * runtime (the K8 stub adapter). The test process drives it over the Node IPC channel:
 *
 * - `{ type: 'pair', serverUrl, code, root }` pairs, starts the daemon and answers `{ type: 'ready', deviceId }`;
 * - each new runtime session is reported as `{ type: 'started', taskId, agentId }`;
 * - `{ type: 'finish', taskId, document }` ends that session with the result document (the stub's `submit_result` call),
 *   answered by `{ type: 'finished', taskId }`;
 * - `{ type: 'stop' }` stops the daemon, then the process exits.
 *
 * Errors go back as `{ type: 'error', message }`. The machine identity is synthetic (a hash of the root), so two of these
 * on one computer are two devices to the SDK, not two computers.
 */
import { createHash } from 'node:crypto';
import { createDeviceSession, deviceConfig, type DeviceEvent } from './device-session.js';
import { InMemoryDeviceCredentialBackend } from '@byok-sdk/client/testing';

export type ParentMessage =
  | { type: 'pair'; serverUrl: string; code: string; root: string }
  | { type: 'finish'; taskId: string; document: unknown }
  | { type: 'stop' };
export type ChildMessage = DeviceEvent;

const send = (message: ChildMessage) => { process.send?.(message); };
let device: ReturnType<typeof createDeviceSession> | undefined;

process.on('message', (message: ParentMessage) => {
  void (async () => {
    if (message.type === 'pair') {
      device = createDeviceSession({ ...deviceConfig(message.serverUrl, message.root),
        localAgentRelease: { version: '0.0.0-test' },
        machineId: async () => createHash('sha256').update(message.root).digest('hex'),
      }, 'stub', send, { deviceCredentials: new InMemoryDeviceCredentialBackend() });
      await device.pair(message.code);
    } else if (message.type === 'finish') {
      if (!device) throw new Error('device is not paired');
      await device.finish(message.taskId, message.document);
    } else if (message.type === 'stop') {
      await device?.stop();
      process.exit(0);
    }
  })().catch(error => { send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) }); });
});
