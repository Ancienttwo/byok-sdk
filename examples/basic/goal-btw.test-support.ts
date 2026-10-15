// Test-only stub implements the exported client contract. No internal SDK imports.
import { randomUUID } from 'node:crypto';
import { freezeRuntimeAdapterDescriptor, type Daemon, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeOperationStartInput, type RuntimeDetectResult, type Session } from '@byok-sdk/client';
import { expect, vi } from 'vitest';
type Event = Session['events'] extends AsyncIterable<infer E> ? E : never;
export class BotStubSession implements Session {
  readonly sessionRef = randomUUID();
  interrupted = false; closed = false; steered = 0; followedUp = 0;
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
  finish(document: unknown): void { this.emit({ type: 'progress', text: JSON.stringify(document) }); this.emit({ type: 'turn_end' }); }
  fail(): void { this.failure = new Error('stub failed'); this.wake?.(); this.wake = undefined; }
  async steer(): Promise<void> { this.steered += 1; }
  async followUp(): Promise<void> { this.followedUp += 1; }
  async interrupt(): Promise<void> { this.interrupted = true; }
  async close(): Promise<void> { this.closed = true; this.wake?.(); }
  async resolveApproval(): Promise<void> { /* no approval */ }
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
  async detect(): Promise<RuntimeDetectResult> { return { kind: 'available', version: '0.0.0' }; }
  async prepare(_input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (this.rejectNext) { this.rejectNext = false; return { kind: 'reject', reason: 'stub declined', retryable: true }; }
    return { kind: 'prepared', operation: { start: async input => {
      const session = new BotStubSession(); this.starts.push(input);
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
