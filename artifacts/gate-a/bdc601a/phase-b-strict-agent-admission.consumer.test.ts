import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryByokCloud, tenantId } from '@byok-sdk/cloud';
import { createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import { buildDaemonConfig } from '../daemon.ts';
import { loadLocalAgentConfig } from '../config.ts';

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

async function assertStrictProducerGate(variant: 'task.offer' | 'task.offer_with_toolsets'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'salesko-gate-a-phase-b-'));
  const workspaceRoot = join(root, 'workspaces');
  mkdirSync(workspaceRoot, { recursive: true });
  const { cloud } = createInMemoryByokCloud({ longPollHoldMs: 100, longPollIntervalMs: 10 });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request: Request) => cloud.fetch(request) });
  const tenant = tenantId(`gate-a-phase-b-${variant.replaceAll('.', '-')}`);
  const config = loadLocalAgentConfig({
    SALESKO_LOCAL_AGENT_SERVER_URL: `http://127.0.0.1:${server.port}`,
    SALESKO_LOCAL_AGENT_STORE_DIR: join(root, 'state'),
    SALESKO_LOCAL_AGENT_WORKSPACE_ROOT: workspaceRoot,
    SALESKO_LOCAL_AGENT_HOST_STORAGE_ROOT: join(root, 'home'),
    SALESKO_LOCAL_AGENT_DEVICE_NAME: 'gate-a-phase-b',
    SALESKO_LOCAL_AGENT_PRODUCT_ID: `salesko-gate-a-phase-b-${Date.now()}`,
  });
  let daemon: Daemon | undefined;
  const taskId = `phase-b-${variant.replaceAll('.', '-')}`;

  try {
    daemon = createDaemonWithAdapters({ ...buildDaemonConfig(config), strictAgentOnly: true }, []);
    const pairing = await cloud.createPairingCode(tenant, { productId: config.productId });
    const device = await daemon.pair(pairing.code);
    await daemon.start();
    await waitFor(async () => {
      const registered = await cloud.listDevices(tenant);
      return registered.some((entry) =>
        entry.deviceId === device.deviceId && entry.capabilities?.includes('strict-agent-only'),
      ) ? true : undefined;
    }, 'durable strict-agent-only capability');

    const dispatch = variant === 'task.offer'
      ? cloud.enqueueOffer(tenant, device.deviceId, {
          taskId,
          payload: { instruction: 'legacy must be rejected', policy: { mode: 'readonly' } },
        })
      : cloud.enqueueToolsetOffer(tenant, device.deviceId, {
          taskId,
          payload: {
            instruction: 'legacy toolset must be rejected',
            policy: { mode: 'readonly' },
            requiredToolsets: [],
          },
        });
    await expect(dispatch).rejects.toThrow(/strict-agent-only/);
    expect(await cloud.readTaskAttempt(tenant, taskId)).toBeUndefined();
  } finally {
    await daemon?.stop();
    await daemon?.unpair();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test('Phase B exact tarballs advertise strict mode and reject legacy task.offer before durable task creation', async () => {
  await assertStrictProducerGate('task.offer');
}, 30_000);

test('Phase B exact tarballs advertise strict mode and reject legacy task.offer_with_toolsets before durable task creation', async () => {
  await assertStrictProducerGate('task.offer_with_toolsets');
}, 30_000);
