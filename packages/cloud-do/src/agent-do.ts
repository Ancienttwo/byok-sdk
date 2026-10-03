import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, watchEvents, type AgentEvent, type ConversationId } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { admitCloudSubmission, hasUserKeyShape } from './admission';
import { CloudDoError, cloudErrorResponse } from './errors';
import { RollingLeakGuard } from './leak-guard';
import { PLATFORM_PROFILES, platformCredentialReader, type PlatformProfileId } from './platform-credentials';
import { createPlatformModels } from './platform-provider';
import { openDurableObjectStorage } from './storage';

function modelFailureCode(message: string | undefined): string {
  if (message === 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE' || message === 'CLOUD_MODEL_RESPONSE_REJECTED') return message;
  return 'CLOUD_MODEL_REQUEST_FAILED';
}

// Pinned pi 1.0 gates both threshold and overflow compaction on enabled.
export const CLOUD_HARNESS_SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0 },
  stream: { maxRetries: 0 },
} as const;

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
}

/** Native watch batches can contain a whole message, a block, or a delta. */
function projectText(blocks: Map<number, string>, event: AgentEvent): string | undefined {
  const replace = (message: AssistantMessage) => {
    blocks.clear();
    message.content.forEach((block, index) => { if (block.type === 'text') blocks.set(index, block.text); });
  };
  if (event.type === 'message_start' && event.message.role === 'assistant') replace(event.message);
  else if (event.type === 'snapshot' && event.generation?.message) replace(event.generation.message);
  else if (event.type === 'message_update') {
    for (const change of event.changes) {
      if (change.type === 'text_delta') blocks.set(change.contentIndex, (blocks.get(change.contentIndex) ?? '') + change.delta);
      if (change.type === 'text_start' || change.type === 'block') {
        if (change.block.type === 'text') blocks.set(change.contentIndex, change.block.text);
        else blocks.delete(change.contentIndex);
      }
      if (change.type === 'message') replace(change.message);
    }
  } else if (event.type === 'message_end' && event.entry.model?.[0]?.role === 'assistant') return assistantText(event.entry.model[0]);
  else return undefined;
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('');
}

/** One named DO owns one Harness; 4b adds platform-only text model submissions. */
export class AgentDO extends DurableObject<Record<string, unknown>> {
  #harnessReady?: Promise<Harness>;

  // Admission and credential preflight happen before even schema initialization.
  #harness(): Promise<Harness> {
    return this.#harnessReady ??= this.ctx.blockConcurrencyWhile(async () => Harness.open(
      await openDurableObjectStorage(this.ctx.storage),
      { models: createPlatformModels(this.env), registry: createRegistry(),
        settings: CLOUD_HARNESS_SETTINGS },
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

  async #admitText(text: string, selected?: PlatformProfileId): Promise<void> {
    if (hasUserKeyShape(text)) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
    const credentials = platformCredentialReader(this.env);
    for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
      let key: string | undefined;
      try {
        if (this.env[profile.binding] === undefined) continue;
        key = await credentials.get(profile.secretName);
      } catch {
        // A broken unused profile does not disable a valid selected provider.
        // Every valid configured key still gets the pre-storage text check.
        if (selected && id !== selected) continue;
        throw new CloudDoError('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
      }
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
      await this.#admitText(admitted.instruction, admitted.profile);
      const harness = await this.#harness();
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
        agent: { model: { provider: admitted.profile, modelId: profile.model }, tools: [] } }, BACKGROUND_CONTEXT);
      const events = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
      const encoder = new TextEncoder();
      // Native byte-stream backpressure/cancellation survives DO RPC transfer.
      const body = new IdentityTransformStream();
      const writer = body.writable.getWriter();
      let cancelled = false;
      let aborting: Promise<void> | undefined;
      let failure: string | undefined;
      let released = '';
      const textBlocks = new Map<number, string>();
      const cancel = () => {
        if (!aborting) {
          cancelled = true;
          // A disconnected consumer has no error channel. Do not expose a raw exception.
          aborting = conversation.abort(BACKGROUND_CONTEXT).finally(() => events.stop()).catch(() => undefined);
        }
        return aborting;
      };
      void writer.closed.catch(cancel);
      const write = async (value: unknown) => {
        if (cancelled) return;
        try { await writer.write(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); }
        catch { void cancel(); }
      };
      // A transferred native stream reports a disconnected peer on its next
      // write. Keep one request-scoped probe in flight. This is not a DO alarm.
      let probing = false;
      const probe = setInterval(() => {
        if (cancelled || probing) return;
        probing = true;
        void writer.write(encoder.encode(': keepalive\n\n')).catch(() => cancel()).finally(() => { probing = false; });
      }, 250);
      const publish = async (text: string) => {
        if (text.startsWith(released) && text.length > released.length) {
          const delta = text.slice(released.length);
          released = text;
          await write({ type: 'text_delta', delta });
        }
      };
      events.start(async batch => {
        for (const event of batch) {
          const text = projectText(textBlocks, event);
          if (text !== undefined) await publish(text);
          if (event.type === 'message_end') {
            const message = event.entry.model?.[0];
            if (message?.role === 'assistant' && message.stopReason === 'error') {
              failure = modelFailureCode(message.errorMessage);
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
          // Backpressure can leave a final watch batch undelivered. Native
          // committed state is the authority for the final text and error code.
          const context = await conversation.context(BACKGROUND_CONTEXT);
          const last = [...context.entries].reverse().find(entry => entry.kind === 'pi.assistant')?.model?.[0];
          if (last?.role === 'assistant') {
            await publish(assistantText(last));
            if (last.stopReason === 'error') failure = modelFailureCode(last.errorMessage);
          }
          if (settled.status !== 'done' || stopped.reason === 'listener_error') failure ??= 'CLOUD_MODEL_REQUEST_FAILED';
          if (failure) await write({ type: 'error', code: failure, retryable: false });
          else await write({ type: 'done', conversationId: conversation.id });
        } catch { await write({ type: 'error', code: 'CLOUD_MODEL_REQUEST_FAILED', retryable: false }); await events.stop(); }
        finally { clearInterval(probe); if (!cancelled) { try { await writer.close(); } catch { void cancel(); } } }
      };
      this.ctx.waitUntil(run());
      return new Response(body.readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
    } catch (error) { return cloudErrorResponse(error); }
  }
}
