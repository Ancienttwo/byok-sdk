import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, hook, ToolTask, LiveDoc, ROOT_CONVERSATION_ID, type Conversation, type ConversationWatch, type EntryRecord, type ToolRegistration } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import { durableToolEnvironment } from './environment';
import { DurableViewProjection, type DurableEvent } from './events';
import { durableToolDenial } from './guard';
import { acquireReplicaLock, resetReplica, type DurableReplicaBinding } from './replica';
import { openLocalDurableStorage, type DurableStorageFactory } from './storage';

export interface DurableEngineInput {
  file: string; replicaRoot: string; binding: DurableReplicaBinding;
  models: Models; model: { provider: string; modelId: string }; instruction: string;
  resume: boolean; tools?: readonly ToolRegistration[]; ambient: NodeJS.ProcessEnv;
  storageFactory?: DurableStorageFactory<string>;
  shellOwnership?: { own(pid:number):Promise<void>; released(pid:number):void };
  /** The SDK scoped file tools of a file-scoped execution; they replace the native read/write/edit. */
  fileTools?: readonly ToolRegistration[];
  beforeTool(id: string, taskId: string, call: ToolCall): Promise<void>;
  /**
   * Asked after the parent recorded the tool intent and before the tool runs;
   * a returned reason blocks the call. A pending answer is an in-flight tool,
   * so a worker crash meanwhile ends the execution without replay.
   */
  authorize?(toolCallId: string, call: ToolCall): Promise<string | undefined>;
  events(events: readonly DurableEvent[]): Promise<void>;
  /** Called once the durable run settled successfully. The structured outcome, if any, went through `submit_result`. */
  completed(): Promise<void>;
}
/**
 * `restartLimit: Infinity` keeps the Pi 1.3 behavior: a task cut off by a crash
 * is run again on the next open, never parked as `restart_limit`.
 */
export const DURABLE_HARNESS_SETTINGS = {
  retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, stream: { maxRetries: 0 }, restartLimit: Infinity,
} as const;
/** No provider attribution headers, as with Pi 1.3; the Harness default attributes requests to pi. */
export const DURABLE_HARNESS_IDENTITY = { attribution: null } as const;
/**
 * The run ended because the host stopped during a model request (`interrupted`)
 * or a task kept being cut off (`restart_limit`). Pi 1.5 does not resend such a
 * request with retries disabled; the execution ends interrupted, not as a model
 * failure.
 */
export class DurableRunInterrupted extends Error {
  constructor(readonly reason: 'interrupted' | 'restart_limit') { super(`durable run ${reason}`); this.name = 'DurableRunInterrupted'; }
}
const INTERRUPTED = new Set(['interrupted', 'restart_limit']);
/** Committed entries in ID order, from `minEntryId` up to `maxEntryId` when given. */
async function entriesFrom(conversation: Conversation, minEntryId: number, maxEntryId?: number): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await conversation.entries({ minEntryId: minEntryId as EntryRecord['id'], ...(maxEntryId === undefined ? {} : { maxEntryId: maxEntryId as EntryRecord['id'] }), order: 'ascending' }, 200, cursor, BACKGROUND_CONTEXT);
    entries.push(...page.items); cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}
/** The worker owns the lock until Harness, tools and storage have quiesced. */
export async function openDurableEngine(input: DurableEngineInput) {
  const ctx = BACKGROUND_CONTEXT;
  const lock = await acquireReplicaLock(input.file, input.binding.leaseId);
  const env = durableToolEnvironment(input.binding.canonicalHome, input.ambient, input.shellOwnership);
  let harness: Harness | undefined;
  let closed = false;
  let stream: ConversationWatch | undefined;
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
    const native = (CodingTools.tools ?? []).filter(tool => input.fileTools === undefined || tool.name === 'bash');
    const tools = [...native, ...(input.fileTools ?? []), ...(input.tools ?? [])].map(tool => ({ ...tool, replay: 'unsafe' as const, ...(['read','write','edit'].includes(tool.name) ? { executionMode: 'sequential' as const } : {}) }));
    const extension = defineExtension({ name: 'byok-durable', tools, hooks: [hook(ToolTask, {
      beforeTool: async (call, api) => {
        const toolCallId = `durable:${input.binding.taskId}:${api.taskId}`;
        const denied = await durableToolDenial(call.name, call.arguments, input.binding.canonicalHome, input.replicaRoot);
        await input.beforeTool(call.id, toolCallId, call);
        const blocked = denied ?? await input.authorize?.(toolCallId, call);
        if (blocked) return { block: blocked }; // parent durable acknowledgement BEFORE native tool intent
      },
    })] });
    const registry = createRegistry(); registry.install(extension);
    harness = await Harness.open(await (input.storageFactory ?? openLocalDurableStorage)(input.file), {
      models: input.models, identity: DURABLE_HARNESS_IDENTITY, registry, env: () => env, settings: DURABLE_HARNESS_SETTINGS,
    }, ctx);
    // inspect is read-only and never enables scheduling. Unknown replica work cannot grant authority.
    const inspection = await harness.inspect(ctx);
    if (inspection.submissions.some(submission => submission.requestId !== input.binding.taskId || submission.conversationId !== ROOT_CONVERSATION_ID)
      || inspection.tasks.some(task => task.record.conversationId !== ROOT_CONVERSATION_ID || task.record.kind !== 'pi.generation')) throw new Error('durable replica contains unknown submission or interrupted tool');
    const root = await harness.root(ctx, { agent: { model: input.model, extensions: [extension], tools, cwd: input.binding.canonicalHome } });
    stream = await root.watch(ctx);
    const projection = new DurableViewProjection(stream.value);
    // Only final persisted usage is additive on attachment; transcript/tool history stays silent.
    if (input.resume) {
      const history = await entriesFrom(root, 0, projection.last);
      await input.events(history.filter(entry => entry.kind === 'pi.assistant').map(entry => ({ type: 'assistant', entry })));
    }
    let failed = false;
    const report = async (events: readonly DurableEvent[]) => {
      if (events.some(event => event.type === 'unexpected' || (event.type === 'tool_end' && event.entry === undefined))) failed = true;
      if (events.length > 0) await input.events(events);
    };
    stream.start(async call => {
      if (call.kind === 'failed') { failed = true; return; }
      const gap = projection.missing(call.value);
      await report(projection.advance(call.value, gap === undefined ? [] : await entriesFrom(root, gap.minEntryId, gap.maxEntryId)));
    });
    const run = async () => {
      // Stable requestId: a repeat submit after a crash at run end reacquires the existing settlement.
      const submission = await root.submit({ type: 'input', content: input.instruction, requestId: input.binding.taskId, whenBusy: 'reject' }, ctx);
      const settlement = await submission.wait(ctx);
      await root.waitForIdle(ctx);
      const stopped = await stream!.stop();
      if (stopped.kind === 'listener_error') throw stopped.error;
      // A stopped watch drops folded values it had not delivered: report what committed state holds beyond them.
      const live = await harness!.snapshot(LiveDoc, root.id, ctx);
      await report(projection.advance({ conversation: stream!.value.conversation, entries: [], docs: live === undefined ? {} : { 'pi.live': live } },
        await entriesFrom(root, projection.last + 1)));
      if (settlement.status !== 'done') {
        if (INTERRUPTED.has(settlement.reason)) throw new DurableRunInterrupted(settlement.reason as 'interrupted' | 'restart_limit');
        throw new Error('durable submission did not finish');
      }
      if (failed) throw new Error('durable run failed');
      // No in-replica result document: a result-document offer's outcome is
      // staged by the daemon through the reserved submit_result tool, and the
      // daemon decides the terminal at turn_end.
      await input.completed();
    };
    return { run, close, abort: () => root.abort(ctx) };
  } catch (error) { await close(); throw error; }
}
