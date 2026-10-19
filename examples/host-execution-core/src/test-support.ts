import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer, type CreateByokServerOptions, type DueWake } from '@byok-sdk/server';
import { createDaemonWithAdapters, type AgentEgressPolicy } from '@byok-sdk/client';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import { HostExecutionCore, type HostOptions, type ExecutionServer } from './core';
import { HostLedger } from './ledger';
import type { ExecutionTemplate, IntentInput, RoutineDefinition } from './model';

export const policy: AgentEgressPolicy = {
  policyRevision: 'k4-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};
export function template(deviceId: string, agentId = 'main'): ExecutionTemplate {
  return { deviceId, payload: { runtime: 'pi', instruction: 'Return the test result through submit_result.',
    agentRef: { agentId, profileRevision: '1' }, egressPolicy: policy,
    terminalProjection: { mode: 'result-document', contract: 'host-core-test-v1', schema: {
      type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } },
    } },
  } };
}
export async function openHost(options: HostOptions & {
  agentMessage?: CreateByokServerOptions['agentMessage'];
  consume?: (wake: DueWake, signal: AbortSignal, next: () => Promise<void>) => Promise<void>;
  wrapServer?: (server: ExecutionServer) => ExecutionServer;
  adapter?: BotStubAdapter;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-'));
  const productId = 'host-core-test';
  const ledgerPath = path.join(root, 'host.sqlite');
  let ledger = new HostLedger(ledgerPath, `product:${productId}`);
  let core!: HostExecutionCore;
  const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
    agentMessage: options.agentMessage,
    wake: { consume: (wake, signal) => options.consume ? options.consume(wake, signal, () => core.consume(wake, signal)) : core.consume(wake, signal) },
  });
  core = new HostExecutionCore(options.wrapServer?.(server) ?? server, ledger, options);
  const http = serve({ fetch: server.hono.fetch, port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const adapter = options.adapter ?? new BotStubAdapter();
  const credentials = new InMemoryDeviceCredentialStore();
  const config = { productId, productName: 'Host Core', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: `http://127.0.0.1:${address.port}`, workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'sdk'),
    agentHome: { hostStorageRoot: path.join(root, 'homes') }, hostedJournal: { mode: 'sqlite' as const }, agentEgress: { policy },
  };
  let daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials });
  const pairing = await server.pairing.createPairingCode({ productId });
  const { deviceId } = await daemon.pair(pairing.code);
  await daemon.start(); await waitForReady(daemon);
  let closed = false;
  return {
    root, server, adapter, deviceId, get core() { return core; }, get ledger() { return ledger; }, get daemon() { return daemon; },
    intent(key: string, rest: Partial<IntentInput> = {}): IntentInput {
      return { key, source: 'bot', execution: template(deviceId), waitUntil: Date.now() + 60_000, ...rest };
    },
    routine(id: string, rest: Partial<RoutineDefinition> = {}): RoutineDefinition {
      return { id, version: 1, timeZone: 'UTC', rule: { anchorMs: Date.now() + 30, everyMs: 86_400_000 },
        execution: template(deviceId), waitMs: 60_000, lateAfterMs: 1000, ...rest };
    },
    async restartCore() {
      await core.close(); ledger.close(); ledger = new HostLedger(ledgerPath, `product:${productId}`);
      core = new HostExecutionCore(options.wrapServer?.(server) ?? server, ledger, options); await core.recover();
    },
    async offline() { await daemon.stop(); },
    async online() { daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials }); await daemon.start(); await waitForReady(daemon); },
    async close() {
      if (closed) return;
      closed = true;
      await core.close(); await daemon.stop(); await server.close(); ledger.close();
      await new Promise<void>((resolve, reject) => {
        http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type TestHost = Awaited<ReturnType<typeof openHost>>;
