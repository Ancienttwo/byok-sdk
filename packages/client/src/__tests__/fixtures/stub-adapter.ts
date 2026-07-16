import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeDetectResult, Session, TaskContext } from '../../types';
import { AsyncQueue } from '../../util/async-queue';

/** In-memory Session double: tests push AgentEvents and record interrupt/steer/close calls. */
export class StubSession implements Session {
  readonly queue = new AsyncQueue<AgentEvent>();
  interruptCalled = false;
  closeCalled = false;
  readonly steerCalls: string[] = [];
  readonly followUpCalls: TaskOfferPayload[] = [];

  constructor(public readonly sessionRef: string) {}

  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async steer(text: string): Promise<void> {
    this.steerCalls.push(text);
  }

  async followUp(task: TaskOfferPayload): Promise<void> {
    this.followUpCalls.push(task);
  }

  async interrupt(): Promise<void> {
    this.interruptCalled = true;
  }

  async close(): Promise<void> {
    this.closeCalled = true;
    this.queue.end();
  }

  /** Test helper: push a normalized event as if the runtime produced it. */
  emit(event: AgentEvent): void {
    this.queue.push(event);
  }

  /** Test helper: end the session's event stream without a `turn_end` (simulates an unexpected exit). */
  endAbruptly(): void {
    this.queue.end();
  }
}

/** In-memory RuntimeAdapter double: records every start() call and its resulting session. */
export class StubRuntimeAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly startCalls: Array<{ task: TaskOfferPayload; ctx: TaskContext }> = [];
  readonly sessions: StubSession[] = [];
  private readonly detectResult: RuntimeDetectResult;
  private sessionCounter = 0;
  /** When set, start() throws this instead of returning a session (for testing the daemon's failure paths). */
  startError: Error | undefined;

  constructor(id = 'stub', detectResult: RuntimeDetectResult = { present: true, version: '0.0.0' }) {
    this.id = id;
    this.detectResult = detectResult;
  }

  async detect(): Promise<RuntimeDetectResult> {
    return this.detectResult;
  }

  capabilities(): RuntimeCapabilities {
    return { steer: true, resume: true, permissionModes: ['auto', 'readonly'] };
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    this.startCalls.push({ task, ctx });
    if (this.startError) throw this.startError;
    this.sessionCounter += 1;
    const session = new StubSession(task.sessionRef ?? `stub-session-${this.sessionCounter}`);
    this.sessions.push(session);
    return session;
  }
}
