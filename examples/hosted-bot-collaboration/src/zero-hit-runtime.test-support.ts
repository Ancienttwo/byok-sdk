// The scripted runtime of the sealed zero-hit run (#654 E6). No model runs: the test drives each session's events, and
// the session records the instruction and the steer texts it received, as the device opened them.
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult,
  type RuntimeOperationStartInput } from '@byok-sdk/client';
import { BotStubAdapter, BotStubSession } from '../../basic/goal-btw.test-support';

export class ZeroHitSession extends BotStubSession {
  readonly steers: string[] = [];
  constructor(readonly start: RuntimeOperationStartInput) { super(start); }
  /** The instruction the daemon started this session with. */
  get instruction(): string { return this.start.kind === 'instruction' ? this.start.instruction : ''; }
  /** The task's run directory, where the daemon reads an artifact the session names. */
  get workspaceDir(): string { return this.start.manifest.cwd!; }
  // The base stub takes no text, so the override keeps that arity and reads the text the daemon passes.
  override async steer(...texts: string[]): Promise<void> { this.steers.push(...texts); }
  override async resolveApproval(): Promise<void> { /* the session continues when the test emits its next event */ }
}

export class ZeroHitAdapter extends BotStubAdapter {
  override readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi', supportsDispatchSelection: true, requiresMcpToolsetToolObservation: true,
    capabilities: { steer: true, resume: false, mcpToolsets: true, approvalInteractive: false },
  });
  override readonly sessions = new Map<string, ZeroHitSession>();
  override async prepare(_input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    return { kind: 'prepared', operation: { start: async (input) => {
      const session = new ZeroHitSession(input); this.starts.push(input);
      this.sessions.set(input.manifest.taskId, session); return session;
    } } };
  }
}
