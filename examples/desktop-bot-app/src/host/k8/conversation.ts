import { createHash } from 'node:crypto';
import {
  BotCollaboration, botCompactVeto, historyRowFromTurn, RetentionRefused, TeamModeError, teamSnapshot as checkTeamSnapshot, type AgentMessageInput, type ContextTurn, type MessageServer, type TeamSnapshot,
} from '@byok-sdk/example-bot-collaboration';
import type { DueWake } from '@byok-sdk/server';
import { HostLedger, type ExecutionTemplate, type Json } from '@byok-sdk/server/execution-core';
import type { HostStore } from '../store/store.ts';
import type { BotProfile, Roster, TurnProjection } from '../store/types.ts';

type BotServer = ConstructorParameters<typeof BotCollaboration>[0] & MessageServer;

/** Retention keeps moved command records for K8's replay window, which K8 requires to be at least seven days. */
const RETENTION_MS = 7 * 86_400_000;

export interface ConversationOptions {
  /** The embedded server. Its `wake.consume` and `agentMessage.consume` must call this conversation's `consume` and `consumeMessage`. */
  readonly server: BotServer;
  readonly productId: string;
  /** The K8 ledger file, beside the Host store under `<hostStorageRoot>/host/`. The conversation opens and closes it. */
  readonly ledgerFile: string;
  readonly store: HostStore;
  /** K8's base template. Its `agentRef.agentId` names K8's default Bot, which every call here overrides. */
  readonly execution: ExecutionTemplate;
  /** The brand catalog as K8 `models`: a Bot's `model` is one of these keys. */
  readonly models: Readonly<Record<string, ExecutionTemplate>>;
  readonly now?: () => number;
}

/** The accepted reply of a Turn whose outcome committed, read back from the server and checked against K8's acceptance record. */
export class ReplyReadbackError extends Error {
  readonly turnId: string;
  constructor(turnId: string, reason: string) {
    super(`Reply of Turn ${turnId}: ${reason}`);
    this.turnId = turnId;
    this.name = 'ReplyReadbackError';
  }
}

function teamSnapshot(roster: Roster): TeamSnapshot {
  return { revision: roster.revision, bots: roster.bots.map(bot => ({ ...bot, mainBot: false })) };
}
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * K8 integration (#1499 s1.4): K8 `BotCollaboration` in `team: 'external'` mode with the Host store as team and history
 * authority. The store is written first and K8 second, so a restart can always finish a command from the store.
 */
export class Conversation {
  private readonly options: ConversationOptions;
  readonly bot: BotCollaboration;
  /** K8's current `models`: `options.models` until {@link setModels} replaces them. */
  private models: Readonly<Record<string, ExecutionTemplate>>;
  private constructor(options: ConversationOptions, bot: BotCollaboration) {
    this.options = options;
    this.bot = bot;
    this.models = options.models;
  }

  /** Opens K8, sends the store's roster, recovers K8 and finishes every send that the store holds but K8 may not. */
  static async open(options: ConversationOptions): Promise<Conversation> {
    let conversation: Conversation | undefined;
    const bound = () => {
      if (!conversation) throw new Error('Conversation is not open yet');
      return conversation;
    };
    const ledger = new HostLedger(options.ledgerFile, `product:${options.productId}`, { compactVeto: botCompactVeto });
    let bot: BotCollaboration;
    try {
      bot = new BotCollaboration(options.server, ledger, {
        botId: options.execution.payload.agentRef.agentId, execution: options.execution, models: { ...options.models },
        team: 'external',
        // The template has no connectors, so no Turn is offered `confirmable_action` and no routine actions (#1499 s1.4).
        outcome: { actions: { turn: ['delegate', 'ask_user'] } },
        connector: async () => { throw new Error('This Host has no connectors'); },
        history: input => bound().history(input),
        onOutbox: signal => bound().settle(signal),
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (error) {
      ledger.close();
      throw error;
    }
    conversation = new Conversation(options, bot);
    try {
      await conversation.applyRoster(options.store.roster());
      await bot.recover();
      for (const input of options.store.unboundInputs()) {
        const turnId = bot.inputRoot(input.actionId, input.botId) ?? await bot.input(input.actionId, input.text, input.botId);
        options.store.bindInput(input.actionId, turnId);
      }
      await conversation.settle();
    } catch (error) {
      await conversation.close();
      throw error;
    }
    return conversation;
  }

  /** Server wake consumer. */
  consume(wake: DueWake, signal: AbortSignal): Promise<void> { return this.bot.consume(wake, signal); }
  /** Server Agent message consumer. */
  consumeMessage(input: AgentMessageInput): ReturnType<BotCollaboration['consumeMessage']> { return this.bot.consumeMessage(input); }

  /**
   * One user send, keyed by the renderer's action id (reused on retry). The transcript entry commits before K8 sees the
   * input; an input whose K8 commit is unknown is finished at the next open through `inputRoot`. Returns the Turn id.
   */
  async send(actionId: string, botId: string, text: string): Promise<string> {
    const entry = this.options.store.recordInput(actionId, botId, text);
    if (entry.turnId !== undefined) return entry.turnId;
    const turnId = await this.bot.input(actionId, text, botId);
    this.options.store.bindInput(actionId, turnId);
    return turnId;
  }

  /** Advances the Bot's context epoch. Frozen Turns, K8 cards and questions are untouched. */
  clear(actionId: string, botId: string): void { this.options.store.recordClear(actionId, botId); }

  /**
   * Creates or edits a Bot: the store commits the roster, then K8 receives it. The candidate passes K8's own snapshot check
   * first, and a created or re-pointed Bot needs a catalog template, so K8 never refuses a committed roster at a later open.
   * A Bot whose template left the catalog later keeps it until it is re-pointed: K8 keeps that Bot's Turns blocked.
   */
  async saveBot(profile: BotProfile): Promise<void> {
    await this.applyRoster(this.options.store.saveBot(profile, (candidate, prior) => {
      checkTeamSnapshot(teamSnapshot(candidate));
      if (prior?.model !== profile.model && !Object.hasOwn(this.models, profile.model)) throw new Error(`Unavailable model: ${profile.model}`);
    }));
  }

  /** Replaces K8's catalog. K8 refuses a catalog it cannot take and changes nothing; a Bot whose model left keeps its Turns blocked. */
  async setModels(models: Readonly<Record<string, ExecutionTemplate>>): Promise<void> {
    await this.bot.setModels(models);
    this.models = models;
  }

  /** Archives a Bot for good: the store commits the roster, then K8 receives it. */
  async archiveBot(id: string): Promise<void> { await this.applyRoster(this.options.store.archiveBot(id)); }

  async close(): Promise<void> {
    try {
      await this.bot.close();
    } finally {
      this.bot.ledger.close();
    }
  }

  /** Sends the roster. On `stale_team` the store wins: it moves the roster above K8's revision and sends it again. */
  private async applyRoster(roster: Roster): Promise<void> {
    if (roster.revision === 0) return;
    try {
      await this.bot.applyTeam(teamSnapshot(roster));
    } catch (error) {
      if (!(error instanceof TeamModeError) || error.code !== 'stale_team') throw error;
      await this.bot.applyTeam(teamSnapshot(this.options.store.raiseRevision(this.bot.snapshot().team.external!.revision)));
    }
  }

  /** K8 `history`: the Bot's ended Turns after its clear epoch, with the reply the user saw. Projections flush first. */
  private async history({ botId, turnId }: { botId: string; turnId: string }): Promise<readonly ContextTurn[]> {
    await this.bot.core.flushProjections((id, value) => this.deliver(id, value));
    return this.options.store.history(botId, turnId)
      .map(turn => historyRowFromTurn({ ...turn.projection, ...(turn.reply === undefined ? {} : { reply: turn.reply }) }));
  }

  /** Drains the projections into the store, then retains every root whose Turns ended there. */
  private async settle(signal?: AbortSignal): Promise<void> {
    await this.bot.core.flushProjections((id, value) => this.deliver(id, value));
    for (const root of this.options.store.retainableRoots()) {
      if (signal?.aborted) return;
      try {
        await this.bot.retain({ acknowledgedRoots: [root], now: (this.options.now ?? Date.now)(), retentionMs: RETENTION_MS });
      } catch (error) {
        // A root that a later Turn still uses stays until that Turn ends and is offered again.
        if (error instanceof RetentionRefused && error.code === 'protected_root') continue;
        throw error;
      }
      this.options.store.markRetained(root);
    }
  }

  /**
   * One projection. A `bot-turn:` value updates the Turn record. Its reply joins the transcript only when the intent
   * concluded `succeeded` with the reply's task id (#1499 R1); the body is the server's readback, checked against K8's
   * acceptance record. A throw keeps the projection for the next flush. K8 state holds every other projection's data.
   */
  private async deliver(id: string, value: Json): Promise<void> {
    if (!id.startsWith('bot-turn:')) return;
    const turn = value as unknown as TurnProjection;
    const intent = turn.conclusion === 'succeeded' ? this.bot.core.intent(turn.id) : undefined;
    const accepted = intent?.conclusion === 'succeeded' ? this.bot.snapshot().replies[intent.taskId] : undefined;
    if (!intent || !accepted || accepted.turnId !== turn.id) {
      this.options.store.recordTurn(turn);
      return;
    }
    const message = await this.options.server.tasks.agentMessage?.(intent.taskId, intent.execution.deviceId, intent.execution.payload.agentRef);
    if (!message) throw new ReplyReadbackError(turn.id, 'the server has no message for its task');
    if (message.disposition?.outcome !== 'accepted') throw new ReplyReadbackError(turn.id, 'the server has not accepted its message');
    const payload = message.payload;
    if (!('body' in payload) || typeof payload.body !== 'string') throw new ReplyReadbackError(turn.id, 'the message has no plaintext body');
    if (payload.messageId !== accepted.messageId || payload.contentHash !== accepted.contentHash || sha256(payload.body) !== accepted.contentHash) {
      throw new ReplyReadbackError(turn.id, 'the message does not match the accepted reply');
    }
    this.options.store.recordTurn(turn, { taskId: intent.taskId, text: payload.body });
  }
}
