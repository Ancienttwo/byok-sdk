import { assertDurableShellOwner, disposeDurableShellGroups } from './process-groups';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { RuntimeOperationInstructionStartInput, Session } from '../../types';
import { piLaunchCommand, type PiRuntimeLaunchResources } from '../pi/runtime-launch';
import type { PiByokLauncherConfig } from '../pi/pi-adapter';
import { serializePiHostConfig } from '../pi/runtime-host-binding';
import { PiRpcClient, type SpawnFn } from '../pi/rpc-client';
import { RuntimeExecutionFailure } from '../../runtime-failure';
import { AsyncQueue } from '../../util/async-queue';
import { admitReplica, resetReplica } from './replica';
import { DurableRecovery } from './recovery';

export interface DurableStart {
  nativeAssetRoot?: string;
  input: RuntimeOperationInstructionStartInput;
  runtimeLaunch: PiRuntimeLaunchResources;
  replicaRoot: string;
  launcher: PiByokLauncherConfig;
  launcherArgs: readonly string[];
  spawnFn?: SpawnFn;
}
/**
 * Every start failure is typed. Reasons are fixed SDK text: a worker error can
 * carry runtime output. A worker that ended on its own before its start
 * receipt is `runtime_exited` (#869); any other start failure is `unknown`.
 */
const startFailure = (category: 'authority' | 'infrastructure', reason = 'durable runtime start failed', exited = false, cause?: unknown) =>
  new RuntimeExecutionFailure({ phase: 'start', category, retry: 'non-retryable', reason,
    failure: { class: exited ? 'runtime_exited' : 'unknown' } }, { cause });
export async function startDurablePi(options: DurableStart): Promise<Session> {
  const { input, runtimeLaunch, launcher } = options;
  const context = input.durableContext;
  const manifest = input.manifest;
  if (!context || !manifest.agentRef || !manifest.lease || runtimeLaunch.credentialSource !== 'keys-profile' || runtimeLaunch.kind !== 'pi-durable'
    || manifest.cwd !== manifest.lease.canonicalHome || input.signal?.aborted) throw startFailure('authority', 'durable requires current Agent lease and credential custody');
  const selection = manifest.dispatchSelection;
  if (!selection || (selection.lane !== 'byok' && selection.lane !== 'byok-profile')) throw startFailure('authority', 'durable requires BYOK selection');
  const binding = { agentRef: { ...manifest.agentRef, tenantId: context.tenantId }, taskId: manifest.taskId, leaseId: manifest.lease.leaseId, canonicalHome: manifest.lease.canonicalHome };
  const configDir = input.scratch.sdkDir;
  let file: Awaited<ReturnType<typeof admitReplica>>;
  try { file = await admitReplica(options.replicaRoot, binding); await fs.chmod(configDir, 0o700); }
  catch (error) { throw startFailure('infrastructure', undefined, false, error); }
  const configPath = path.join(configDir, 'config.json');
  const profileRef = selection.lane === 'byok-profile' ? selection.providerProfile.profileRef : selection.providerId;
  const model = selection.lane === 'byok-profile' ? selection.providerProfile.modelId : selection.modelId;
  const serialized = serializePiHostConfig({ format: 'byok.pi.durable-launch', version: 2,
    replica: binding, replicaRoot: options.replicaRoot,
    provider: `byok-sdk-${profileRef}`, model, instruction: input.instruction,
    mcp: { mcpEnv: input.mcpEnv, mcpServers: input.mcpServers ?? {}, observation: input.mcpToolsetTools ?? {},
      launchCwd: binding.canonicalHome },
  });
  try { await fs.writeFile(configPath, serialized.bytes, { mode: 0o600 }); }
  catch (error) { await input.scratch.release(); throw startFailure('infrastructure', undefined, false, error); }
  const shellGroups = new Set<number>();
  let workerPid: number | undefined;
  const queue = new AsyncQueue<AgentEvent>();
  const recovery = new DurableRecovery(context.lifecycle);
  let rpc: PiRpcClient | undefined;
  let closing = false, completed = false;
  let failure: RuntimeExecutionFailure | undefined;
  let projectionDigest: string | undefined;
  const seenUsage = new Set<string>();
  let disposal: Promise<void> | undefined;
  let pump: Promise<void> | undefined;
  /** The latest spawned worker ended on its own before its start receipt. */
  let exitedBeforeReceipt = false;
  const spawn = async (resume: boolean) => {
    exitedBeforeReceipt = false;
    if (closing || !context.lifecycle.ownsLease()) throw new Error('durable lease ended before spawn');
    const launch = piLaunchCommand(runtimeLaunch, 'pi-durable', serialized.digest, ['--config', configPath],
      { command: launcher.command, args: launcher.args ?? [], profileArgs: options.launcherArgs });
    const child = new PiRpcClient({ command: launch.command, args: launch.args,
      cwd: runtimeLaunch.cwd, env: { ...runtimeLaunch.env }, spawnFn: options.spawnFn, nativeAssetRoot: options.nativeAssetRoot });
    rpc = child;
    let receipt: Awaited<ReturnType<PiRpcClient['send']>>;
    // Read before any disposal: the SDK's own kill also closes the client.
    try { receipt = await child.send({ type: 'start', resume, ...(resume ? { projectionDigest } : {}) }); }
    catch (error) { exitedBeforeReceipt = child.processExited; throw error; }
    if (receipt.success !== true || typeof receipt.projectionDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.projectionDigest) || (resume && receipt.projectionDigest !== projectionDigest)) throw new Error('durable worker refused start or changed provider projection');
    if(typeof receipt.workerPid !== 'number'||!Number.isSafeInteger(receipt.workerPid)||receipt.workerPid<=1)throw new Error('durable worker identity missing');
    workerPid=receipt.workerPid;
    projectionDigest = receipt.projectionDigest;
    return child;
  };
  const close = async () => {
    if (disposal) return disposal;
    closing = true; recovery.stop();
    const attempt = (async () => {
      try { if (rpc) await rpc.dispose(); } finally { await disposeDurableShellGroups(shellGroups); }
      if (pump) await pump; // owned tree receipt before replica cleanup or lease release
      await resetReplica(file);
      await input.scratch.release();
      await runtimeLaunch.release(); queue.end();
    })();
    disposal = attempt.catch(error => { disposal = undefined; throw error; });
    return disposal;
  };
  try {
    const first = await spawn(false);
    pump = (async () => {
      let child = first;
      /** A worker ended on its own, and its recovery is in progress or was refused. */
      let crashed = false;
      try {
        for (;;) {
          let fatal = false;
          for await (const frame of child.events) {
            if (closing) return;
            if(frame.type==='tool_process'){
              if(typeof frame.pid!=='number'||workerPid===undefined||closing||!context.lifecycle.ownsLease())throw new Error('durable shell ownership refused');
              assertDurableShellOwner(frame.pid,workerPid);shellGroups.add(frame.pid);
              if(closing||!context.lifecycle.ownsLease())throw new Error('durable shell lease ended');
              await child.send({type:'shell_ack',pid:frame.pid});
            } else if(frame.type==='tool_process_closed'){
              if(typeof frame.pid!=='number'||!shellGroups.delete(frame.pid))throw new Error('invalid durable shell disposal receipt');
            } else if (frame.type === 'tool_intent') {
              if (typeof frame.toolCallId !== 'string') throw new Error('invalid durable tool intent');
              await recovery.beforeTool(frame.toolCallId);
              await child.send({ type: 'tool_ack', toolCallId: frame.toolCallId });
            } else if (frame.type === 'tool_committed') {
              if (typeof frame.toolCallId !== 'string') throw new Error('invalid durable tool receipt');
              await recovery.committedTool(frame.toolCallId);
            } else if (frame.type === 'agent_event') {
              const event = frame.event as AgentEvent;
              if (!event || typeof event !== 'object' || !['progress','tool_use','tool_result','usage','error'].includes(event.type)) throw new Error('invalid durable event');
              if (event.type === 'usage') {
                if (typeof frame.usageId !== 'string') throw new Error('durable usage missing entry identity');
                if (seenUsage.has(frame.usageId)) continue;
                seenUsage.add(frame.usageId);
              }
              if (event.type === 'error') { fatal = true; break; }
              queue.push(event);
            } else if (frame.type === 'durable_complete') {
              // The terminal rule is the daemon's: a result-document outcome
              // was staged through submit_result, never carried by this frame.
              completed = true; recovery.stop(); queue.push({ type: 'turn_end' }); queue.end(); return;
            } else if (frame.type === 'durable_failed') { fatal = true; break; }
            else throw new Error('unknown durable frame');
          }
          // Read before disposal: the SDK's own kill also closes the client.
          const exited = !fatal && child.processExited;
          try { await child.dispose(); } finally { await disposeDurableShellGroups(shellGroups); } // native lock may be reused only after confirmed tree death
          if (closing || completed) return;
          if (fatal) throw new Error('durable worker failed');
          crashed = exited;
          await recovery.crash();
          crashed = false;
          child = await spawn(true);
        }
      } catch (error) {
        if (!closing) {
          recovery.stop();
          failure = new RuntimeExecutionFailure({ phase: 'run', category: 'authority', retry: 'non-retryable', reason: 'durable runtime failed or recovery was refused',
            failure: { class: crashed || exitedBeforeReceipt ? 'runtime_exited' : 'unknown' } }, { cause: error });
          queue.push({ type: 'error', message: failure.message }); queue.end();
        }
      }
    })();
  } catch (error) {
    const exited = exitedBeforeReceipt;
    await close();
    throw startFailure('infrastructure', undefined, exited, error);
  }
  return { sessionRef: manifest.taskId, events: (async function*(){for await(const event of queue)yield event;if(failure)throw failure;})(),
    resolveApproval: async () => { throw new Error('durable Pi is YOLO-only'); },
    steer: async () => { throw new Error('durable steering is outside slice 1'); },
    followUp: async () => { throw new Error('durable continuation requires a new Host execution'); },
    interrupt: async () => { closing = true; recovery.stop(); rpc?.kill(); try { if(rpc)await rpc.dispose(); } finally { await disposeDurableShellGroups(shellGroups); } queue.end(); }, close,
  };
}
