import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { sealRuntimeOperationManifest, isRuntimeStartupDisposalFailure, RuntimeStartupDisposalFailure, type Session } from '@byok-sdk/client';
import { CodexAdapter } from '@byok-sdk/client/adapters';
import { TerminalInteractionHost } from './terminal-host';
import { fixtureScenarios, type FixtureScenario } from './scenarios';

export { TerminalInteractionHost } from './terminal-host';
export { fixtureScenarios, type FixtureScenario } from './scenarios';
export interface FixtureHostOptions {
  readonly scenario: FixtureScenario;
  readonly input: Readable;
  readonly output: Writable;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Synthetic protocol frames only. Never use this facility for a live transport. */
  readonly fixtureReceiptPath?: string;
}

/**
 * Offline-only executable composition. There is intentionally no caller-provided
 * executable, instruction, workspace, provider, credentials, MCP config or live mode.
 */
export async function startFixtureHost(options: FixtureHostOptions): Promise<{
  host: TerminalInteractionHost; session: Session; done: Promise<void>; close(): Promise<void>;
}> {
  if (!fixtureScenarios.includes(options.scenario)) throw new Error('unknown fixture scenario');
  options.signal?.throwIfAborted();
  const host = new TerminalInteractionHost(randomUUID(), randomUUID(), options.output, options.timeoutMs);
  let workspace: string | undefined;
  const removeWorkspace = async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); };
  // This exact mode is required by the current SDK; it is safe here ONLY because
  // the fixed fixture never executes tools or calls a provider. It is not a sandbox.
  const policy = { mode: 'auto' as const };
  const instruction = 'Synthetic native-interaction fixture. Do not execute any command.';
  const env = { PATH: process.env.PATH, FAKE_HOST_SCENARIO: options.scenario,
    ...(options.fixtureReceiptPath ? { FAKE_HOST_RECEIPT: options.fixtureReceiptPath } : {}) };
  let started: Session | undefined;
  let detachAbort = () => {};
  try {
    const command = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
    const adapter = new CodexAdapter({ resolveBin: () => ({ command, source: 'path' }),
      nativeInteractions: host.nativeInteractions });
    workspace = await mkdtemp(path.join(tmpdir(), 'byok-codex-reference-'));
    const prepared = await adapter.prepare({ offer: { instruction, policy }, policy,
      descriptor: adapter.descriptor, requiredToolsetIds: [] });
    if (prepared.kind === 'reject') throw new Error('fixture adapter refused');
    host.assertOutputAvailable();
    options.signal?.throwIfAborted();
    const manifest = sealRuntimeOperationManifest({ taskId: host.taskId, runtimeId: 'codex',
      descriptor: adapter.descriptor, policy, requiredToolsetIds: [],
      workspace: { workspaceDir: workspace }, forwardedEnvironmentNames: Object.keys(env).sort() });
    started = await prepared.operation.start({ kind: 'instruction', manifest, instruction, env, signal: options.signal });
    const session = started;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      const attempt = (async () => {
        host.stop();
        options.signal?.removeEventListener('abort', abort);
        // Retain ownership/listeners/workspace until SDK disposal completes.
        await session.close();
        await removeWorkspace();
        host.releaseOutput();
      })();
      closing = attempt;
      void attempt.catch(() => { if (closing === attempt) closing = undefined; });
      return attempt;
    };
    const abort = () => { void close().catch(() => host.write('disposal-failed', {})); };
    options.signal?.addEventListener('abort', abort, { once: true });
    detachAbort = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) { await close(); options.signal.throwIfAborted(); }
    host.bind(session);
    host.write('host', { mode: 'offline-fixture-only', hostSessionId: host.hostSessionId, taskId: host.taskId,
      generation: session.interactions!.generation, sessionRef: session.sessionRef,
      warning: 'Provider requests are untrusted display data. Only local input can answer. Receipts prove a local transport write, not tool execution.' });
    host.assertOutputAvailable();
    host.connectInput(options.input, () => { void close().catch(() => host.write('disposal-failed', {})); });
    host.assertOutputAvailable();
    const done = (async () => {
      try {
        for await (const event of session.events) {
          // Never turn assistant/provider output into control input or persisted logs.
          if (event.type === 'turn_end') { host.write('turn-ended', {}); break; }
        }
      } catch (error) {
        host.write('session-ended', { status: 'failed' }); throw error;
      } finally { await close(); }
    })();
    return { host, session, done, close };
  } catch (error) {
    host.stop(); detachAbort();
    const cleanup = async () => { await removeWorkspace(); host.releaseOutput(); };
    // Startup/output/setup failure may still own a process. Keep the recovery
    // handle, listeners and workspace until disposal has a confirmed receipt.
    if (isRuntimeStartupDisposalFailure(error)) {
      throw new RuntimeStartupDisposalFailure(async () => { await error.retryDisposal(); await cleanup(); }, { cause: error });
    }
    if (started) {
      const owned = started;
      try { await owned.close(); } catch (cause) {
        throw new RuntimeStartupDisposalFailure(async () => { await owned.close(); await cleanup(); }, { cause });
      }
    }
    await cleanup(); throw error;
  }
}
