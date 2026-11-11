import type { TurnCancelResult } from '@byok-sdk/bot-collaboration/host-kit';
import type { ByokServer } from '@byok-sdk/server';
import { BridgeError } from '../../bridge/protocol.ts';
import type { Conversation } from '../k8/conversation.ts';
import type { HostStore } from '../store/store.ts';
import type { BotProfile } from '../store/types.ts';
import type { ConversationBrand, RolePreset } from './catalog.ts';
import { DraftFollowers, type DraftTarget } from './drafts.ts';
import { botViews, conversationItems, openTurns, type BotView, type ConversationView } from './view.ts';

/** How long `changes` holds a call with nothing new. Host shutdown waits for a held call, so it stays short. */
export const CHANGES_HOLD_MS = 1500;

export interface ConversationSnapshot {
  readonly version: number;
  readonly bots: readonly BotView[];
  readonly roles: readonly RolePreset[];
  readonly models: readonly { readonly id: string; readonly label: string }[];
  /** The selected Bot's conversation; absent when no Bot is selected or the Bot is unknown. */
  readonly conversation?: ConversationView;
  /** Some Bot has open work or a profile catching up: the renderer reads again while this holds. */
  readonly busy: boolean;
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value === '') throw new BridgeError('invalid_params', `${name} must be a non-empty string`);
  return value;
};
const record = (params: unknown, method: string): Record<string, unknown> => {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new BridgeError('invalid_params', `${method} needs an object`);
  return params as Record<string, unknown>;
};

/**
 * The Host side of the conversation UI: validates the renderer's params once, runs the store-first commands of
 * {@link Conversation} and K8's owner commands, and projects the view model. `version` counts the changes this Host
 * saw (commands, consumed wakes and messages, drafts); the renderer waits on it with `changes`.
 */
export class ConversationService {
  readonly #conversation: Conversation;
  readonly #store: HostStore;
  readonly #server: Pick<ByokServer, 'tasks'>;
  readonly #brand: ConversationBrand;
  readonly #drafts: DraftFollowers;
  readonly #taskReasons = new Map<string, string>();
  readonly #waiters = new Set<() => void>();
  #version = 0;

  constructor(options: { conversation: Conversation; store: HostStore; server: Pick<ByokServer, 'tasks'>; brand: ConversationBrand }) {
    this.#conversation = options.conversation;
    this.#store = options.store;
    this.#server = options.server;
    this.#brand = options.brand;
    this.#drafts = new DraftFollowers(options.server, () => this.changed());
  }

  /** Something the view reads changed: wake every held `changes` call. */
  changed(): void {
    this.#version += 1;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  close(): void {
    this.#drafts.close();
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  /** Resolves with the version once it moved past `after`, or after {@link CHANGES_HOLD_MS} with the current one. */
  async changes(params: unknown): Promise<{ version: number }> {
    const after = record(params, 'k8.changes').after;
    if (!Number.isSafeInteger(after)) throw new BridgeError('invalid_params', 'k8.changes needs { after: integer }');
    if (this.#version === after) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.#waiters.delete(wake); resolve(); }, CHANGES_HOLD_MS);
        const wake = () => { clearTimeout(timer); resolve(); };
        this.#waiters.add(wake);
      });
    }
    return { version: this.#version };
  }

  async view(params: unknown): Promise<ConversationSnapshot> {
    const { botId } = record(params, 'k8.view');
    if (botId !== null && typeof botId !== 'string') throw new BridgeError('invalid_params', 'k8.view needs { botId: string | null }');
    const version = this.#version;
    const state = this.#conversation.bot.snapshot();
    const bots = botViews(this.#store.bots(), state);
    const selected = bots.find(bot => bot.id === botId);
    const open = selected ? openTurns(state.turns, selected.id) : [];
    // Drafts follow the selected Bot's running Turns only.
    this.#drafts.follow(open.flatMap(turn => {
      const intent = this.#conversation.bot.core.intent(turn.id);
      if (intent?.phase !== 'inflight') return [];
      const target: DraftTarget = { turnId: turn.id, taskId: intent.taskId, deviceId: intent.execution.deviceId, agentRef: intent.execution.payload.agentRef };
      return [target];
    }));
    let conversation: ConversationView | undefined;
    if (selected) {
      const ended = this.#store.turns(selected.id);
      await this.#readTaskReasons(ended.filter(turn => turn.projection.conclusion !== 'succeeded').map(turn => turn.turnId));
      conversation = conversationItems(selected.id, {
        entries: this.#store.transcript(selected.id), ended, open,
        questions: Object.values(state.questions).filter(question => state.turns[question.turnId]?.botId === selected.id),
        drafts: this.#drafts.drafts(), taskReasons: this.#taskReasons,
      });
    }
    return {
      version, bots, roles: this.#brand.roles,
      models: Object.entries(this.#brand.models).map(([id, entry]) => ({ id, label: entry.label })),
      ...(conversation ? { conversation } : {}),
      busy: bots.some(bot => bot.state === 'working' || bot.state === 'profile_updating' || bot.state === 'runtime_unavailable'),
    };
  }

  /** Creates a Bot under the renderer's id (reused on retry) or edits one. K8's snapshot rules and the catalog judge it. */
  async saveBot(params: unknown): Promise<null> {
    const value = record(params, 'k8.saveBot');
    const profile: BotProfile = {
      id: text(value.id, 'id'), name: text(value.name, 'name'), role: text(value.role, 'role'), persona: text(value.persona, 'persona'), model: text(value.model, 'model'),
    };
    await this.#conversation.saveBot(profile);
    this.changed();
    return null;
  }

  async archiveBot(params: unknown): Promise<null> {
    await this.#conversation.archiveBot(text(record(params, 'k8.archiveBot').id, 'id'));
    this.changed();
    return null;
  }

  async send(params: unknown): Promise<{ turnId: string }> {
    const value = record(params, 'k8.send');
    const turnId = await this.#conversation.send(text(value.actionId, 'actionId'), text(value.botId, 'botId'), text(value.text, 'text'));
    this.changed();
    return { turnId };
  }

  clear(params: unknown): null {
    const value = record(params, 'k8.clear');
    this.#conversation.clear(text(value.actionId, 'actionId'), text(value.botId, 'botId'));
    this.changed();
    return null;
  }

  async cancel(params: unknown): Promise<TurnCancelResult> {
    const result = await this.#conversation.bot.cancelTurn(text(record(params, 'k8.cancel').turnId, 'turnId'));
    this.changed();
    return result;
  }

  async answer(params: unknown): Promise<null> {
    const value = record(params, 'k8.answer');
    await this.#conversation.bot.answer(text(value.questionId, 'questionId'), text(value.answer, 'answer'));
    this.changed();
    return null;
  }

  /** The server's display reason of each ended Turn's task terminal, read once: a terminal never changes. */
  async #readTaskReasons(turnIds: readonly string[]): Promise<void> {
    for (const turnId of turnIds) {
      if (this.#taskReasons.has(turnId)) continue;
      const intent = this.#conversation.bot.core.intent(turnId);
      if (!intent) continue;
      const reason = (await this.#server.tasks.get(intent.taskId))?.result?.reason;
      if (reason !== undefined) this.#taskReasons.set(turnId, reason);
    }
  }
}
