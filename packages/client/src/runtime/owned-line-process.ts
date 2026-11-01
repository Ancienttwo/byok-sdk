import { spawn, type ChildProcessWithoutNullStreams, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  adoptOwnedProcessTree, disposeOwnedProcessTree, rememberOwnedDescendants, withOwnedProcessTree,
} from '../adapters/process-tree';
import { createJsonlLineDecoder } from '../util/jsonl-lines';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

interface SpawnDependencies {
  nativeAssetRoot?: string;
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  jobObject?: { assign(pid: number): Promise<{ release(): void }> };
  /** Names the runtime in disposal and adoption failures. */
  label?: string;
}

/**
 * JSONL transport over the existing BYOK owned-tree adoption/disposal authority.
 * `exitedOnItsOwn`: the process ended before any kill, disposal or transport failure.
 */
// Structural return types keep the BYOK source declaration build independent of the unconnected vendor tree.
export function createOwnedLineProcessSpawn(deps: SpawnDependencies = {}) {
  const label = deps.label ?? 'codex app-server';
  return (command: string, args: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly cwd?: string }) => {
    if (options.env === undefined) throw new Error('owned line process requires an explicit filtered environment');
    const child = (deps.spawnFn ?? spawn)(command, [...args], withOwnedProcessTree({
      ...('cwd' in options ? { cwd: options.cwd } : {}), env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })) as ChildProcessWithoutNullStreams;
    const lineHandlers: Array<(line: string) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    const held: string[] = [];
    let heldBytes = 0;
    let closed = false;
    let released = false;
    let adopted = false;
    let terminationRequested = false;
    let exitedOnItsOwn = false;
    let exitCode: number | null = null;
    let failure: Error | undefined;
    const pendingWrites = new Set<(error: Error) => void>();
    let stderrTail = Buffer.alloc(0);
    let disposal: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closeReceipt = new Promise<void>(resolve => { resolveClosed = resolve; });
    let resolveExit!: (code: number | null) => void;
    let rejectExit!: (error: Error) => void;
    const exited = new Promise<number | null>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    let resolveSpawn!: () => void;
    let rejectSpawn!: (error: Error) => void;
    const spawned = new Promise<void>((resolve, reject) => { resolveSpawn = resolve; rejectSpawn = reject; });
    // Failures still remain visible to awaiters; transport event handling must not create unhandled rejections.
    void spawned.catch(() => {});
    void exited.catch(() => {});

    const cleanup = (): Promise<void> => {
      if (disposal === undefined) {
        disposal = disposeOwnedProcessTree({ child, waitClosed: () => closeReceipt, isClosed: () => closed, label }).catch(error => { disposal = undefined; throw error; });
      }
      return disposal;
    };
    const kill = (): void => { terminationRequested = true; void cleanup().catch(error => { failure ??= error instanceof Error ? error : new Error(String(error)); }); };
    const fail = (error: Error): void => {
      failure ??= error;
      for (const reject of [...pendingWrites]) reject(error);
      lines.stop(); held.length = 0; heldBytes = 0;
      rejectSpawn(error);
      kill();
    };
    const lines = createJsonlLineDecoder({
      maxLineBytes: MAX_LINE_BYTES,
      onLine: line => deliver(line),
      onOverflow: () => fail(new Error('owned line process frame exceeded its byte budget')),
    });
    const deliver = (line: string): void => {
      if (failure !== undefined) return;
      if (!adopted || lineHandlers.length === 0) {
        const bytes = Buffer.byteLength(line);
        if (heldBytes + bytes > MAX_BUFFERED_BYTES) { fail(new Error('owned line process registration buffer exceeded its byte budget')); return; }
        held.push(line); heldBytes += bytes;
        return;
      }
      for (const handler of lineHandlers) {
        try { handler(line); }
        catch (error) {
          // The callback throws to this transport boundary; the rejected exit receipt preserves the failure.
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    };
    const flush = (): void => {
      if (!adopted || lineHandlers.length === 0 || failure !== undefined) return;
      const ready = held.splice(0); heldBytes = 0;
      for (const line of ready) deliver(line);
    };
    child.stdout.on('data', (chunk: Buffer) => { if (failure === undefined) lines.push(chunk); });
    // Drain stderr without retaining unbounded output or inheriting daemon stdio.
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = Buffer.concat([stderrTail,chunk]).subarray(-64*1024); });
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.once('error', fail);
    child.once('spawn', () => {
      void adoptOwnedProcessTree({ child, label, platform: deps.platform, jobObject: deps.jobObject, nativeAssetRoot: deps.nativeAssetRoot }).then(() => {
        adopted = true;
        resolveSpawn();
        flush();
      }, fail);
    });
    child.once('close', (code: number | null) => {
      if (closed) return;
      closed = true; exitCode = code; resolveClosed();
      exitedOnItsOwn = !terminationRequested && failure === undefined;
      for (const reject of [...pendingWrites]) reject(failure ?? new Error('owned line process closed during write'));
      // exited is a tree-quiescence receipt, not merely a root exit event.
      void cleanup().then(() => undefined, error => { failure ??= error instanceof Error ? error : new Error(String(error)); }).then(() => {
        released = true;
        if (!adopted) rejectSpawn(failure ?? new Error('owned line process exited before adoption'));
        for (const handler of exitHandlers) {
          try { handler(exitCode); }
          catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
        }
        if (failure !== undefined) rejectExit(failure); else resolveExit(exitCode);
      });
    });
    return {
      spawned, exited, kill,
      dispose: (): Promise<void> => { terminationRequested = true; return cleanup(); },
      get exitedOnItsOwn() { return exitedOnItsOwn; },
      /** Before an ACP native cancel: its tools stay killable at disposal after the cancel orphans them. */
      observeDescendants: (): void => rememberOwnedDescendants(child),
      exitError: () => failure ?? new Error(`app-server exited (code=${exitCode})${stderrTail.length ? `; stderr: ${stderrTail.toString('utf8').trim()}` : ''}`),
      write(text: string) {
        if (!adopted || closed || failure !== undefined) throw failure ?? new Error('owned line process is not writable');
        child.stdin.write(text);
      },
      /** Native replies have no RPC ACK; expose the stdin completion receipt to their deadline owner. */
      writeAcknowledged(text: string): Promise<void> {
        if (!adopted || closed || failure !== undefined) return Promise.reject(failure ?? new Error('owned line process is not writable'));
        return new Promise<void>((resolve, reject) => {
          const rejectWrite = (error: Error) => { pendingWrites.delete(rejectWrite); reject(error); };
          pendingWrites.add(rejectWrite);
          try {
            child.stdin.write(text, error => {
              if (error) fail(error);
              else { pendingWrites.delete(rejectWrite); resolve(); }
            });
          } catch (cause) { fail(cause instanceof Error ? cause : new Error(String(cause))); }
        });
      },
      onLine(handler: (line: string) => void) { lineHandlers.push(handler); flush(); },
      onExit(handler: (code: number | null) => void) {
        if (released) queueMicrotask(() => handler(exitCode)); else exitHandlers.push(handler);
      },
    };
  };
}

/** Callers supply RuntimeAdapter.runtimeEnvironment output; this function never merges ambient env. */
export const spawnOwnedLineProcess = createOwnedLineProcessSpawn();
