import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createDaemonWithAdapters, type AgentEgressPolicy } from '@byok-sdk/client';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import { createBotPersonaProjection } from './persona';

/** Device B has SDK runtime and persona handling only. It owns no Host or ledger. */
export async function enrollSecondDevice(serverUrl: string, code: string, root: string, policy: AgentEgressPolicy) {
  const adapter = new BotStubAdapter();
  const config = { productId: 'k8b-test', productName: 'K8b second device', localAgentRelease: { version: '0.0.0-test' },
    machineId: async () => createHash('sha256').update(root).digest('hex'), serverUrl, storeDir: join(root, 'sdk'),
    agentHome: { hostStorageRoot: join(root, 'homes'), projection: createBotPersonaProjection() },
    agentEgress: { policy } };
  const credentials = new InMemoryDeviceCredentialStore();
  let daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials });
  const { deviceId } = await daemon.pair(code);
  await daemon.start(); await waitForReady(daemon);
  return { root, deviceId, adapter, get daemon() { return daemon; },
    async offline() { await daemon.stop(); },
    async online() {
      daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials });
      await daemon.start(); await waitForReady(daemon);
    },
    async close() { await daemon.stop(); },
  };
}
