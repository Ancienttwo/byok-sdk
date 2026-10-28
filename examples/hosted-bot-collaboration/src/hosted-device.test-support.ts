/** The real daemon and member pairing shared by the Node and local workerd canaries. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentHomeProjectionConsumer, createDaemonWithAdapters } from '@byok-sdk/client';
import type { TenantId } from '@byok-sdk/cloud';
import type { FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { createTestKeychain } from '../../../scripts/testing/macos-keychain.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import type { CanaryCloud } from './canary-cloud.test-support';
import { HostedMember } from './e2ee-member.test-support';
import type { HostedCloudOptions } from './hosted-cloud.test-support';
import type { HostedTaskPort } from './reconcile';

export const PRODUCT_ID = 'hosted-collaboration-test';
export async function openHostedDevice(cloud: CanaryCloud, tenant: TenantId, serverUrl: string, options: HostedCloudOptions) {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-cloud-'));
  const close: (() => Promise<unknown>)[] = [];
  try {
    const adapter = options.adapter ?? new BotStubAdapter();
    let deviceCredentials: { macosKeychainPath: string } | undefined;
    if (options.e2ee !== undefined && process.platform === 'darwin') {
      const keychain = await createTestKeychain();
      close.push(() => keychain.dispose());
      deviceCredentials = { macosKeychainPath: keychain.path };
    }
    const daemon = createDaemonWithAdapters({ productId: PRODUCT_ID, productName: 'Hosted collaboration', localAgentRelease: { version: '0.0.0-test' },
      serverUrl, storeDir: path.join(root, 'sdk'),
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
      ...(deviceCredentials === undefined ? {} : { deviceCredentials }),
      // The Host's persona hook (#793 S13): it writes the Bot persona of a home projection, so the device applies a task-free
      // projection and advertises `agent-home-projection`.
      agentHome: { hostStorageRoot: path.join(root, 'homes'), projection: createAgentHomeProjectionConsumer(async ({ projection, writeHomeFile }) => {
        await writeHomeFile('AGENTS.md', String((projection as { persona?: unknown }).persona ?? ''));
      }) },
      agentEgress: { policy },
    }, [adapter], options.e2ee === undefined ? { deviceCredentials: new InMemoryDeviceCredentialStore() } : {});
    const { code } = await cloud.createPairingCode(tenant, { productId: PRODUCT_ID });
    const member = options.e2ee === undefined ? undefined : await HostedMember.create(cloud, tenant);
    const { deviceId } = await daemon.pair(code, member === undefined ? undefined : { verificationSecret: member.verificationSecret });
    if (member !== undefined) await member.putScope(options.e2ee!.scopeId, await member.approve(deviceId), options.e2ee!.categories);
    await daemon.start();
    close.unshift(() => daemon.stop());
    await waitForReady(daemon);

    /** The SDK calls of the tenant, as H binds them. */
    const port: FrozenSubmitPort & HostedTaskPort = {
      submit: input => cloud.submitAgentExecution(tenant, input),
      submitSealed: input => cloud.submitSealedAgentExecution(tenant, input),
      offer: taskId => cloud.readTaskOffer(tenant, taskId),
      attempt: taskId => cloud.readTaskAttempt(tenant, taskId),
      deviceTerminal: taskId => cloud.readDeviceTerminal(tenant, taskId),
      cancel: (taskId, reason) => cloud.cancelTask(tenant, taskId, reason),
    };
    return { deviceId, adapter, daemon, port, member, close: shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
  async function shutdown() {
    for (const step of close.splice(0)) await step().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
