import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { Context } from '@earendil-works/chord';
import { ExecutionError, ok, err, type ShellExecOptions, type ShellExecResult, type Result } from '@earendil-works/pi-durable/env';
import type { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { disposeOwnedProcessTree } from '../process-tree';

// Only defer a suffix that can still become a valid UTF-8 character.
function utf8Boundary(chunk: Buffer): number {
  let start=chunk.length-1;
  while(start>=0&&chunk.length-start<=3&&(chunk[start]!&0xc0)===0x80)start--;
  if(start<0)return chunk.length;
  const lead=chunk[start]!,length=lead>=0xc2&&lead<=0xdf?2:lead>=0xe0&&lead<=0xef?3:lead>=0xf0&&lead<=0xf4?4:0;
  if(!length||chunk.length-start>=length)return chunk.length;
  const second=chunk[start+1];
  if(second!==undefined&&((lead===0xe0&&second<0xa0)||(lead===0xed&&second>0x9f)||(lead===0xf0&&second<0x90)||(lead===0xf4&&second>0x8f)))return chunk.length;
  return start;
}

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
    const stdout={decoder:new StringDecoder('utf8'),pending:Buffer.alloc(0),name:'stdout' as const},stderr={decoder:new StringDecoder('utf8'),pending:Buffer.alloc(0),name:'stderr' as const};
    const consume = (chunk: Buffer,stream:typeof stdout | typeof stderr) => {
      child.stdout!.pause(); child.stderr!.pause();
      outputWork = outputWork.then(async () => {
        options?.onOutput?.(stream.decoder.write(chunk), context, { stream: stream.name });
        bytes += chunk.length; lines += chunk.toString('utf8').split('\n').length - 1;
        if (options?.spill) {
          const raw=stream.pending.length?Buffer.concat([stream.pending,chunk]):chunk,boundary=utf8Boundary(raw);
          stream.pending=Buffer.from(raw.subarray(boundary));
          const part=raw.subarray(0,boundary);
          if (!spilled && (bytes > options.spill.afterBytes || lines + (bytes ? 1 : 0) > options.spill.afterLines)) {
            const created = await env.createTempFile({ prefix: 'pi-output-', suffix: '.log' }, context);
            if (!created.ok) throw created.error;
            spillPath = created.value; output = createWriteStream(spillPath, { flags: 'a' });
            output.on('error',()=>{state.failure??=new ExecutionError('unknown','Unable to preserve durable shell output');abort();});
            outputDone=finished(output,{cleanup:true}).catch(()=>{});
            for (const part of prefix) {if(output.destroyed)throw new Error('durable spill closed');if (!output.write(part)) await once(output, 'drain');}
            prefix = []; spilled = true;
          }
          if (spilled) {if(output!.destroyed)throw new Error('durable spill closed');if (!output!.write(part)) await once(output!, 'drain'); }
          else prefix.push(part);
        }
      }).catch(() => { state.failure ??= new ExecutionError('callback_error', 'Durable shell output failed'); abort(); }).finally(() => { child.stdout!.resume(); child.stderr!.resume(); });
    };
    child.stdout!.on('data',chunk=>consume(chunk,stdout)); child.stderr!.on('data',chunk=>consume(chunk,stderr));
    child.stdin!.on('error', () => { state.failure ??= new ExecutionError('spawn_error', 'Durable shell command pipe closed'); });
    let foregroundEnded = false;
    const foreground = new Promise<void>(resolve => {
      const end = () => { foregroundEnded = true; if (timeout) clearTimeout(timeout); resolve(); };
      child.once('error', () => { state.failure ??= new ExecutionError('spawn_error', 'Unable to spawn durable shell'); end(); });
      child.once('exit', value => { code = value; end(); });
    });
    try {
      if (!child.pid) throw new Error('durable shell missing pid');
      // The journal/ownership ACK happens BEFORE the fixed gate executes any tool code.
      await own(child.pid);
      if (context.abortSignal?.aborted || hasFailure()) throw new Error('durable shell admission ended');
      if (!foregroundEnded && options?.timeout !== undefined) timeout = setTimeout(() => { state.failure ??= new ExecutionError('timeout', 'Command timed out'); void dispose().catch(() => {}); }, options.timeout * 1_000);
      child.stdin!.end('byok-durable-shell\n');
      await foreground;
      // Descendants can keep stdio open after foreground exit. Dispose the
      // owned group before waiting for its final close/output-drain receipt.
      await dispose(); quiesced = true;
      await outputWork;
      for(const stream of [stdout,stderr]){
        try{const tail=stream.decoder.end();if(tail)options?.onOutput?.(tail,context,{stream:stream.name});}catch{state.failure??=new ExecutionError('callback_error','Durable shell output failed');}
        try{if(output&&stream.pending.length){if(output.destroyed)throw new Error('durable spill closed');if(!output.write(stream.pending))await once(output,'drain');}}catch{state.failure??=new ExecutionError('callback_error','Durable shell output failed');}
      }
      if (output) { if(!output.destroyed)output.end();await outputDone; }
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
