import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

/** Tracks the public coalesced Pi UI span, never infers state from timers or isIdle. */
export class PiInteractionGate {
  private phase: 'starting' | 'open' | 'waiting' | 'failed' | 'closed' = 'starting';
  private sessionId: string | undefined;
  private revision = 0;
  private readonly waiters = new Set<() => void>();
  constructor(private readonly emit: (event: { type: 'byok_team_gate'; sessionId?: string; revision: number; phase: string }) => void) {}
  start(sessionId: string): void {
    if (this.phase !== 'starting' || !sessionId) return this.fail();
    this.sessionId = sessionId; this.phase = 'open'; this.report();
  }
  openPrompt(): void {
    if (this.phase !== 'open') return this.fail();
    this.phase = 'waiting'; this.report();
  }
  closePrompt(): void {
    if (this.phase !== 'waiting') return this.fail();
    this.phase = 'open'; this.report();
    for (const resolve of this.waiters) resolve(); this.waiters.clear();
  }
  fail(): void { this.phase = 'failed'; this.report(); }
  close(): void { this.phase = 'closed'; this.report(); }
  private report(): void { this.emit({ type: 'byok_team_gate', ...(this.sessionId ? { sessionId: this.sessionId } : {}), revision: ++this.revision, phase: this.phase }); }
  async wait(signal?: AbortSignal): Promise<void> {
    // Pi publishes span lifecycle through queueMicrotask. Drain events already
    // scheduled before checking the admission state in this process.
    await Promise.resolve();
    while (this.phase !== 'open') {
      // Unknown state never throws into Pi's best-effort extension dispatcher,
      // which would swallow the exception and continue. Host tears down on fatal.
      if (signal?.aborted && this.phase === 'waiting') return;
      await new Promise<void>(resolve => {
        const done = () => { this.waiters.delete(done); signal?.removeEventListener('abort', aborted); resolve(); };
        const aborted = () => { if (this.phase === 'waiting') done(); };
        this.waiters.add(done); signal?.addEventListener('abort', aborted, { once: true });
      });
      // A continuation may open another dialog before its start event runs.
      await Promise.resolve();
    }
  }
}

/** Load first, RPC only. The GUI host owns the process and exact-ID UI responses. */
export default function teamInteractionExtension(pi: ExtensionAPI): void {
  let ui: ExtensionUIContext;
  const gate = new PiInteractionGate(event => ui.setStatus('byok_team_gate', JSON.stringify(event)));
  pi.on('session_start', (_event, ctx) => { ui = ctx.ui; gate.start(ctx.sessionManager.getSessionId()); });
  pi.on('ui_prompt_start', () => gate.openPrompt());
  pi.on('ui_prompt_end', () => gate.closePrompt());
  pi.on('input', async () => { await gate.wait(); return { action: 'continue' }; });
  pi.on('before_provider_request', async (_event, ctx) => { await gate.wait(ctx.signal); });
  pi.on('session_shutdown', () => gate.close());
}
