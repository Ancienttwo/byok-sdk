import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { Context } from '@earendil-works/chord';
import { ExecutionError, ok, err, type ShellExecOptions, type ShellExecResult, type Result } from '@earendil-works/pi-durable/env';
import type { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { disposeOwnedProcessTree } from '../process-tree';

/** Public ExecutionEnv override: a fixed gate waits for parent group ownership before exec of the tool command. */
export function durableShell(env: NodeExecutionEnv, shellEnv: NodeJS.ProcessEnv, own: (pid: number) => Promise<void>, released: (pid: number) => void) {
  const active = new Set<() => Promise<void>>();
  const exec = async (command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> => {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'Command aborted'));
    const shell=await fs.access('/bin/bash').then(()=>'/bin/bash',()=>'/bin/sh');
    if(context.abortSignal?.aborted)return err(new ExecutionError('aborted','Command aborted'));
    let child: ChildProcess;
    const gate='IFS= read -r permit || exit 78; [ "$permit" = byok-durable-shell ] || exit 78; exec "$1" -c "$2" </dev/null';
    try { child = spawn(shell, ['-c',gate,'byok-durable-shell',shell,command], { cwd: options?.cwd ?? env.cwd, env: shellEnv, detached: true, stdio: ['pipe','pipe','pipe'] }); }
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
    let outputDone=Promise.resolve();
    // Bound memory; keep raw output on disk only when the public spill option asks for it.
    let prefix: Buffer[] = [];
    let outputWork = Promise.resolve();
    const stdoutDecoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
    const consume = (chunk: Buffer,decoder:StringDecoder) => {
      child.stdout!.pause(); child.stderr!.pause();
      outputWork = outputWork.then(async () => {
        options?.onOutput?.(decoder.write(chunk), context);
        bytes += chunk.length; lines += chunk.toString('utf8').split('\n').length - 1;
        if (options?.spill) {
          if (!spilled && (bytes > options.spill.afterBytes || lines + (bytes ? 1 : 0) > options.spill.afterLines)) {
            const created = await env.createTempFile({ prefix: 'pi-output-', suffix: '.log' }, context);
            if (!created.ok) throw created.error;
            spillPath = created.value; output = createWriteStream(spillPath, { flags: 'a' });
            output.on('error',()=>{state.failure??=new ExecutionError('unknown','Unable to preserve durable shell output');abort();});
            outputDone=finished(output,{cleanup:true}).catch(()=>{});
            for (const part of prefix) {if(output.destroyed)throw new Error('durable spill closed');if (!output.write(part)) await once(output, 'drain');}
            prefix = []; spilled = true;
          }
          if (spilled) {if(output!.destroyed)throw new Error('durable spill closed');if (!output!.write(chunk)) await once(output!, 'drain'); }
          else prefix.push(chunk);
        }
      }).catch(() => { state.failure ??= new ExecutionError('callback_error', 'Durable shell output failed'); abort(); }).finally(() => { child.stdout!.resume(); child.stderr!.resume(); });
    };
    child.stdout!.on('data',chunk=>consume(chunk,stdoutDecoder)); child.stderr!.on('data',chunk=>consume(chunk,stderrDecoder));
    child.stdin!.on('error', () => { state.failure ??= new ExecutionError('spawn_error', 'Durable shell command pipe closed'); });
    child.once('error', () => { state.failure ??= new ExecutionError('spawn_error', 'Unable to spawn durable shell'); });
    child.once('exit', value => { code = value; });
    try {
      if (!child.pid) throw new Error('durable shell missing pid');
      // The journal/ownership ACK happens BEFORE the fixed gate executes any tool code.
      await own(child.pid);
      if (context.abortSignal?.aborted || hasFailure()) throw new Error('durable shell admission ended');
      if (options?.timeout !== undefined) timeout = setTimeout(() => { state.failure ??= new ExecutionError('timeout', 'Command timed out'); void dispose().catch(() => {}); }, options.timeout * 1_000);
      child.stdin!.end('byok-durable-shell\n');
      await receipt; await outputWork;
      try{for(const decoder of [stdoutDecoder,stderrDecoder]){const tail=decoder.end();if(tail)options?.onOutput?.(tail,context);}}catch{state.failure??=new ExecutionError('callback_error','Durable shell output failed');}
      if (output) { if(!output.destroyed)output.end();await outputDone; }
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
