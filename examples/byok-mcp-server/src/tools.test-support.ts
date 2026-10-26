// Test-only host: the embedded SDK server and the beta MCP endpoint on one loopback origin.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createByokServer } from '@byok-sdk/server';
import { createDaemonWithAdapters, freezeRuntimeAdapterDescriptor, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type Session } from '@byok-sdk/client';
import { createEnvelope, PROTOCOL_VERSION, type AgentRef, type BlobRef, type Envelope } from '@byok-sdk/protocol';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { createDeviceSimulator } from '@byok-sdk/testkit';
import { expect, vi } from 'vitest';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BetaLedger, createBetaMcpServer, createTaskTools } from './index';

type Event = Session['events'] extends AsyncIterable<infer E> ? E : never;
export const PRODUCT_ID = 'beta-b3-test';
/** The Agent that `tasks.dispatch` test keys run their tasks as. */
export const AGENT: Readonly<AgentRef> = { agentId: 'main', profileRevision: '1' };
/** The durable device capabilities the SDK requires before it submits a fresh Agent execution with a terminal projection. */
export const AGENT_EXECUTION_CAPABILITIES = ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session',
  'terminal-projection-selection'];
export const cleanup: Array<() => void | Promise<void>> = [];

/** A scripted coding agent behind the public RuntimeAdapter contract. Tests emit its events. */
export class FakeSession implements Session {
  readonly sessionRef = `fake-${Math.random().toString(36).slice(2)}`;
  interrupted = false; closed = false;
  private pending: Event[] = [];
  private wake: (() => void) | undefined;
  readonly events: AsyncIterable<Event> = {
    [Symbol.asyncIterator]: async function* (this: FakeSession) {
      while (!this.closed) {
        const next = this.pending.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    }.bind(this),
  };
  emit(event: Event): void { this.pending.push(event); this.wake?.(); this.wake = undefined; }
  async steer(): Promise<void> { throw new Error('fake runtime does not steer'); }
  async followUp(): Promise<void> { throw new Error('fake runtime takes one instruction'); }
  async interrupt(): Promise<void> { this.interrupted = true; }
  async close(): Promise<void> { this.closed = true; this.wake?.(); this.wake = undefined; }
  async resolveApproval(): Promise<void> { /* no approval */ }
}
export class FakeRuntime implements RuntimeAdapter {
  // Pi projects MCP toolsets. An Agent offer carries the Agent memory MCP whenever the daemon admits it.
  readonly descriptor = freezeRuntimeAdapterDescriptor({ id: 'pi', supportsDispatchSelection: true,
    capabilities: { steer: false, resume: false, mcpToolsets: true, approvalInteractive: false } });
  readonly sessions = new Map<string, FakeSession>();
  readonly offers: RuntimeAdapterPrepareInput['offer'][] = [];
  /** What the daemon reported, quoted when a session does not start. */
  diagnostics: () => unknown = () => undefined;
  async detect(): Promise<RuntimeDetectResult> { return { kind: 'available', version: '0.0.0-fake' }; }
  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    this.offers.push(input.offer);
    return { kind: 'prepared', operation: { start: async start => {
      const session = new FakeSession(); this.sessions.set(start.manifest.taskId, session); return session;
    } } };
  }
  async session(taskId: string): Promise<FakeSession> {
    await vi.waitFor(() => expect(this.sessions.has(taskId), JSON.stringify(this.diagnostics())).toBe(true), { timeout: 3000, interval: 20 });
    return this.sessions.get(taskId)!;
  }
}

export async function openHost(options: { now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'b3-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const server = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 200 });
  let mcp: ReturnType<typeof createBetaMcpServer> | undefined;
  const http = serve({ hostname: '127.0.0.1', port: 0,
    fetch: request => new URL(request.url).pathname === '/mcp' && mcp ? mcp.fetch(request) : server.hono.fetch(request) });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  const ledger = new BetaLedger(join(root, 'beta.sqlite'), 'tenant-b3', { tasks: server.tasks, ...(options.now ? { now: options.now } : {}) });
  const endpoint = createBetaMcpServer({ ledger, origin, serverInfo: { name: 'B3 test host', version: '1' },
    tools: createTaskTools({ sdk: server, ledger, egressPolicy: policy, blobBaseUrl: origin, statusPollMs: 20 }) });
  mcp = endpoint;
  cleanup.push(async () => {
    endpoint.close(); if ('closeAllConnections' in http) http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve())); await server.close(); ledger.close();
  });
  return { root, server, ledger, origin, url: new URL('/mcp', origin) };
}
export type Host = Awaited<ReturnType<typeof openHost>>;

/** The real device daemon from `@byok-sdk/client`, paired to the embedded server, with the fake runtime. */
export async function openDaemonHost() {
  const host = await openHost();
  const runtime = new FakeRuntime();
  const daemon = createDaemonWithAdapters({ productId: PRODUCT_ID, productName: 'B3 test', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: host.origin, storeDir: join(host.root, 'sdk'),
    agentHome: { hostStorageRoot: join(host.root, 'homes') }, agentEgress: { policy } },
  [runtime], { deviceCredentials: new InMemoryDeviceCredentialStore(), longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
  const events: unknown[] = [];
  const unsubscribe = daemon.subscribe(event => events.push(event)); cleanup.push(unsubscribe);
  runtime.diagnostics = () => ({ events, status: daemon.status() });
  const { deviceId } = await daemon.pair((await host.server.pairing.createPairingCode({ productId: PRODUCT_ID })).code);
  await daemon.start(); cleanup.push(() => daemon.stop());
  await vi.waitFor(() => expect(daemon.status().lifecycle).toEqual({ phase: 'running', connection: 'open' }), { timeout: 3000, interval: 20 });
  return { ...host, daemon, runtime, deviceId };
}

/** The testkit device simulator over HTTP, for terminals the real daemon does not produce (artifactRefs). */
export async function openSimulatorHost(options: { now?: () => number; capabilities?: string[] } = {}) {
  const host = await openHost(options);
  const device = await createDeviceSimulator({ baseUrl: host.origin });
  const session = await device.pair((await host.server.pairing.createPairingCode({ productId: PRODUCT_ID })).code);
  const send = async (envelope: Envelope) => {
    const response = await device.request({ method: 'POST', path: '/byok/messages', body: { messages: [envelope] } });
    expect(response).toMatchObject({ status: 200, body: { accepted: 1 } });
  };
  await send(createEnvelope('conn.hello', { protocolVersions: [PROTOCOL_VERSION], capabilities: [...AGENT_EXECUTION_CAPABILITIES, ...options.capabilities ?? []], productId: PRODUCT_ID,
    deviceId: session.deviceId, runtimes: [{ id: 'pi', capabilities: { steer: false, resume: false, approvalInteractive: false } }] }));
  /** Declare, upload and finalize one blob as the device, through the SDK's blob routes. */
  const uploadBlob = async (content: Buffer, contentType: string): Promise<BlobRef> => {
    const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const headers = { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': contentHash };
    const created = await fetch(`${host.origin}/byok/blobs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ size: content.length, contentType, contentHash }) });
    expect(created.status).toBe(200);
    const { blobId, uploadUrl } = await created.json() as { blobId: string; uploadUrl: string };
    expect((await fetch(`${host.origin}${uploadUrl}`, { method: 'PUT', body: content })).status).toBe(204);
    expect((await fetch(`${host.origin}/byok/blobs/${blobId}/finalize`, { method: 'POST', headers })).status).toBe(204);
    return { blobId, contentHash, size: content.length, contentType };
  };
  return { ...host, deviceId: session.deviceId, send, uploadBlob };
}

export async function connect(host: Pick<Host, 'url'>, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(host.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'standard-b3-client', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] });
  await client.connect(transport); cleanup.push(async () => { await client.close(); });
  return client;
}
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected JSON text');
  return { isError: result.isError === true, value: JSON.parse(block.text) };
}
