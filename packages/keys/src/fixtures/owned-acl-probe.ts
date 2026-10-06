import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess, spawn } from 'node:child_process';
import type { CommandRunner } from '../command-runner';

type Spawn = typeof spawn;
type SpawnArgs = Parameters<Spawn>;
export interface ProbePhase {
  readonly generation: number;
  readonly phase: string;
  readonly elapsedMs: number;
  readonly pid?: number;
  readonly detail?: string;
}
export interface ProbeTarget { readonly executable: string; readonly stdin: string }

/** Test-only dispatcher. Outside one matching command invocation it is a no-op. */
export class AclProbeObserver {
  private readonly context = new AsyncLocalStorage<OwnedAclProbe>();
  private capture?: OwnedAclProbe;
  private active?: OwnedAclProbe;
  private sequence = 0;

  create(target: ProbeTarget, log: (phase: ProbePhase) => void = () => {}): OwnedAclProbe {
    this.assertIdle();
    const probe = new OwnedAclProbe(++this.sequence, Object.freeze({ ...target }), log, this);
    this.active = probe;
    return probe;
  }
  assertIdle(): void {
    if (this.active) throw new Error(`ACL probe generation ${this.active.generation} ownership is unresolved; fixture retained`);
    if (this.capture) throw new Error('ACL spawn capture was not restored');
  }
  state(): { activeGeneration?: number; captureGeneration?: number } {
    return { activeGeneration: this.active?.generation, captureGeneration: this.capture?.generation };
  }
  run<T>(probe: OwnedAclProbe, operation: () => Promise<T>): Promise<T> {
    if (this.active !== probe) throw new Error('ACL probe is not the active generation');
    return this.context.run(probe, operation);
  }
  release(probe: OwnedAclProbe): void {
    if (this.active !== probe || this.capture) throw new Error('ACL observer generation mismatch during release');
    this.active = undefined;
  }

  command(original: CommandRunner, receiver: unknown, args: Parameters<CommandRunner>): ReturnType<CommandRunner> {
    const probe = this.context.getStore();
    if (!probe || !probe.matches(args)) return Reflect.apply(original, receiver, args);
    // The ALS object survives lstat/realpath awaits. Expiry never permits a late
    // native launch, even after an outer test/hook has stopped waiting.
    const refusal = probe.beforeCommand();
    if (refusal) return Promise.reject(refusal);
    if (this.active !== probe || this.capture) return Promise.reject(probe.failCapture('command scope overlap'));
    this.capture = probe;
    try {
      // runCommand spawns synchronously, before returning its native promise.
      // Keep that exact promise/result; observe only this synchronous invocation.
      return Reflect.apply(original, receiver, args);
    } finally {
      this.capture = undefined;
    }
  }
  spawn(original: Spawn, receiver: unknown, args: SpawnArgs): ReturnType<Spawn> {
    const probe = this.capture;
    if (!probe) return Reflect.apply(original, receiver, args);
    probe.beforeSpawn();
    try {
      const child = Reflect.apply(original, receiver, args) as ReturnType<Spawn>;
      probe.own(child);
      return child;
    } catch (error) {
      probe.note('spawn-threw');
      throw error;
    }
  }
}

export class OwnedAclProbe {
  private readonly startedAt = Date.now();
  private child?: ChildProcess;
  private closeReceived = false;
  private operationSettled = false;
  private operationStarted = false;
  private commandStarted = false;
  private commandSuppressed = false;
  private spawnCalls = 0;
  private cancellation?: Error;
  private captureFailure?: Error;
  private killScheduled = false;
  private killSent = false;
  private disposed = false;
  private disposalFailure?: Error;
  private restoreListeners: (() => void)[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly generation: number,
    private readonly target: ProbeTarget,
    private readonly log: (phase: ProbePhase) => void,
    private readonly observer: AclProbeObserver,
  ) { Object.defineProperty(this, 'generation', { value: generation, writable: false, configurable: false, enumerable: true }); }
  note(phase: string, detail?: string): void {
    try {
      this.log({ generation: this.generation, phase, elapsedMs: Date.now() - this.startedAt,
        ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }), ...(detail === undefined ? {} : { detail }) });
    } catch { this.captureFailure ??= new Error('ACL diagnostic logger failed'); }
  }
  matches([executable, args, stdin]: Parameters<CommandRunner>): boolean {
    return executable === this.target.executable && stdin === this.target.stdin
      && args.length === 4 && args[0] === '-NoProfile' && args[1] === '-NonInteractive'
      && args[2] === '-EncodedCommand' && typeof args[3] === 'string';
  }
  beforeCommand(): Error | undefined {
    if (this.cancellation || this.disposed || this.disposalFailure) {
      this.commandSuppressed = true;
      this.note('late-command-suppressed');
      return this.cancellation ?? this.disposalFailure ?? new Error('ACL probe generation already disposed');
    }
    if (this.commandStarted) return this.failCapture('more than one matching command invocation');
    this.commandStarted = true;
    this.note('command-invoked');
    return undefined;
  }
  failCapture(reason: string): Error {
    this.captureFailure ??= new Error(`ACL generation ${this.generation} capture identity failed: ${reason}`);
    return this.captureFailure;
  }
  beforeSpawn(): void {
    if (++this.spawnCalls !== 1) throw this.failCapture('more than one spawn in the matching invocation');
    this.note('spawn-call');
  }
  own(child: ChildProcess): void {
    if (this.child) throw this.failCapture('child already captured');
    this.child = child;
    const on = (emitter: NodeJS.EventEmitter | null | undefined, event: string, listener: (...args: any[]) => void) => {
      if (!emitter) return;
      emitter.on(event, listener);
      this.restoreListeners.push(() => emitter.removeListener(event, listener));
    };
    on(child, 'spawn', () => this.note('spawn-event'));
    let stdoutSeen = false; let stderrSeen = false;
    on(child.stdout, 'data', () => { if (!stdoutSeen) { stdoutSeen = true; this.note('first-stdout'); } });
    on(child.stderr, 'data', () => { if (!stderrSeen) { stderrSeen = true; this.note('first-stderr'); } });
    // Cancellation can race the original stdin.end(). Observe its error without
    // allowing an unhandled pipe error to escape before owned teardown finishes.
    on(child.stdin, 'error', () => { this.note('stdin-error'); this.captureFailure ??= new Error('ACL probe stdin failed'); });
    on(child, 'error', () => this.note('child-error'));
    on(child, 'exit', (code, signal) => this.note('exit', `code=${String(code)} signal=${String(signal)}`));
    on(child, 'close', (code, signal) => {
      this.closeReceived = true;
      this.note('close', `code=${String(code)} signal=${String(signal)}`);
      this.changed();
    });
    this.note('child-owned');
    if (this.cancellation) this.cancelChild();
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationStarted) throw new Error('ACL probe operation may only start once');
    this.operationStarted = true;
    const result = this.observer.run(this, async () => operation());
    return result.then(value => {
      this.operationSettled = true; this.note('assertion-resolved'); this.changed();
      if (this.cancellation) throw this.cancellation;
      if (this.captureFailure) throw this.captureFailure;
      if (!this.commandStarted || this.spawnCalls !== 1 || !this.child) throw this.failCapture('no proven child for successful assertion');
      return value;
    }, error => {
      this.operationSettled = true; this.note('assertion-rejected'); this.changed();
      throw this.cancellation ?? error;
    });
  }
  cancel(error: Error): void {
    if (this.disposed) return;
    this.cancellation ??= error;
    this.note('cancel-requested');
    this.cancelChild();
  }
  private cancelChild(): void {
    if (!this.child || this.closeReceived || this.killScheduled || this.killSent) return;
    this.killScheduled = true;
    queueMicrotask(() => {
      this.killScheduled = false;
      if (!this.child || this.closeReceived || this.killSent) return;
      this.killSent = true;
      this.note('kill-requested');
      try { this.note('kill-returned', String(this.child.kill())); }
      catch { this.note('kill-threw'); }
    });
  }
  private quiescent(): boolean {
    if (!this.operationSettled) return false;
    if (this.commandSuppressed && !this.commandStarted) return true;
    // An actual invocation without a captured close receipt is never considered
    // safe merely because its promise rejected or the PID is absent.
    return this.commandStarted && this.spawnCalls === 1 && !!this.child && this.closeReceived;
  }
  private changed(): void { for (const notify of this.waiters) notify(); }

  /** The caller supplies a sub-budget inside the existing teardown timeout. */
  async dispose(budgetMs: number, cleanup: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    if (this.disposalFailure) throw this.disposalFailure;
    if (!this.quiescent()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let check!: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          check = () => { if (this.quiescent()) resolve(); };
          this.waiters.add(check);
          timer = setTimeout(() => {
            this.disposalFailure = new Error(`ACL generation ${this.generation} teardown unresolved; pid=${this.child?.pid ?? 'uncaptured'}; fixture retained`);
            this.note('teardown-unresolved');
            this.cancel(this.disposalFailure);
            reject(this.disposalFailure);
          }, budgetMs);
          check();
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(check);
      }
    }
    if (this.disposalFailure) throw this.disposalFailure;
    for (const restore of this.restoreListeners.splice(0)) restore();
    try { await cleanup(); } catch (error) {
      this.disposalFailure = error instanceof Error ? error : new Error('ACL fixture cleanup failed');
      throw this.disposalFailure;
    }
    this.disposed = true;
    this.observer.release(this);
    this.note('disposed');
  }
}

/** Used only by this native test file's transparent module wrappers. */
export const nativeAclProbeObserver = new AclProbeObserver();
