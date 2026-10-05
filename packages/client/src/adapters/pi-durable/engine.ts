import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, defineDoc, hook, ToolTask, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type ToolRegistration } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import { durableToolEnvironment } from './environment';
import { durableToolDenial } from './guard';
import { acquireReplicaLock, resetReplica, type DurableReplicaBinding } from './replica';
import { openLocalDurableStorage, type DurableStorageFactory } from './storage';

export const DurableResult = defineDoc({ kind: 'byok.result', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ text: '' }) });
export interface DurableEngineInput {
  file: string; replicaRoot: string; binding: DurableReplicaBinding;
  models: Models; model: { provider: string; modelId: string }; instruction: string;
  resume: boolean; tools?: readonly ToolRegistration[]; ambient: NodeJS.ProcessEnv;
  storageFactory?: DurableStorageFactory<string>;
  shellOwnership?: { own(pid:number):Promise<void>; released(pid:number):void };
  beforeTool(id: string, taskId: string, call: ToolCall): Promise<void>;
  events(events: readonly AgentEvent[]): Promise<void>;
  result(value: Readonly<{ text: string }>): Promise<void>;
}
/** The worker owns the lock until Harness, tools and storage have quiesced. */
export async function openDurableEngine(input: DurableEngineInput) {
  const ctx = BACKGROUND_CONTEXT;
  const lock = await acquireReplicaLock(input.file, input.binding.leaseId);
  const env = durableToolEnvironment(input.binding.canonicalHome, input.ambient, input.shellOwnership);
  let harness: Harness | undefined;
  let closed = false;
  let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
  const close = async () => {
    if (closed) return;
    // Keep lock on failure: only process-tree death releases unresolved ownership.
    if (harness) await harness.close(ctx);
    if (stream) await stream.stop();
    await env.cleanup(ctx);
    lock.release(); closed = true;
  };
  try {
    if (!input.resume) await resetReplica(input.file); // BEFORE open: no stale scheduler may run.
    const tools = [...(CodingTools.tools ?? []), ...(input.tools ?? [])].map(tool => ({ ...tool, replay: 'unsafe' as const, ...(['read','write','edit'].includes(tool.name) ? { executionMode: 'sequential' as const } : {}) }));
    const extension = defineExtension({ name: 'byok-durable', tools, hooks: [hook(ToolTask, {
      beforeTool: async (call, api) => {
        const denied = await durableToolDenial(call.name, call.arguments, input.binding.canonicalHome, input.replicaRoot);
        await input.beforeTool(call.id, `durable:${input.binding.taskId}:${api.taskId}`, call);
        if (denied) return { block: denied }; // parent durable acknowledgement BEFORE native tool intent
      },
    })] });
    const registry = createRegistry(); registry.install(extension);
    harness = await Harness.open(await (input.storageFactory ?? openLocalDurableStorage)(input.file), {
      models: input.models, registry, env: () => env,
      settings: { retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, stream: { maxRetries: 0 } },
    }, ctx);
    // inspect is read-only and never enables scheduling. Unknown replica work cannot grant authority.
    const inspection = await harness.inspect(ctx);
    if (inspection.submissions.some(submission => submission.requestId !== input.binding.taskId || submission.conversationId !== ROOT_CONVERSATION_ID)
      || inspection.tasks.some(task => task.record.conversationId !== ROOT_CONVERSATION_ID || task.record.kind !== 'pi.generation')) throw new Error('durable replica contains unknown submission or interrupted tool');
    const root = await harness.root(ctx, { agent: { model: input.model, extensions: [extension], tools, cwd: input.binding.canonicalHome } });
    stream = await watchEvents(harness, root.id, ctx);
    // Only final persisted usage is additive on attachment; transcript/tool history stays silent.
    if (input.resume) for (const entry of stream.snapshot.entries) if (entry.kind === 'pi.assistant') await input.events([{ type: 'message_end', entry }]);
    let answer = '';
    let failed = false;
    stream.start(async events => {
      for (const event of events) {
        if (event.type === 'snapshot') continue;
        if (event.type === 'task_failed' || event.type === 'auto_retry_start' || event.type === 'compaction_start') failed = true;
        if (event.type === 'message_end' && event.entry.kind === 'pi.assistant') {
          const message = event.entry.model?.[0];
          if (message?.role === 'assistant' && message.stopReason === 'stop') answer = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
        }
        // Result persistence and task success are decided after idle, never by a per-model turn.
        if (event.type !== 'run_end') await input.events([event]);
      }
    });
    const run = async () => {
      if (input.resume) {
        // Repeat submit with stable requestId: reacquires an existing settlement after a crash at run_end.
        const submission = await root.submit({ type: 'input', content: input.instruction, requestId: input.binding.taskId, whenBusy: 'reject' }, ctx);
        const settlement = await submission.wait(ctx);
        if (settlement.status !== 'done') throw new Error('durable submission did not finish');
      } else {
        const submission = await root.submit({ type: 'input', content: input.instruction, requestId: input.binding.taskId, whenBusy: 'reject' }, ctx);
        const settlement = await submission.wait(ctx);
        if (settlement.status !== 'done') throw new Error('durable submission did not finish');
      }
      await root.waitForIdle(ctx);
      const stopped = await stream!.stop(); // joins delivered terminal entries before selecting the result
      if (stopped.reason === 'listener_error') throw stopped.error;
      if (failed) throw new Error('durable run failed');
      // A settled answer can be in the ignored attachment snapshot after child recovery.
      if (!answer) {
        const context = await root.context(ctx);
        const last = [...context.messages].reverse().find(message => message.role === 'assistant' && message.stopReason === 'stop');
        if (last?.role === 'assistant') answer = last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      }
      const result = await root.commit(async tx => { const doc = await tx.doc(DurableResult, root.id); doc.text = answer; return { text: doc.text }; }, ctx);
      if (!result) throw new Error('durable result document missing');
      await input.result(result);
    };
    return { run, close, abort: () => root.abort(ctx) };
  } catch (error) { await close(); throw error; }
}
