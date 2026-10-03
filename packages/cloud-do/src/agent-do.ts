import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, type ConversationId } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { openDurableObjectStorage } from './storage';

/** One named DO owns one Harness. No model execution, credentials, tools or wake scheduler in 4a. */
export class AgentDO extends DurableObject {
  readonly #harnessReady: Promise<Harness>;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.#harnessReady = ctx.blockConcurrencyWhile(async () => Harness.open(
      await openDurableObjectStorage(ctx.storage),
      {
        // Do not inherit pi-ai's local environment/file auth discovery in a Worker.
        models: createModels({ authContext: { env: async () => undefined, fileExists: async () => false } }),
        registry: createRegistry(), settings: { compaction: { enabled: false } },
      },
      BACKGROUND_CONTEXT,
    ));
  }

  async open() {
    const harness = await this.#harnessReady;
    return { scheduling: (await harness.inspect(BACKGROUND_CONTEXT)).scheduling };
  }

  /** D1: every call allocates a new ownerless conversation, including after a restart. */
  async openExecution(): Promise<{ conversationId: number }> {
    const harness = await this.#harnessReady;
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    return { conversationId: conversation.id };
  }

  async #execution(id: number) {
    if (!Number.isSafeInteger(id) || id < 2) throw new Error('Invalid execution conversation');
    const conversation = await (await this.#harnessReady).conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error('Unknown execution conversation');
    return conversation;
  }

  /** Passive native pi entries prove storage without starting a model or tool task. */
  async appendExecution(conversationId: number, text: string): Promise<void> {
    if (typeof text !== 'string') throw new Error('Execution text must be a string');
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
}
