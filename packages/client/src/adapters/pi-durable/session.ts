import { assertDurableShellOwner, disposeDurableShellGroups } from './process-groups';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { RuntimeOperationInstructionStartInput, Session } from '../../types';
import type { PiRuntimeLaunchResources } from '../pi/runtime-launch';
import type { PiByokLauncherConfig } from '../pi/pi-adapter';
import { serializePiHostConfig } from '../pi/runtime-host-binding';
import { PiRpcClient, type SpawnFn } from '../pi/rpc-client';
import { RuntimeExecutionFailure } from '../../runtime-failure';
import { AsyncQueue } from '../../util/async-queue';
import { admitReplica, resetReplica } from './replica';
import { DurableRecovery } from './recovery';
import { assertImplementationSpawnBinding } from '@byok-sdk/implementation-identity';

export interface DurableStart {
  input: RuntimeOperationInstructionStartInput;
  runtimeLaunch: PiRuntimeLaunchResources;
  replicaRoot: string;
  launcher: PiByokLauncherConfig;
  launcherArgs: readonly string[];
  spawnFn?: SpawnFn;
}
export async function startDurablePi(options: DurableStart): Promise<Session> {
  const { input, runtimeLaunch, launcher } = options;
  const context = input.durableContext;
  const manifest = input.manifest;
  if (!context || !manifest.agentRef || !manifest.lease || runtimeLaunch.credentialSource !== 'keys-profile' || runtimeLaunch.kind !== 'pi-durable'
    || manifest.cwd !== manifest.lease.canonicalHome || input.signal?.aborted) throw new Error('durable requires current Agent lease and credential custody');
  const selection = manifest.dispatchSelection;
  if (!selection || (selection.lane !== 'byok' && selection.lane !== 'byok-profile')) throw new Error('durable requires BYOK selection');
  const binding = { agentRef: { ...manifest.agentRef, tenantId: context.tenantId }, taskId: manifest.taskId, leaseId: manifest.lease.leaseId, canonicalHome: manifest.lease.canonicalHome };
  const file = await admitReplica(options.replicaRoot, binding);
  const configDir = await fs.mkdtemp(path.join(path.dirname(file), 'launch-'));
  await fs.chmod(configDir, 0o700);
  const configPath = path.join(configDir, 'config.json');
  const profileRef = selection.lane === 'byok-profile' ? selection.providerProfile.profileRef : selection.providerId;
  const model = selection.lane === 'byok-profile' ? selection.providerProfile.modelId : selection.modelId;
  const serialized = serializePiHostConfig({ format: 'byok.pi.durable-launch', version: 1,
    binding: runtimeLaunch.binding, replica: binding, replicaRoot: options.replicaRoot,
    provider: `byok-sdk-${profileRef}`, model, instruction: input.instruction,
    mcp: { mcpEnv: input.mcpEnv, mcpServers: input.mcpServers ?? {}, observation: input.mcpToolsetTools ?? {},
      launchCwd: binding.canonicalHome, toolImplementations: input.mcpToolImplementations ?? {} },
  });
  try { await fs.writeFile(configPath, serialized.bytes, { mode: 0o600 }); }
  catch (error) { await fs.rm(configDir, { recursive: true, force: true }); throw error; }
  const shellGroups = new Set<number>();
  let workerPid: number | undefined;
  const queue = new AsyncQueue<AgentEvent>();
  const recovery = new DurableRecovery(context.lifecycle);
  let rpc: PiRpcClient | undefined;
  let closing = false, completed = false;
  let document: unknown;
  let failure: RuntimeExecutionFailure | undefined;
  let projectionDigest: string | undefined;
  const seenUsage = new Set<string>();
  let disposal: Promise<void> | undefined;
  let pump: Promise<void> | undefined;
  const spawn = async (resume: boolean) => {
    const launch = runtimeLaunch.binding;
    await assertImplementationSpawnBinding(launch, { command: launch.command, ...(launch.entry === undefined ? {} : { entry: launch.entry }), fixedArgv: launch.fixedArgv, cwd: launch.cwd, env: runtimeLaunch.env });
    if (closing || !context.lifecycle.ownsLease()) throw new Error('durable lease ended before spawn');
    const child = new PiRpcClient({ command: launcher.command,
      args: [...(launcher.args ?? []), '--pi-bin', launch.command, ...options.launcherArgs, '--runtime-entry', 'pi-durable',
        ...(launch.entry === undefined ? [] : ['--pi-entry', launch.entry]), '--pi-cwd', launch.cwd, '--pi-fixed-args', JSON.stringify(launch.fixedArgv),
        '--launch-binding', JSON.stringify(launch), '--pi-config-digest', serialized.digest, '--', '--config', configPath],
      cwd: launch.cwd, env: { ...runtimeLaunch.env }, spawnFn: options.spawnFn });
    rpc = child;
    const receipt = await child.send({ type: 'start', resume, ...(resume ? { projectionDigest } : {}) });
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
      await fs.rm(configDir, { recursive: true, force: true });
      await runtimeLaunch.release(); queue.end();
    })();
    disposal = attempt.catch(error => { disposal = undefined; throw error; });
    return disposal;
  };
  try {
    const first = await spawn(false);
    pump = (async () => {
      let child = first;
      try {
        for (;;) {
          let fatal = false;
          let receivedResult = false;
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
            } else if (frame.type === 'durable_result') {
              if (receivedResult || !frame.document || typeof frame.document !== 'object') throw new Error('invalid durable result');
              receivedResult = true;
              if (document !== undefined) {
                // A replacement may redeliver a persisted result whose completion
                // frame was lost. Keep the first document and artifact immutable.
                if (!isDeepStrictEqual(document, frame.document)) throw new Error('conflicting durable result');
              } else {
                document = frame.document;
                queue.push({ type: 'artifact', name: 'byok.result', contentType: 'application/json' });
              }
            } else if (frame.type === 'durable_complete') {
              if (document === undefined) throw new Error('durable completion missing result');
              completed = true; recovery.stop(); queue.push({ type: 'turn_end' }); queue.end(); return;
            } else if (frame.type === 'durable_failed') { fatal = true; break; }
            else throw new Error('unknown durable frame');
          }
          try { await child.dispose(); } finally { await disposeDurableShellGroups(shellGroups); } // native lock may be reused only after confirmed tree death
          if (closing || completed) return;
          if (fatal) throw new Error('durable worker failed');
          await recovery.crash();
          child = await spawn(true);
        }
      } catch {
        if (!closing) { recovery.stop(); failure=new RuntimeExecutionFailure({phase:'run',category:'authority',retry:'non-retryable',reason:'durable runtime failed or recovery was refused'}); queue.push({ type: 'error', message: failure.message }); queue.end(); }
      }
    })();
  } catch (error) { await close(); throw error; }
  return { sessionRef: manifest.taskId, events: (async function*(){for await(const event of queue)yield event;if(failure)throw failure;})(),
    resolveApproval: async () => { throw new Error('durable Pi is YOLO-only'); },
    steer: async () => { throw new Error('durable steering is outside slice 1'); },
    followUp: async () => { throw new Error('durable continuation requires a new Host execution'); },
    interrupt: async () => { closing = true; recovery.stop(); rpc?.kill(); try { if(rpc)await rpc.dispose(); } finally { await disposeDurableShellGroups(shellGroups); } queue.end(); }, close,
    resultDocument: () => { if (!completed) throw new Error('durable result is not terminal'); return document; },
  };
}
