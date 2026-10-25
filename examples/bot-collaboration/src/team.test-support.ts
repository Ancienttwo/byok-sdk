import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer, type ByokServer } from '@byok-sdk/server';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import { HostLedger } from '@byok-sdk/example-host-execution-core';
import { policy, template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type AgentMessageInput, type BotOptions } from './host';
import { createBotPersonaProjection } from './persona';
import { enrollSecondDevice } from './second-device.test-support';
import { botCompactVeto } from './compaction';

/**
 * Real embedded server, HTTP, daemon, persona writes, and submit_result helper.
 * `routeMessages` installs `host.consumeMessage` as the server consumer.
 * Otherwise the consumer accepts every message without a Host record.
 * `holdMessage` runs before and after the Host acceptance transaction.
 * `offline` closes the HTTP listener, so the daemon loses the server without a terminal.
 * The Host keeps its in-process server port. `online` listens again on the same port.
 * `bot` sets the external team and history options of the Host.
 */
export async function openTeam(options: { now?: () => number; holdProjection?: () => Promise<void>; routeMessages?: boolean; secondDevice?: boolean;
  wrapServer?: (server: ByokServer) => ConstructorParameters<typeof BotCollaboration>[0]; instructionMaxBytes?: number;
  holdMessage?: (input: AgentMessageInput, stage: 'before' | 'after') => Promise<void>; bot?: Pick<BotOptions, 'team' | 'history'> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'k8b-'));
  const productId = 'k8b-test';
  let ledger = new HostLedger(join(root, 'host.sqlite'), `product:${productId}`, { compactVeto: botCompactVeto });
  let host!: BotCollaboration;
  const received: AgentMessageInput[] = [];
  const server = createByokServer({ productId, storage: { kind: 'sqlite', path: join(root, 'server.sqlite') },
    // Keep empty polls below session waits even when every lossy wake hint is lost.
    longPollHoldMs: 100, ...(options.secondDevice ? { presenceTtlMs: 1000 } : {}),
    agentMessage: { consume: async input => {
      received.push(input);
      if (!options.routeMessages) return { outcome: 'accepted' };
      await options.holdMessage?.(input, 'before');
      const result = await host.consumeMessage(input);
      await options.holdMessage?.(input, 'after');
      return result;
    } },
    wake: { consume: (wake, signal) => host.consume(wake, signal) },
  });
  const listen = async (port: number) => {
    const http = serve({ fetch: server.hono.fetch, port, hostname: '127.0.0.1' });
    if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
    return http;
  };
  const stop = (http: Awaited<ReturnType<typeof listen>>) => new Promise<void>((resolve, reject) => {
    http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections();
  });
  let http: Awaited<ReturnType<typeof listen>> | undefined = await listen(0);
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const adapter = new BotStubAdapter();
  const projection = createBotPersonaProjection();
  const daemon = createDaemonWithAdapters({ productId, productName: 'K8b', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: `http://127.0.0.1:${address.port}`, workspaceRoot: join(root, 'workspace'), storeDir: join(root, 'sdk'),
    agentHome: { hostStorageRoot: join(root, 'homes'), projection: {
      ...projection, apply: async input => { await options.holdProjection?.(); return projection.apply!(input); },
    } }, agentEgress: { policy },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  const pairing = await server.pairing.createPairingCode({ productId });
  const { deviceId } = await daemon.pair(pairing.code);
  const secondDevice = options.secondDevice ? await enrollSecondDevice(`http://127.0.0.1:${address.port}`,
    (await server.pairing.createPairingCode({ productId })).code, join(root, 'second-device'), policy) : undefined;
  const base = template(deviceId);
  const botOptions: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'k8b' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
    } }, connector: async id => ({ id }), now: options.now, instructionMaxBytes: options.instructionMaxBytes, ...options.bot };
  if (secondDevice) botOptions.models = { local: botOptions.execution, remote: { ...botOptions.execution, deviceId: secondDevice.deviceId } };
  const port = options.wrapServer?.(server) ?? server;
  host = new BotCollaboration(port, ledger, botOptions);
  await daemon.start(); await waitForReady(daemon);
  return { root, server, received, get ledger() { return ledger; }, daemon, adapter, deviceId, botOptions, secondDevice,
    get host() { return host; },
    async offline() { await stop(http!); http = undefined; },
    async online() { http = await listen(address.port); await waitForReady(daemon); },
    async reopen() {
      await host.close(); ledger.close();
      ledger = new HostLedger(join(root, 'host.sqlite'), `product:${productId}`, { compactVeto: botCompactVeto });
      host = new BotCollaboration(port, ledger, botOptions); await host.recover();
    },
    async close() {
      await host.close(); await daemon.stop(); await secondDevice?.close(); await server.close(); ledger.close();
      if (http) await stop(http);
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type TestTeam = Awaited<ReturnType<typeof openTeam>>;
