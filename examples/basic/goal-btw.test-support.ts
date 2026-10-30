// Test-only stub implements the exported client contract. No internal SDK imports.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { buildRuntimeEnvironment, freezeRuntimeAdapterDescriptor, RuntimeDisposalFailure, type Daemon, type RuntimeAdapter, type RuntimeAdapterPrepareInput, type RuntimeEnvironment,
  type RuntimeAdapterPrepareResult, type RuntimeOperationStartInput, type RuntimeDetectResult, type Session } from '@byok-sdk/client';
import { expect, vi } from 'vitest';
type Event = Session['events'] extends AsyncIterable<infer E> ? E : never;
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

export class BotStubSession implements Session {
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
    [Symbol.asyncIterator]: async function* (this: BotStubSession) {
      while (!this.closed) {
        if (this.failure) throw this.failure;
        const next = this.pending.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    }.bind(this),
  };
  emit(event: Event): void { this.pending.push(event); this.wake?.(); this.wake = undefined; }
  /** Resolves after fixture result submission and event injection; failures still travel through events. */
  finish(document: unknown, submit = true): Promise<void> {
    if (this.closed) return Promise.resolve();
    const finishing = (async () => {
      if (submit && this.input.mcpServers?.byokagentresult) await submitResult(this.input, document, this.resultAbort.signal);
      if (this.closed) return;
      this.emit({ type: 'progress', text: JSON.stringify(document) }); this.emit({ type: 'turn_end' });
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
export class BotStubAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi', supportsDispatchSelection: true, requiresMcpToolsetToolObservation: true,
    // Linux hosts require the Agent-memory MCP projection for Agent-bound offers.
    capabilities: { steer: false, resume: false, mcpToolsets: true, approvalInteractive: false },
  });
  readonly sessions = new Map<string, BotStubSession>();
  readonly starts: RuntimeOperationStartInput[] = [];
  rejectNext = false;
  // A fake runtime spawns nothing: the allowlist environment takes no login-shell capture.
  runtimeEnvironment(): Promise<RuntimeEnvironment> { return buildRuntimeEnvironment({ base: 'allowlist' }); }
  async detect(): Promise<RuntimeDetectResult> { return { kind: 'available', version: '0.0.0' }; }
  async prepare(_input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (this.rejectNext) { this.rejectNext = false; return { kind: 'reject', reason: 'stub declined', retryable: true }; }
    return { kind: 'prepared', operation: { start: async input => {
      const session = new BotStubSession(input); this.starts.push(input);
      this.sessions.set(input.manifest.taskId, session); return session;
    } } };
  }
}

/**
 * Wait for the client's own ready fact: the server accepted this run's
 * `conn.hello` (`lifecycle` `{ phase: 'running', connection: 'open' }`). The
 * server-side `MachineInfo.connected` is not readiness: it reads true while a
 * daemon that failed to settle is still polling.
 */
export async function waitForReady(daemon: Pick<Daemon, 'status'>, timeoutMs = 5_000): Promise<void> {
  await vi.waitFor(() => {
    expect(daemon.status().lifecycle).toEqual({ phase: 'running', connection: 'open' });
  }, { timeout: timeoutMs, interval: 25 });
}

/**
 * Single-active-task fixtures must wait for daemon cleanup before reusing the
 * Agent home. Session.close() precedes the memory snapshot and writer-lease
 * release; a fresh offer during that cleanup is correctly declined as busy.
 */
export async function waitForTaskCleanup(daemon: Pick<Daemon, 'status'>, session: Pick<BotStubSession, 'closed'>): Promise<void> {
  await vi.waitFor(() => {
    expect(session.closed).toBe(true);
    expect(daemon.status().activeTaskCount).toBe(0);
  }, { timeout: 5000 });
}
