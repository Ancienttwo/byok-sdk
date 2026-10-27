// Test-only fake runtime for the #610 runner. It implements the public
// RuntimeAdapter contract and calls the real SDK `submit_result` helper over
// MCP stdio, so the helper body (Source 2) and the staged record (Source 3)
// are real. It makes no provider call.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  freezeRuntimeAdapterDescriptor, RuntimeDisposalFailure, RuntimeExecutionFailure, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeOperationStartInput, type Session,
} from '@byok-sdk/client';

type Event = Session['events'] extends AsyncIterable<infer E> ? E : never;

/** What the fake model does in one trial. */
export type FakeBehavior =
  | 'exact' | 'wrong' | 'reject-then-correct' | 'reject-only' | 'no-call' | 'runtime-error' | 'hang' | 'decline' | 'capacity';

export const FAKE_CAPACITY_REASON = 'context_overflow: fake runtime context window exceeded';

/** A minimal MCP stdio client for the session's `byokagentresult` server. */
class HelperClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 0;
  readonly closed: Promise<void>;

  constructor(server: { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
    this.child = spawn(server.command, [...(server.args ?? [])], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()));
    const fail = (error: Error) => { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', () => fail(new Error('result helper exited before response')));
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      const response = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      const request = response.id === undefined ? undefined : this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id!);
      if (response.error) request.reject(new Error(response.error.message)); else request.resolve(response.result);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async open(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-measurement-runtime', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async close(): Promise<void> {
    try { this.child.kill('SIGKILL'); } catch { /* close below still waits */ }
    await this.closed;
  }
}

function wrongValue(target: Record<string, unknown>): unknown {
  // Schema-valid but not the target. C06 becomes a truncated string, as in the method doc.
  if (typeof target.text === 'string') return { text: target.text.slice(0, 10) };
  if ('action' in target) return { ...target, count: 4 };
  if ('items' in target) return { items: [3, 2, 1].map(id => ({ id, text: `item-${id}` })) };
  return { kind: 'done', summary: 'other' };
}

class FakeSession implements Session {
  readonly sessionRef = randomUUID();
  closed = false;
  private pending: Event[] = [];
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private helper: HelperClient | undefined;
  private readonly running: Promise<void>;
  private closing: Promise<void> | undefined;

  readonly events: AsyncIterable<Event> = {
    [Symbol.asyncIterator]: async function* (this: FakeSession) {
      while (!this.closed) {
        if (this.failure) throw this.failure;
        const next = this.pending.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    }.bind(this),
  };

  constructor(private readonly input: RuntimeOperationStartInput, private readonly behavior: FakeBehavior) {
    this.running = this.run().catch(error => { if (!this.closed) { this.failure = error as Error; this.signal(); } });
  }

  private signal(): void { this.wake?.(); this.wake = undefined; }
  private emit(event: Event): void { this.pending.push(event); this.signal(); }

  private async call(document: unknown): Promise<void> {
    const server = this.input.mcpServers?.byokagentresult;
    if (!server) throw new Error('the fake runtime did not receive byokagentresult');
    if (!this.helper) { this.helper = new HelperClient(server); await this.helper.open(); }
    const toolCallId = randomUUID();
    this.emit({ type: 'tool_use', tool: 'submit_result', toolCallId, input: document });
    const result = await this.helper.request('tools/call', { name: 'submit_result', arguments: document }) as { isError?: boolean };
    this.emit({ type: 'tool_result', tool: 'submit_result', toolCallId, output: result, isError: result.isError === true });
  }

  private async run(): Promise<void> {
    if (this.input.kind !== 'instruction') throw new Error('the fake runtime runs instruction starts only');
    const lines = this.input.instruction.split('\n');
    const target = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    this.emit({ type: 'progress', text: 'fake runtime started' });
    switch (this.behavior) {
      case 'exact': await this.call(target); break;
      case 'wrong': await this.call(wrongValue(target)); break;
      case 'reject-then-correct': await this.call({ unexpected: true }); await this.call(target); break;
      case 'reject-only': await this.call({ unexpected: true }); break;
      case 'no-call': this.emit({ type: 'progress', text: JSON.stringify(target) }); break;
      case 'hang': return;
      // Typed run failures, as the real adapters report them; the SDK copies `reason` into task.fail.
      case 'runtime-error': throw new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'non-retryable', reason: 'fake runtime crashed' });
      case 'capacity': throw new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: FAKE_CAPACITY_REASON });
      case 'decline': throw new Error('decline is handled at prepare');
    }
    this.emit({ type: 'usage', inputTokens: 10, outputTokens: 5 });
    this.emit({ type: 'turn_end' });
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async interrupt(): Promise<void> {}

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.signal();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.closing = Promise.race([
      (async () => { await this.helper?.close(); })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'result helper did not close' })), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    void this.running;
    return this.closing;
  }
}

/**
 * Starts one fake session per task. `script(index, instruction)` picks the
 * behavior of each start, in order; index 0 is the calibration trial.
 */
export class FakeMeasurementAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi', supportsDispatchSelection: false, requiresMcpToolsetToolObservation: true,
    capabilities: { steer: false, resume: false, mcpToolsets: true, approvalInteractive: false },
  });
  readonly behaviors: FakeBehavior[] = [];
  private prepared = 0;

  constructor(private readonly script: (index: number) => FakeBehavior) {}

  async detect(): Promise<RuntimeDetectResult> { return { kind: 'available', version: '0.0.0-fake' }; }

  async prepare(_input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const behavior = this.script(this.prepared++);
    this.behaviors.push(behavior);
    if (behavior === 'decline') return { kind: 'reject', reason: 'fake runtime declined', retryable: true };
    return { kind: 'prepared', operation: { start: async input => new FakeSession(input, behavior) } };
  }
}
