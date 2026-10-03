import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, watchEvents, type ConversationId } from '@earendil-works/pi-durable';
import { admitCloudSubmission, hasUserKeyShape } from './admission';
import { CloudDoError, cloudErrorResponse } from './errors';
import { RollingLeakGuard } from './leak-guard';
import { PLATFORM_PROFILES, platformCredentialReader } from './platform-credentials';
import { createPlatformModels } from './platform-provider';
import { openDurableObjectStorage } from './storage';

/** One named DO owns one Harness; 4b adds platform-only text model submissions. */
export class AgentDO extends DurableObject<Record<string, unknown>> {
  #harnessReady?: Promise<Harness>;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
  }

  // Admission and credential preflight happen before even schema initialization.
  #harness(): Promise<Harness> {
    return this.#harnessReady ??= this.ctx.blockConcurrencyWhile(async () => Harness.open(
      await openDurableObjectStorage(this.ctx.storage),
      { models: createPlatformModels(this.env), registry: createRegistry(),
        settings: { compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 }, stream: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT,
    ));
  }

  async open() {
    const harness = await this.#harness();
    return { scheduling: (await harness.inspect(BACKGROUND_CONTEXT)).scheduling };
  }

  /** D1: every call allocates a new ownerless conversation, including after a restart. */
  async openExecution(): Promise<{ conversationId: number }> {
    const harness = await this.#harness();
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    return { conversationId: conversation.id };
  }

  async #execution(id: number) {
    if (!Number.isSafeInteger(id) || id < 2) throw new Error('Invalid execution conversation');
    const conversation = await (await this.#harness()).conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error('Unknown execution conversation');
    return conversation;
  }

  async #admitText(text: string): Promise<void> {
    if (hasUserKeyShape(text)) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
    const credentials = platformCredentialReader(this.env);
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      if (this.env[profile.binding] === undefined) continue;
      const key = await credentials.get(profile.secretName);
      const guard = new RollingLeakGuard(key!);
      try { guard.push(text); guard.finish(); }
      catch { throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED'); }
    }
  }

  /** Passive native pi entries prove storage without starting a model or tool task. */
  async appendExecution(conversationId: number, text: string): Promise<void> {
    if (typeof text !== 'string') throw new Error('Execution text must be a string');
    await this.#admitText(text);
    const conversation = await this.#execution(conversationId);
    await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: 'byok.execution', data: { text } }), BACKGROUND_CONTEXT);
  }

  async readExecution(conversationId: number): Promise<string[]> {
    const conversation = await this.#execution(conversationId);
    const context = await conversation.context(BACKGROUND_CONTEXT);
    return context.entries.filter(entry => entry.kind === 'byok.execution').map(entry => {
      const data = entry.data as { text: string };
      return data.text;
    });
  }

  /** Binding/RPC-only. The consumer authorizes identity before obtaining this stub.
   * Errors are structured Responses so the same code/status survive DO RPC. */
  async submit(input: unknown): Promise<Response> {
    try {
      const admitted = admitCloudSubmission(input);
      const profile = PLATFORM_PROFILES[admitted.profile];
      await platformCredentialReader(this.env).get(profile.secretName);
      // Check every configured platform key before input enters durable storage.
      await this.#admitText(admitted.instruction);
      const harness = await this.#harness();
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
        agent: { model: { provider: admitted.profile, modelId: profile.model }, tools: [] } }, BACKGROUND_CONTEXT);
      const events = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
      const encoder = new TextEncoder();
      let sink: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      let failure: string | undefined;
      let released = '';
      const textBlocks = new Map<number, string>();
      const write = (value: unknown) => { if (!cancelled) sink.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
      const publish = (text: string) => {
        if (text.startsWith(released) && text.length > released.length) {
          write({ type: 'text_delta', delta: text.slice(released.length) }); released = text;
        }
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) { sink = controller; },
        async cancel() { cancelled = true; await conversation.abort(BACKGROUND_CONTEXT); await events.stop(); },
      });
      events.start(async batch => {
        for (const event of batch) {
          if (event.type === 'message_start' && event.message.role === 'assistant') {
            textBlocks.clear();
            event.message.content.forEach((block, index) => { if (block.type === 'text') textBlocks.set(index, block.text); });
            publish([...textBlocks.values()].join(''));
          }
          if (event.type === 'message_update') {
            for (const change of event.changes) {
              if (change.type === 'text_delta') textBlocks.set(change.contentIndex, (textBlocks.get(change.contentIndex) ?? '') + change.delta);
              if ((change.type === 'text_start' || change.type === 'block') && change.block.type === 'text') textBlocks.set(change.contentIndex, change.block.text);
              if (change.type === 'message') {
                textBlocks.clear();
                change.message.content.forEach((block, index) => { if (block.type === 'text') textBlocks.set(index, block.text); });
              }
            }
            publish([...textBlocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join(''));
          }
          if (event.type === 'message_end') {
            const message = event.entry.model?.[0];
            if (message?.role === 'assistant') publish(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
            if (message?.role === 'assistant' && message.stopReason === 'error') {
              failure = message.errorMessage?.includes('CLOUD_MODEL_RESPONSE_REJECTED') ? 'CLOUD_MODEL_RESPONSE_REJECTED' : 'CLOUD_MODEL_REQUEST_FAILED';
            }
          }
          if (event.type === 'task_failed') failure ??= 'CLOUD_MODEL_REQUEST_FAILED';
        }
      });
      const run = async () => {
        try {
          const submission = await conversation.submit({ type: 'input', content: admitted.instruction, whenBusy: 'reject' }, BACKGROUND_CONTEXT);
          const settled = await submission.wait(BACKGROUND_CONTEXT);
          await conversation.waitForIdle(BACKGROUND_CONTEXT);
          const stopped = await events.stop();
          if (settled.status !== 'done' || stopped.reason === 'listener_error') failure ??= 'CLOUD_MODEL_REQUEST_FAILED';
          if (failure) write({ type: 'error', code: failure, retryable: false });
          else write({ type: 'done', conversationId: conversation.id });
        } catch { write({ type: 'error', code: 'CLOUD_MODEL_REQUEST_FAILED', retryable: false }); await events.stop(); }
        finally { if (!cancelled) sink.close(); }
      };
      this.ctx.waitUntil(run());
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
    } catch (error) { return cloudErrorResponse(error); }
  }
}
