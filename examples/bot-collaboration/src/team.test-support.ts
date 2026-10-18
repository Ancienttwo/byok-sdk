import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer } from '@byok-sdk/server';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import { HostLedger } from '../../host-execution-core/src/ledger';
import { policy, template } from '../../host-execution-core/src/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { createBotPersonaProjection } from './persona';

/** Real embedded server, HTTP, daemon, persona writes, and submit_result helper. */
export async function openTeam(options: { now?: () => number; holdProjection?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'k8b-'));
  const productId = 'k8b-test';
  let ledger = new HostLedger(join(root, 'host.sqlite'), `product:${productId}`);
  let host!: BotCollaboration;
  const server = createByokServer({ productId, storage: { kind: 'sqlite', path: join(root, 'server.sqlite') },
    agentMessage: { consume: async () => ({ outcome: 'accepted' }) },
    wake: { consume: (wake, signal) => host.consume(wake, signal) },
  });
  const http = serve({ fetch: server.hono.fetch, port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const adapter = new BotStubAdapter();
  const projection = createBotPersonaProjection();
  const daemon = createDaemonWithAdapters({ productId, productName: 'K8b', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: `http://127.0.0.1:${address.port}`, workspaceRoot: join(root, 'workspace'), storeDir: join(root, 'sdk'),
    agentHome: { hostStorageRoot: join(root, 'homes'), projection: {
      ...projection, apply: async input => { await options.holdProjection?.(); return projection.apply!(input); },
    } }, hostedJournal: { mode: 'sqlite' }, agentEgress: { policy },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  const pairing = await server.pairing.createPairingCode({ productId });
  const { deviceId } = await daemon.pair(pairing.code);
  const base = template(deviceId);
  const botOptions: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'k8b' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
    } }, connector: async id => ({ id }), now: options.now };
  host = new BotCollaboration(server, ledger, botOptions);
  await daemon.start(); await waitForReady(daemon);
  return { root, server, get ledger() { return ledger; }, daemon, adapter, deviceId, botOptions,
    get host() { return host; },
    async reopen() {
      await host.close(); ledger.close();
      ledger = new HostLedger(join(root, 'host.sqlite'), `product:${productId}`);
      host = new BotCollaboration(server, ledger, botOptions); await host.recover();
    },
    async close() {
      await host.close(); await daemon.stop(); await server.close(); ledger.close();
      await new Promise<void>((resolve, reject) => {
        http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type TestTeam = Awaited<ReturnType<typeof openTeam>>;
