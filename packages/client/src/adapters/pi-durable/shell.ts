import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import type { Context } from '@earendil-works/chord';
import { ExecutionError, ok, err, type ShellExecOptions, type ShellExecResult, type Result } from '@earendil-works/pi-durable/env';
import type { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { disposeOwnedProcessTree } from '../process-tree';

/** Public ExecutionEnv override: bash waits on stdin until the parent owns its actual POSIX group. */
export function durableShell(env: NodeExecutionEnv, shellEnv: NodeJS.ProcessEnv, own: (pid: number) => Promise<void>, released: (pid: number) => void) {
  const active = new Set<() => Promise<void>>();
  const exec = async (command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> => {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'Command aborted'));
    const shell=await fs.access('/bin/bash').then(()=>'/bin/bash',()=>'/bin/sh');
    if(context.abortSignal?.aborted)return err(new ExecutionError('aborted','Command aborted'));
    let child: ChildProcess;
    try { child = spawn(shell, ['-s'], { cwd: options?.cwd ?? env.cwd, env: shellEnv, detached: true, stdio: ['pipe','pipe','pipe'] }); }
    catch (cause) { return err(new ExecutionError('spawn_error', 'Unable to spawn durable shell', cause as Error)); }
    let closed = false, quiesced = false;
    const state: {failure?:ExecutionError}={};
    const hasFailure=()=>state.failure!==undefined;
    const receipt = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= disposeOwnedProcessTree({ child, waitClosed: () => receipt, isClosed: () => closed, label: 'durable shell' });
    active.add(dispose);
    const abort = () => { state.failure ??= new ExecutionError('aborted', 'Command aborted'); void dispose().catch(() => {}); };
    context.abortSignal?.addEventListener('abort', abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let output: import('node:fs').WriteStream | undefined, spillPath: string | undefined;
    let bytes = 0, lines = 0, spilled = false, code: number | null = null;
    // Bound memory; keep raw output on disk only when the public spill option asks for it.
    let prefix: Buffer[] = [];
    let outputWork = Promise.resolve();
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    const consume = (text: string) => {
      const chunk=Buffer.from(text);
      child.stdout!.pause(); child.stderr!.pause();
      outputWork = outputWork.then(async () => {
        options?.onOutput?.(chunk.toString('utf8'), context);
        bytes += chunk.length; lines += chunk.toString('utf8').split('\n').length - 1;
        if (options?.spill) {
          if (!spilled && (bytes > options.spill.afterBytes || lines + (bytes ? 1 : 0) > options.spill.afterLines)) {
            const created = await env.createTempFile({ prefix: 'pi-output-', suffix: '.log' }, context);
            if (!created.ok) throw created.error;
            spillPath = created.value; output = createWriteStream(spillPath, { flags: 'a' });
            output.on('error', abort);
            for (const part of prefix) if (!output.write(part)) await once(output, 'drain');
            prefix = []; spilled = true;
          }
          if (spilled) { if (!output!.write(chunk)) await once(output!, 'drain'); }
          else prefix.push(chunk);
        }
      }).catch(() => { state.failure ??= new ExecutionError('callback_error', 'Durable shell output failed'); abort(); }).finally(() => { child.stdout!.resume(); child.stderr!.resume(); });
    };
    child.stdout!.on('data', consume); child.stderr!.on('data', consume);
    child.stdin!.on('error', () => { state.failure ??= new ExecutionError('spawn_error', 'Durable shell command pipe closed'); });
    child.once('error', () => { state.failure ??= new ExecutionError('spawn_error', 'Unable to spawn durable shell'); });
    child.once('exit', value => { code = value; });
    try {
      if (!child.pid) throw new Error('durable shell missing pid');
      // This journal/ownership ACK happens BEFORE any tool command enters bash.
      await own(child.pid);
      if (context.abortSignal?.aborted || hasFailure()) throw new Error('durable shell admission ended');
      if (options?.timeout !== undefined) timeout = setTimeout(() => { state.failure ??= new ExecutionError('timeout', 'Command timed out'); void dispose().catch(() => {}); }, options.timeout * 1_000);
      child.stdin!.end(command + '\n');
      await receipt; await outputWork;
      if (output) { output.end(); await once(output, 'finish'); }
      await dispose(); quiesced = true; // includes background descendants, even after bash exits
      if (state.failure) { state.failure.spillPath = spillPath; return err(state.failure); }
      return ok({ exitCode: code ?? 1, ...(spillPath ? { spillPath } : {}) });
    } catch (cause) {
      await dispose(); quiesced = true;
      return err(state.failure ?? new ExecutionError('aborted', 'Durable shell admission refused', cause as Error));
    } finally {
      if (timeout) clearTimeout(timeout);
      context.abortSignal?.removeEventListener('abort', abort); active.delete(dispose);
      if (quiesced && child.pid) released(child.pid);
      if (output && !output.closed) output.destroy();
    }
  };
  return { exec, cleanup: async () => { await Promise.all([...active].map(dispose => dispose())); } };
}
