import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { serve } from '@hono/node-server';
import {
  buildRuntimeEnvironment, createDaemonWithAdapters, freezeRuntimeAdapterDescriptor, RuntimeDisposalFailure,
  type Daemon, type DeviceCredentialBackend, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeEnvironment, type RuntimeOperationStartInput, type Session,
} from '@byok-sdk/client';
import { createByokServer, type CreateByokServerOptions, type DueWake } from '@byok-sdk/server';
import { HostLedger, type HostLedgerOptions } from '@byok-sdk/server/execution-core';
import { policy } from './k4-fixtures.test-support.js';

/**
 * #1325: a running L Host for the routine and delivery vectors, built only from published packages, so a Host that
 * installs the package runs them too. It is the `externalCore` branch of K4's `openHost`: the caller drives its own core on the
 * returned ledger, so the fixture creates none. The daemon admits only the `policyRevision` of the vectors' `template`,
 * so both come from `./k4-fixtures.test-support` (#1845).
 */

type Event = Session['events'] extends AsyncIterable<infer E> ? E : never;
/** Calls `submit_result` on the run's `byokagentresult` MCP server, as a real runtime would. */
async function submitResult(input: RuntimeOperationStartInput, outcome: unknown, signal: AbortSignal): Promise<unknown> {
  const server = input.mcpServers?.byokagentresult;
  if (!server) throw new Error('result-document fixture did not receive byokagentresult');
  signal.throwIfAborted();
  const child = spawn(server.command, [...(server.args ?? [])], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  // `close` proves stdio is closed too, and also fires after a failed spawn.
  const ended = new Promise<void>(resolve => child.once('close', () => resolve()));
  const abort = () => { for (const request of pending.values()) request.reject(new Error('result helper closed')); pending.clear(); };
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('result helper exited before response')); pending.clear(); });
  child.stderr.resume();
  lines.on('line', line => {
    const response = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
    if (response.id === undefined) return;
    const request = pending.get(response.id); if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message)); else request.resolve(response.result);
  });
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'example-stub', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await request('tools/call', { name: 'submit_result', arguments: outcome });
  } finally {
    signal.removeEventListener('abort', abort);
    lines.close();
    // If signaling fails, retain ownership until close; Session.close reports
    // bounded disposal failure rather than pretending the process is gone.
    try { child.kill('SIGKILL'); } catch { /* disposal receipt remains pending */ }
    await ended;
  }
}

/** A stub runtime session: the test ends it with `finish(document)`, which submits the result document. */
export class ResultStubSession implements Session {
  constructor(private readonly input: RuntimeOperationStartInput) {}

  readonly sessionRef = randomUUID();
  interrupted = false; closed = false; steered = 0; followedUp = 0;
  private readonly resultAbort = new AbortController();
  private readonly finishing = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private pending: Event[] = [];
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  readonly events: AsyncIterable<Event> = {
    [Symbol.asyncIterator]: async function* (this: ResultStubSession) {
      while (!this.closed) {
        if (this.failure) throw this.failure;
        const next = this.pending.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    }.bind(this),
  };
  emit(event: Event): void { this.pending.push(event); this.wake?.(); this.wake = undefined; }
  /**
   * Resolves after result submission and event injection; failures still travel through events. `text` is the final runtime
   * text, which a required message egress publishes as the Agent message.
   */
  finish(document: unknown, submit = true, text = JSON.stringify(document)): Promise<void> {
    if (this.closed) return Promise.resolve();
    const finishing = (async () => {
      if (submit && this.input.mcpServers?.byokagentresult) await submitResult(this.input, document, this.resultAbort.signal);
      if (this.closed) return;
      this.emit({ type: 'progress', text }); this.emit({ type: 'turn_end' });
    })().catch(error => {
      if (!this.closed) { this.failure = error; this.wake?.(); this.wake = undefined; }
    }).finally(() => { this.finishing.delete(finishing); });
    this.finishing.add(finishing);
    return finishing;
  }
  fail(): void { this.failure = new Error('stub failed'); this.wake?.(); this.wake = undefined; }
  async steer(): Promise<void> { this.steered += 1; }
  async followUp(): Promise<void> { this.followedUp += 1; }
  async interrupt(): Promise<void> { this.interrupted = true; }
  /** Read only for a descriptor that declares `trajectoryEvidence`; the stub drops no runtime output. */
  evidence() { return { decodeDropped: 0, unmappedFrames: 0, syntheticToolResults: 0 }; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.wake?.(); this.wake = undefined;
    this.resultAbort.abort();
    // Test-only disposal bound, separate from every business observation window.
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.closing = Promise.race([
      Promise.all([...this.finishing]).then(() => {}),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'result helper did not close' })), 1000);
      }),
    ]).finally(() => { clearTimeout(timer); this.closing = undefined; });
    return this.closing;
  }
}

/** A stub `pi` runtime that spawns nothing. `sessions` maps each started task id to its session. */
export class ResultStubAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi', supportsDispatchSelection: true, requiresMcpToolsetToolObservation: true,
    // Linux hosts require the Agent-memory MCP projection for Agent-bound offers.
    capabilities: { steer: false, resume: false, mcpToolsets: true, approvalInteractive: false },
  });
  readonly sessions = new Map<string, ResultStubSession>();
  readonly starts: RuntimeOperationStartInput[] = [];
  rejectNext = false;
  // A fake runtime spawns nothing: the allowlist environment takes no login-shell capture.
  runtimeEnvironment(): Promise<RuntimeEnvironment> { return buildRuntimeEnvironment({ base: 'allowlist' }); }
  async detect(): Promise<RuntimeDetectResult> { return { kind: 'available', version: '0.0.0' }; }
  async prepare(_input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (this.rejectNext) { this.rejectNext = false; return { kind: 'reject', reason: 'stub declined', retryable: true }; }
    return { kind: 'prepared', operation: { start: async input => {
      const session = new ResultStubSession(input); this.starts.push(input);
      this.sessions.set(input.manifest.taskId, session); return session;
    } } };
  }
}

/**
 * Waits for the client's own ready fact: the server accepted this run's `conn.hello`. The server-side
 * `MachineInfo.connected` is not readiness: it reads true while a daemon that failed to settle is still polling.
 */
async function waitForReady(daemon: Pick<Daemon, 'status'>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { lifecycle } = daemon.status();
    if (lifecycle.phase === 'running' && lifecycle.connection === 'open') return;
    if (Date.now() >= deadline) throw new Error(`daemon not ready within ${timeoutMs} ms: ${JSON.stringify(lifecycle)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Starts an embedded SQLite server, pairs one daemon that runs `adapter`, and opens the Host ledger. */
export async function openLTestHost(options: {
  deviceCredentials: DeviceCredentialBackend;
  consume: (wake: DueWake, signal: AbortSignal) => Promise<void>;
  ledgerOptions?: HostLedgerOptions;
  adapter?: ResultStubAdapter;
  agentMessage?: CreateByokServerOptions['agentMessage'];
}) {
  const deviceCredentials = options.deviceCredentials;
  if (deviceCredentials === undefined) throw new TypeError('openLTestHost requires deviceCredentials');
  const root = await mkdtemp(path.join(tmpdir(), 'lth-'));
  const productId = 'host-core-test';
  const ledgerPath = path.join(root, 'host.sqlite');
  const ledger = new HostLedger(ledgerPath, `product:${productId}`, options.ledgerOptions);
  const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
    // Leave time for HTTP delivery and admission within the five-second fixture waits.
    longPollHoldMs: 100,
    agentMessage: options.agentMessage,
    wake: { consume: options.consume },
  });
  const http = serve({ fetch: server.hono.fetch, port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const adapter = options.adapter ?? new ResultStubAdapter();
  const config = { productId, productName: 'Host Core', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: `http://127.0.0.1:${address.port}`, storeDir: path.join(root, 'sdk'),
    agentHome: { hostStorageRoot: path.join(root, 'homes') }, agentEgress: { policy },
  };
  const daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials });
  const pairing = await server.pairing.createPairingCode({ productId });
  const { deviceId } = await daemon.pair(pairing.code);
  await daemon.start(); await waitForReady(daemon);
  let closed = false;
  return {
    root, ledgerPath, server, ledger, deviceId, adapter,
    async close() {
      if (closed) return;
      closed = true;
      await daemon.stop(); await server.close(); ledger.close();
      await new Promise<void>((resolve, reject) => {
        http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type LTestHost = Awaited<ReturnType<typeof openLTestHost>>;
