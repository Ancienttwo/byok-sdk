import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeDetectResult, Session, TaskContext } from '../../types';
import { AsyncQueue } from '../../util/async-queue';

/** In-memory Session double: tests push AgentEvents and record interrupt/steer/close/resolveApproval calls. */
export class StubSession implements Session {
  readonly queue = new AsyncQueue<AgentEvent>();
  interruptCalled = false;
  closeCalled = false;
  readonly steerCalls: string[] = [];
  readonly followUpCalls: TaskOfferPayload[] = [];
  readonly resolveApprovalCalls: Array<{ approved: boolean; reason?: string }> = [];
  private closeGate: Promise<void> | undefined;

  constructor(public readonly sessionRef: string) {}

  /**
   * Test hook: widen the window `TaskRunner.finish()` spends inside
   * `await session.close()` — `finish()` deletes the task from its active
   * map *before* awaiting close(), so this lets a test deterministically
   * reproduce "an event arrives while the task is already gone from the map
   * but the session hasn't finished tearing down yet" (the exact shape of
   * the post-cancel stray-turn_end race `TaskRunner.pump`'s guard exists
   * for) instead of depending on real interprocess-timing luck. Returns the
   * release function; close() resolves once it's called.
   */
  blockClose(): () => void {
    let release!: () => void;
    this.closeGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

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
    if (this.closeGate) await this.closeGate;
    this.closeCalled = true;
    this.queue.end();
  }

  /** Records the resolution; the test drives what "resuming" looks like by calling `emit()` afterward — `TaskRunner.pump()` is already waiting on `events`, so pushed events flow through exactly like normal progress. */
  async resolveApproval(approved: boolean, reason?: string): Promise<void> {
    this.resolveApprovalCalls.push(reason === undefined ? { approved } : { approved, reason });
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
  private startGate: Promise<void> | undefined;

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

  /**
   * Test hook (finding F4): pause `start()` right before it resolves its
   * session, so a test can deterministically land a `task.cancel` in the
   * window between `task.claim` and `ActiveTask` registration — i.e. while
   * `start()` is still in flight — instead of depending on real timing.
   * Returns the release function; `start()` resolves once it's called.
   */
  blockStart(): () => void {
    let release!: () => void;
    this.startGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    this.startCalls.push({ task, ctx });
    if (this.startError) throw this.startError;
    if (this.startGate) await this.startGate;
    this.sessionCounter += 1;
    const session = new StubSession(task.sessionRef ?? `stub-session-${this.sessionCounter}`);
    this.sessions.push(session);
    return session;
  }
}
