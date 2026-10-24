import { randomUUID } from 'node:crypto';
import { ownReadOnlyToolsets } from './toolset-policy';
import { admitBotToolsets } from './rules/team';
import { promoteReplyReceipts } from './reply-receipts';
import type { UpdateRoutineAction } from '@byok-sdk/protocol';
import type { ByokServer, CreateByokServerOptions, DueWake } from '@byok-sdk/server';
import { enqueue, HostExecutionCore, settle, type ExecutionServer, type HostOptions, type Intent, type IntentInput, type OutcomeTransaction,
  type MessageTransaction } from '@byok-sdk/example-host-execution-core';
import type { HostJobHandler, Routine } from '@byok-sdk/example-host-execution-core';
import { HostLedger } from '@byok-sdk/example-host-execution-core';
import { canonical, hash, project, setLifecycle, time, type ApplicationRows, type ExecutionTemplate, type Json, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { addTurn, stateOf, type CollaborationState, type Turn } from './model';
import { contextTurns, outcomeOffer, outcomeSchema, SYSTEM_PROMPT, type CheckedOffer, type ContextTurn, type OutcomeOffer } from './schema';
import { DEFAULT_CANCEL_GRACE_MS, DEFAULT_INSTRUCTION_MAX_BYTES,
  intentRows, minimumInstructionBytes, observeDevices, REPLY_UNCERTAIN_AFTER_MS, settleDelegations, type DelegationTimers } from './delegation';
import { cardCallDue, checkReply, collaborationDue, commitCommand, expireCards, replyCheckDue, reportCardDecisions, seatTurn, settleCardCall,
  type Command, type CommandPorts, type CommandStore, type KeylessCommand, type ReplyCheck } from './rules/commands';
import type { CommandRecord } from './rules/commit';
import { CommitConflict, commitInLedger, retainInLedger, syncTurnInLedger, type CommitResult } from './commit';
import type { RetentionInput, RetentionResult } from './retention';
import { BOT_ROUTINE, botRoutines, createDefinition, endable, owned, routineCalendar, routineTurn,
  updateDefinition } from './routines';

import { applyManagement, updateBot, writeSnapshotBot } from './team';
import { botCompactVeto } from './compaction';
import { teamSnapshot, TeamModeError, type TeamSnapshot } from './rules/team';
import { advanceRooms, roomMessages, type Mentions, type RoomMessage } from './rooms';
import type { RoomFields } from '@byok-sdk/protocol';

import { HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS } from './history';
import { flushHomes, type HomeServer } from './home-projections';
import { admitUserInput, coalescePolicy, projectInputBatches, sealDueBatches, type CoalescePolicy } from './coalesce';
import { classifyInbound, inboundKey, isOwner, verified, type ChannelOptions, type Conversation, type InboundClass, type InboundMessage, type Principal, type PrincipalArg } from './channel';
import { acceptDeliveryEcho, readbackDelivery, recoverDelivery, settleDelivery, startDelivery, unknownDelivery } from './delivery';
import { cleanReplyTokens, deliveryRoute, echoCandidates, enablePush, queueDelivery, refuseRoute, rememberInbound, resendUnknown, revokePush } from './delivery-routing';
export interface BotOptions {
  botId: string; execution: ExecutionTemplate; now?: () => number;
  /** Owner principal id (#552 R2). Default `owner`. Only the human principal with this id passes the owner checks. */
  owner?: string;
  /** Optional Host IM outbox. Push stays off until an owner enables a route. */
  channel?: ChannelOptions;
  /** Host-owned model templates. New Bots stay on the selected template's device. */
  models?: Record<string, ExecutionTemplate>;
  /** Host-owned read-only toolset IDs. Default empty. The Host's local tool server must enforce read-only behavior. */
  readOnlyToolsets?: readonly string[];
  /** Must deduplicate by id. A committed confirmation can be replayed after a crash. */
  connector: (id: string, action: string, draft: Json, signal: AbortSignal) => Promise<Json>;
  /** The Host also enforces this limit when a connector ignores cancellation. */
  connectorTimeoutMs?: number;
  contextMaxBytes?: number;
  contextTurnLimit?: number;
  /** UTF-8 bound of a whole bot_request or bot_reply instruction. Construction refuses a value below the proven minimum. */
  instructionMaxBytes?: number;
  /** A cancel with no terminal after this time shows `uncertain` (§8.3). */
  cancelGraceMs?: number;
  /** A claimed chain Turn, or a reply check, with no verdict after this time shows `uncertain` (§8.3). */
  uncertainAfterMs?: number;
  /**
   * Merge consecutive user inputs to a busy Bot into one Turn before K4 enqueue (#551). Absent means off.
   * Defaults: windowMs 10_000, maxItems 8, maxBytes 8192. Construction refuses a value outside
   * windowMs 1000 to 60_000, maxItems 2 to 16, or maxBytes 1024 to contextMaxBytes / 4.
   */
  coalesce?: Partial<CoalescePolicy>;
  /**
   * Handlers for the Host's own K4 Host job routines. They share the core with Bot routines,
   * so their rules use the same calendar: a `RoutineSchedule` whose `tz` is the definition time zone.
   */
  hostJobs?: Readonly<Record<string, HostJobHandler>>;
  /**
   * Handlers of the Host's own K4 intents (#882), by name. `enqueueHostIntent` stores the name with the intent.
   * At a `task.complete` terminal, the handler runs synchronously in the terminal transaction with the result document.
   */
  hostIntents?: Readonly<Record<string, HostIntentHandler>>;
  /** Passed to the K4 core. Default 100. */
  reconcileMs?: number;
  /** Passed to the K4 core: a coalesced hint after a commit that wrote the outbox. */
  onOutbox?: HostOptions['onOutbox'];
  /**
   * External history authority (#739 Q4). Absent: the ContextPack reads this ledger's Turns.
   * Present: before a Bot Turn freezes its offer, the Host reads the Bot's earlier history here, oldest first,
   * in the ContextPack row shape. The rows replace the stored Turns in that ContextPack and are not stored;
   * the Turn keeps only their hash. Cards, questions and rejected actions stay Host state. Room seats read `roomHistory`.
   * A read that throws or returns another shape leaves the Turn queued, and the timer tries again.
   */
  history?: (input: { botId: string; turnId: string }) => Promise<readonly ContextTurn[]>;
  /**
   * External room history authority (#883). Absent: a seat ContextPack reads the room messages of this ledger.
   * Present: before a seat Turn freezes its offer, the Host reads here the room messages that the seat's Bot can see,
   * oldest first. The authority selects them for that Bot. The rows replace `room.messages` in that ContextPack and are
   * not stored; the seat Turn keeps only their hash. `room.messages` is still written, for the request text and mentions.
   * A read that throws, returns another shape or is still open at the seat deadline leaves the seat queued, and the timer
   * tries again until the seat deadline.
   */
  roomHistory?: (input: { roomId: string; botId: string; turnId: string }) => Promise<readonly RoomMessage[]>;
  /**
   * External team authority (#739 Q4c). Absent: this Host creates the Main Bot and owns its local team.
   * `external`: the constructor creates no Bot. `applyTeam` writes the authority's Bot snapshots, and
   * `setMainBot`, `create_bot`, `update_bot` and `delete_bot` refuse with `external_team`. The mode is stored
   * in the ledger, so a ledger cannot change its mode at a restart.
   */
  team?: 'external';
  /**
   * Host persona mode (#879), only with `team: 'external'`. The Host projects each Bot's Agent home itself. A snapshot
   * Bot carries the Host's `profileRevision`, which becomes its agentRef revision, and K8 queues no persona projection.
   * The Host reports an applied revision with `personaReady`. `retryPersona` refuses with `external_persona`.
   * The ledger stores the mode, so a restart cannot change it.
   */
  persona?: 'external';
  /**
   * Outcome offer (#881): allowlists of actions by Turn kind, the IANA time zones of routine actions, and the
   * `confirmable_action` branches. Each field only narrows the default. It applies to Turns frozen after construction.
   */
  outcome?: OutcomeOffer;
}
/** Synchronous. A throw or a thenable leaves the intent open, and `drain()` rejects. */
export type HostIntentHandler = (document: unknown, transaction: OutcomeTransaction) => void;
/**
 * A K4 terminal that K8 cannot apply (#882 Q6f): its key is neither a Bot Turn nor a Host intent, or its Host handler
 * failed. The intent stays open at the head of its FIFO, and each pass rejects with this error, until the outcome applies
 * or the owner calls `failStuckIntent`.
 */
export class IntentOutcomeError extends Error {
  constructor(readonly key: string, readonly code: 'unknown_intent' | 'handler_failed', message: string) { super(message); this.name = 'IntentOutcomeError'; }
}
function hostIntent(state: CollaborationState, key: string): { handler: string } | undefined {
  return state.hostIntents && Object.hasOwn(state.hostIntents, key) ? state.hostIntents[key] : undefined;
}
/** The open K4 intent of `key`. Refuses an unknown or settled key. */
function openIntent(intents: LedgerState['intents'], key: string): Intent {
  const intent = intents[hash(key)];
  if (!intent) throw new Error(`Unknown intent: ${key}`);
  if (intent.conclusion) throw new Error(`Intent already settled: ${key}`);
  return intent;
}
/** Phase 1 of a history-mode sync: the injected rows of each Turn that can freeze its offer next, by Turn id. */
interface InjectedHistory {
  turns: ReadonlyMap<string, { rows: ContextTurn[]; digest: string }>;
  rooms: ReadonlyMap<string, { rows: RoomMessage[]; digest: string }>;
}
/** Reply readback port (§3.3). The Host acceptance record stays the body authority. */
export type MessageServer = { tasks: Partial<Pick<ByokServer['tasks'], 'agentMessage'>> };
export type AgentMessageInput = Parameters<NonNullable<CreateByokServerOptions['agentMessage']>['consume']>[0];

/** A room read still open at the seat deadline counts as a failed read, so the sync can expire the seat (#883). */
function byDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Room history read passed the seat deadline')), Math.max(0, ms)); });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}
/** A Turn that has no offer yet and can freeze one: not concluded or failed, and its Bot is active with its profile applied. */
function awaitsOffer(ledger: LedgerState, state: CollaborationState, turn: Turn): boolean {
  const bot = state.team.bots[turn.botId];
  return !turn.conclusion && !ledger.intents[hash(turn.id)] && turn.status !== 'failed' && !!bot && !bot.archived && bot.readyRevision === bot.revision;
}
/** The value of an accepted disposition. Keyless commands refuse by throwing, so they always accept. */
function valueOf<T>(result: CommitResult): T {
  if (result.disposition.outcome !== 'accepted') throw new Error('Unexpected refused command');
  return result.disposition.value as T;
}
/** The Turn or round id of an input command. These commands never refuse; they throw. */
function turnOf(result: CommitResult): string {
  if (result.disposition.outcome !== 'accepted' || typeof result.disposition.value !== 'string') throw new Error('Input command has no Turn id');
  return result.disposition.value;
}
/** Copy-and-own Host example. Use one instance per ledger tenant. */
export class BotCollaboration {
  readonly core: HostExecutionCore;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly now: () => number;
  private readonly connectorTimeoutMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly contextMaxBytes: number;
  private readonly contextTurnLimit: number;
  private readonly instructionMaxBytes: number;
  private readonly timers: DelegationTimers;
  private readonly coalesce?: CoalescePolicy;
  private readonly offer: CheckedOffer;
  /** The default principal of the owner APIs: the caller that the Host authenticated as the owner. */
  private readonly owner: Principal;
  /** History mode: Turns whose history read failed in this pass. The timer reads them again. */
  private unread = new Set<string>();
  private readonly hostIntentHandlers: ReadonlyMap<string, HostIntentHandler>;
  /** Terminals that could not apply in the current K4 drain, by intent key. K4 also drains from its own timer. */
  private readonly intentFailures = new Map<string, IntentOutcomeError>();
  /** The last audited reason of each refused key, so a stuck intent adds one audit row and not one per pass. */
  private readonly auditedFailures = new Map<string, string>();
  constructor(readonly server: ExecutionServer & HomeServer & MessageServer & Partial<Pick<ByokServer, 'machines'>>, readonly ledger: HostLedger, private readonly options: BotOptions) {
    if (!options.botId || options.execution.payload.agentRef.agentId !== options.botId) throw new Error('Select this Bot Agent');
    // #816: every compaction of this ledger must ask K8 first.
    if (ledger.compactVeto !== botCompactVeto) throw new Error('Open the Host ledger with { compactVeto: botCompactVeto }');
    options = this.options = { ...options, execution: structuredClone(options.execution),
      ...(options.models === undefined ? {} : { models: structuredClone(options.models) }),
      readOnlyToolsets: ownReadOnlyToolsets(options.readOnlyToolsets) };
    admitBotToolsets(options.execution, options.readOnlyToolsets);
    for (const model of Object.values(this.models())) admitBotToolsets(model, options.readOnlyToolsets);
    const persisted = ledger.snapshot(), team = stateOf(persisted.application).team;
    // The team mode is stored in the ledger. A restart cannot change it.
    if (options.team === 'external' ? !team.external && Object.keys(team.bots).length : team.external) {
      throw new Error(`This ledger has ${team.external ? 'an external' : 'a local'} team`);
    }
    if (options.persona !== undefined && (options.persona !== 'external' || options.team !== 'external')) {
      throw new Error("The Host persona mode needs team: 'external'");
    }
    if (team.external && !!team.external.persona !== (options.persona === 'external')) {
      throw new Error(`This ledger has ${team.external.persona ? 'Host' : 'K8'} persona projections`);
    }
    // An archived Bot never runs a new Turn, so its stored template is not "current".
    for (const bot of Object.values(team.bots)) if (!bot.archived) admitBotToolsets(bot.execution, options.readOnlyToolsets);
    // Recovery can resubmit a frozen older generation after the Bot changes models.
    // Historical settled executions remain readable; only outstanding work must be admitted.
    for (const intent of Object.values(persisted.intents)) {
      if (intent.conclusion) continue;
      admitBotToolsets(intent.execution, options.readOnlyToolsets);
      const execution = persisted.executions[intent.taskId];
      if (execution) admitBotToolsets(execution.input, options.readOnlyToolsets);
    }
    this.hostIntentHandlers = new Map(Object.entries(options.hostIntents ?? {}));
    for (const [key, { handler }] of Object.entries(stateOf(persisted.application).hostIntents ?? {})) {
      // A record whose intent K4 compacted is stale until the next pass. It needs no handler.
      const intent = persisted.intents[hash(key)];
      if (intent && intent.conclusion === undefined && !this.hostIntentHandlers.has(handler)) {
        throw new Error(`An open Host intent needs the handler ${handler}`);
      }
    }
    this.owner = { id: options.owner ?? 'owner', kind: 'human' };
    if (!verified(this.owner)) throw new Error('Invalid owner principal');
    this.now = () => time((options.now ?? Date.now)());
    this.connectorTimeoutMs = time(options.connectorTimeoutMs ?? 30_000);
    if (this.connectorTimeoutMs < 1 || this.connectorTimeoutMs > 2_147_483_647) throw new Error('Invalid connector timeout');
    this.deliveryTimeoutMs = time(options.channel?.sendTimeoutMs ?? 15_000);
    if (this.deliveryTimeoutMs < 1 || this.deliveryTimeoutMs > 2_147_483_647) throw new Error('Invalid delivery timeout');
    this.contextMaxBytes = time(options.contextMaxBytes ?? HISTORY_MAX_BYTES);
    this.contextTurnLimit = time(options.contextTurnLimit ?? HISTORY_MAX_ITEMS);
    if (this.contextMaxBytes < 1 || this.contextTurnLimit < 1) throw new Error('Invalid ContextPack limits');
    if (options.coalesce) this.coalesce = coalescePolicy(options.coalesce, this.contextMaxBytes);
    this.offer = outcomeOffer(options.outcome ?? {});
    // Compose once, so a Host draft outside the protocol limits fails here and not at each Turn.
    outcomeSchema(options.botId, stateOf({}), undefined, Object.keys(this.models()), [], this.offer);
    this.instructionMaxBytes = time(options.instructionMaxBytes ?? DEFAULT_INSTRUCTION_MAX_BYTES);
    // A narrowed prompt (#881) keeps a subset of the SYSTEM_PROMPT sentences, so this minimum bounds it too.
    const minimum = minimumInstructionBytes(SYSTEM_PROMPT);
    if (this.instructionMaxBytes < minimum) throw new Error(`instructionMaxBytes must be at least ${minimum}`);
    this.timers = { cancelGraceMs: time(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS), uncertainAfterMs: time(options.uncertainAfterMs ?? REPLY_UNCERTAIN_AFTER_MS) };
    if (this.timers.cancelGraceMs < 1 || this.timers.uncertainAfterMs < 1) throw new Error('Invalid delegation timers');
    this.core = new HostExecutionCore(server, ledger, { now: this.now, reconcileMs: options.reconcileMs ?? 100, nextOccurrence: routineCalendar,
      // No K8 Turn could settle a promoted Host job intent, so L concludes such a result `failed`, as H does (#793 K5).
      ...(options.hostJobs ? { hostJobs: options.hostJobs, hostJobExecution: 'fail' as const } : {}), ...(options.onOutbox ? { onOutbox: options.onOutbox } : {}),
      occurrenceHooks: { [BOT_ROUTINE]: (run, tx) => {
        const state = stateOf(tx.application);
        this.commitCallback(state, run.occurrenceKey, { kind: 'occurrence', key: run.occurrenceKey },
          { publish: tx.publish, occurrence: () => routineTurn(state, run) });
      } },
      applyMessage: (input, tx) => this.applyMessage(input, tx),
      applyOutcome: (document, tx) => this.applyOutcome(document, tx) });
    ledger.transaction(s => {
      const state = stateOf(s.application);
      promoteReplyReceipts(ledger, s, state, this.now());
      if (options.team === 'external') {
        state.team.external ??= { revision: 0, ...(options.persona === 'external' ? { persona: true as const } : {}) };
        return;
      }
      state.team.bots[options.botId] ??= { id: options.botId, name: 'Main Bot', role: 'Team owner', persona: '',
        model: Object.keys(this.models())[0]!, mainBot: true, archived: false,
        revision: options.execution.payload.agentRef.profileRevision, readyRevision: options.execution.payload.agentRef.profileRevision,
        execution: structuredClone(options.execution) };
    });
  }
  private models(): Record<string, ExecutionTemplate> { return this.options.models ?? { default: this.options.execution }; }
  snapshot(): CollaborationState { return stateOf(this.ledger.snapshot().application); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Bot Host is closed'));
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }
  /**
   * Returns the id of the Turn that answers this input. With `coalesce`, it is the batch id
   * (the first batched input's id); that Turn appears when the batch seals.
   * Only the owner starts a 1:1 execution (R2).
   */
  input(key: string, request: string, botId = this.options.botId, ...by: PrincipalArg): Promise<string> {
    return this.exclusive(async () => {
      const principal = this.ownerOnly(by, 'input', botId);
      const result = this.commitOwner(hash(['input', botId, key]), { kind: 'input', botId, key, request, sender: principal.id });
      await this.process();
      return turnOf(result);
    });
  }
  /**
   * IM entry (#552). Classify one message that the channel adapter translated (docs/host-im-adapter.md §3).
   * The input key is `inboundKey(message)`. Only audit rows record a refused or 1:1 bot message.
   * `id` is the Turn id of `owner_input`, or the room input id of `room_input` and `bot_background`.
   */
  async receive(message: InboundMessage): Promise<{ kind: InboundClass; id?: string }> {
    if (this.closed) throw new Error('Bot Host is closed');
    const kind = classifyInbound(message, this.owner.id, this.options.channel?.self), { channel, conversation, platformMessageId, sender } = message;
    if (kind === 'echo') {
      // A send can be waiting for this echo. Do not queue it behind that send.
      this.ledger.transaction(s => {
        const state = stateOf(s.application), matches = echoCandidates(state, message);
        if (matches.length !== 1 || !acceptDeliveryEcho(matches[0]!, platformMessageId)) state.audit.push(`Delivery unmatched_echo: ${channel} ${platformMessageId}`.slice(0, 1024));
        cleanReplyTokens(s, state, this.now());
      });
      return { kind };
    }
    if (kind === 'owner_input' || kind === 'room_input') return this.exclusive(async () => {
      const principal = kind === 'owner_input' ? this.ownerOnly([sender], 'input', conversation.id) : this.verifiedOnly(sender, 'roomInput', conversation.id);
      const key = inboundKey(message);
      const command: Command = kind === 'owner_input'
        ? { kind: 'receive', inbound: kind, key, botId: conversation.id, request: message.text, sender: principal.id }
        : { kind: 'receive', inbound: kind, key, roomId: conversation.id, text: message.text, mentions: message.mentions, from: principal.id };
      const result = this.commitOwner(hash(['receive', key]), command,
        (_s, state) => this.options.channel ? { remember: root => rememberInbound(state, message, root) } : {});
      await this.process();
      return { kind, id: turnOf(result) };
    });
    if (kind === 'bot_background') {
      return { kind, id: await this.roomInput(inboundKey(message), conversation.id, message.text, message.mentions, sender) };
    }
    const who = verified(sender) ? ` ${sender.kind}:${sender.id}` : '';
    await this.exclusive(async () => this.audit(`Inbound ${kind}: ${channel} ${conversation.kind}:${conversation.id} ${platformMessageId}${who}`));
    return { kind };
  }
  /** Owner opt-in for one canonical conversation. Enabling a replacement revokes its old route. */
  enablePushRoute(conversation: Conversation, channel: string, target: string, ...by: PrincipalArg): Promise<string> {
    return this.exclusive(async () => {
      const principal = this.ownerOnly(by, 'enablePushRoute', conversation.id);
      if (!this.options.channel) throw new Error('Channel is not configured');
      return valueOf<string>(this.commitKeyless({ kind: 'enable_push_route', conversation, channel, target, owner: principal.id }));
    });
  }
  revokePushRoute(id: string, ...by: PrincipalArg): Promise<void> {
    return this.exclusive(async () => {
      this.ownerOnly(by, 'revokePushRoute', id);
      this.commitKeyless({ kind: 'revoke_push_route', routeId: id });
      await this.process();
    });
  }
  resendDelivery(id: string, ...by: PrincipalArg): Promise<string> {
    return this.exclusive(async () => {
      this.ownerOnly(by, 'resendDelivery', id);
      if (!this.options.channel) throw new Error('Channel is not configured');
      const next = valueOf<string>(this.commitKeyless({ kind: 'resend_delivery', deliveryId: id }));
      await this.process();
      return next;
    });
  }
  /** Adapter data can be unverified, so one row is at most 1024 characters. */
  private audit(line: string): void {
    this.ledger.transaction(s => { stateOf(s.application).audit.push(line.slice(0, 1024)); });
  }
  /** R2: refuse an unverified principal. The audit row commits before the error. */
  private verifiedOnly(principal: Principal | undefined, action: string, target: string): Principal {
    if (verified(principal)) return principal;
    this.audit(`Action refused unverified_sender: ${action} ${target}`);
    throw new Error(`unverified_sender: ${action} needs a verified principal`);
  }
  /** R2: only the owner principal acts. An omitted principal is the owner. A given `undefined` is unverified. */
  private ownerOnly(by: PrincipalArg, action: string, target: string): Principal {
    const principal = this.verifiedOnly(by.length ? by[0] : this.owner, action, target);
    if (isOwner(principal, this.owner.id)) return principal;
    this.audit(`Action refused not_owner: ${action} ${target} ${principal.kind}:${principal.id}`);
    throw new Error(`not_owner: ${action} needs the owner principal`);
  }
  private applyOutcome(document: unknown, tx: OutcomeTransaction): void {
    const state = stateOf(tx.application), taskId = tx.intent.taskId, key = tx.intent.key;
    const owner = hostIntent(state, key);
    if (owner) return this.applyHostOutcome(key, owner.handler, document, tx);
    // Not a key that K8 wrote. It must never settle as a success.
    if (!Object.hasOwn(state.turns, key)) throw this.intentFailure(key, 'unknown_intent', 'No Bot Turn or Host intent has this key');
    this.commitCallback(state, taskId, { kind: 'outcome', turnId: tx.intent.key, taskId, document: document as Json }, {
      publish: tx.publish,
      ...this.deliverPort(state, taskId),
      outcome: {
        // The terminal transaction has not written yet, so a ledger snapshot is the committed state.
        committed: { intent: key => intentRows(this.ledger.snapshot()).intent(key) },
        manage: (turn, outcome, managed) => applyManagement(state, turn.botId, taskId, outcome, this.models(), managed, this.options.readOnlyToolsets),
        createRoutine: (turn, action, index) => tx.routines.create(createDefinition(tx.routines.list(), turn.botId, taskId, index, action, turn.authority ?? 'bot')),
        updateRoutine: (turn, action) => tx.routines.update(updateDefinition(tx.routines.list(), turn.botId, action)),
        cancelRoutine: (turn, action) => tx.routines.lifecycle(owned(tx.routines.list(), turn.botId, action.routineId).definition.id, 'completed'),
      },
    });
  }
  private applyHostOutcome(key: string, handler: string, document: unknown, tx: OutcomeTransaction): void {
    let result: unknown;
    try { result = this.hostIntentHandlers.get(handler)!(document, tx); } catch (cause) {
      throw this.intentFailure(key, 'handler_failed', cause instanceof Error ? cause.message : String(cause));
    }
    // K4 checks only what K8 returns, so K8 checks the handler. Its promise must not reject unhandled.
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {});
      throw this.intentFailure(key, 'handler_failed', 'Host intent handler must be synchronous');
    }
  }
  private intentFailure(key: string, code: IntentOutcomeError['code'], message: string): IntentOutcomeError {
    const error = new IntentOutcomeError(key, code, message);
    this.intentFailures.set(key, error);
    return error;
  }
  /** The refused terminals of the last K4 drain: one audit row for each new key and reason, and the error of the pass. */
  private reportIntentFailures(): IntentOutcomeError | undefined {
    const failures = [...this.intentFailures.values()], fresh = failures.filter(f => this.auditedFailures.get(f.key) !== f.message);
    if (fresh.length) {
      this.ledger.transaction(s => {
        const state = stateOf(s.application);
        for (const f of fresh) state.audit.push(`Intent outcome refused ${f.code}: ${f.key} ${f.message}`.slice(0, 1024));
      });
      for (const f of fresh) this.auditedFailures.set(f.key, f.message);
    }
    return failures[0];
  }
  /**
   * Host intent (#882): the Host's own work in this tenant's K4 FIFO, with Host authority. One transaction enqueues the
   * intent and records its handler name. Its outcome goes to that handler, never to a Bot Turn. An exact replay returns
   * the same intent. On a Bot's agentRef, it shares that Bot's FIFO.
   */
  enqueueHostIntent(input: IntentInput, handler: string): Promise<Intent> {
    return this.exclusive(async () => {
      if (!this.hostIntentHandlers.has(handler)) throw new Error(`Unknown Host intent handler: ${handler}`);
      // A restart admits every open intent, so a Host intent passes the same toolset admission as a Bot execution.
      admitBotToolsets(input.execution, this.options.readOnlyToolsets);
      this.ledger.transaction(s => {
        const state = stateOf(s.application), owner = hostIntent(state, input.key);
        if (Object.hasOwn(state.turns, input.key)) throw new Error('Host intent identity conflict: the key is a Bot Turn');
        if (owner ? owner.handler !== handler : s.intents[hash(input.key)]) throw new Error('Host intent identity conflict');
        enqueue(s, this.ledger.tenant, input);
        // The key is the Host's string, so it is defined as an own property, never through a setter such as `__proto__`.
        Object.defineProperty(state.hostIntents ??= {}, input.key, { value: { handler }, enumerable: true, writable: true, configurable: true });
      });
      await this.process();
      return this.core.intent(input.key)!;
    });
  }
  /**
   * Owner API (#882): settles as `failed` an open intent whose K4 terminal K8 refuses with `IntentOutcomeError`, so its FIFO
   * moves on. A fresh K4 drain decides that the intent is stuck, so the call also works right after a restart. One transaction
   * settles it and writes the audit row. The settle runs no handler, and the intent records no terminal; the server task
   * keeps it. The drain before the settle applies the terminal once more, so a `handler_failed` handler runs once inside
   * the call. If that drain applies the outcome, the call refuses with `Intent already settled`.
   * A Host intent keeps its `hostIntents` record until K4 compacts it, so an exact replay of `enqueueHostIntent` returns
   * the failed intent. Refuses an unknown key, a settled intent, and an intent whose terminal K8 did not refuse.
   */
  failStuckIntent(key: string, ...by: PrincipalArg): Promise<void> {
    return this.exclusive(async () => {
      this.ownerOnly(by, 'failStuckIntent', key);
      openIntent(this.ledger.snapshot().intents, key);
      this.intentFailures.clear();
      // A scan that stopped early may not have reached this key, so its error is the cause when the key has no refusal.
      const drained = await this.core.drain().then(() => undefined, (error: unknown) => ({ error }));
      const refused = this.intentFailures.get(key);
      this.ledger.transaction(s => {
        const intent = openIntent(s.intents, key);
        if (!refused) throw drained ? drained.error : new Error(`Intent is not stuck: ${key} has no refused terminal`);
        settle(s, intent, 'failed');
        stateOf(s.application).audit.push(`Intent failed by owner ${refused.code}: ${key} ${refused.message}`.slice(0, 1024));
      });
      this.intentFailures.delete(key);
      this.auditedFailures.delete(key);
      await this.process();
    });
  }
  /** The channel outbox port of a K4 callback. Delivery code reads the committed ledger. */
  private deliverPort(state: CollaborationState, taskId: string): Pick<CommandPorts, 'deliver'> {
    if (!this.options.channel) return {};
    return { deliver: (turn, key, text) => queueDelivery(this.ledger.snapshot(), state, turn, taskId, key, text, this.now())?.id };
  }
  /** An owner command in its own ledger transaction. K4 callbacks use `commitCallback` inside the K4 transaction. */
  private commitOwner(commandId: string, command: Command, extra?: (s: LedgerState, state: CollaborationState) => Partial<CommandPorts>): CommitResult {
    return commitInLedger(this.ledger, { scope: this.ledger.tenant, commandId, command }, s => {
      const state = stateOf(s.application);
      return { now: this.now, publish: (key, value) => project(s, key, value), intents: intentRows(s),
        admitInput: fields => admitUserInput(state, fields, this.coalesce, this.now()),
        updatePersona: (botId, persona) => updateBot(state, { botId, persona }, this.models(), this.options.readOnlyToolsets),
        routes: {
          enable: (conversation, channel, target, owner) => enablePush(state, conversation, channel, target, owner, this.now()).id,
          revoke: routeId => revokePush(state, routeId, this.now()),
          resend: deliveryId => resendUnknown(state, deliveryId, this.now()).id,
        }, ...extra?.(s, state) };
    });
  }
  /** A keyless owner command (#739 6a). Its id is new at each call, because the store keeps no record of it. */
  private commitKeyless(command: KeylessCommand): CommitResult { return this.commitOwner(randomUUID(), command); }
  private commitCallback(state: CollaborationState, commandId: string, command: Command, ports: Omit<CommandPorts, 'now'>,
    archived?: CommandStore['archived']): CommitResult {
    return commitCommand(state, { scope: this.ledger.tenant, commandId, command },
      { scope: this.ledger.tenant, recordCallbacks: false, ...(archived ? { archived } : {}) }, { now: this.now, ...ports });
  }

  /**
   * Install as the server's `agentMessage.consume`. One ledger transaction
   * checks the exact binding and records the first acceptance (§3.3).
   */
  async consumeMessage(input: AgentMessageInput): Promise<{ outcome: 'accepted' | 'refused'; reasonCode?: string }> {
    if (this.closed) throw new Error('Bot Host is closed');
    const result = await this.core.consumeMessage(input);
    if (result.outcome === 'accepted') queueMicrotask(() => { if (!this.closed) void this.drain().catch(() => {}); });
    return result;
  }
  private applyMessage(input: AgentMessageInput, tx: MessageTransaction): { outcome: 'accepted' | 'refused'; reasonCode?: string } {
    const state = stateOf(tx.application);
    let disposition;
    try {
      ({ disposition } = this.commitCallback(state, `${input.taskId}:${input.payload.messageId}`,
        { kind: 'message', turnId: tx.intent.key, message: { taskId: input.taskId, payload: input.payload } },
        { publish: tx.publish, ...this.deliverPort(state, input.taskId) },
        // A refused message keeps a command record, and retention can move it into K4 rows (#798).
        id => tx.rows.get('commands', id) as CommandRecord | undefined));
    } catch (cause) {
      // Other content for the id of a refused message: the same refusal that K4 gives for an accepted one.
      if (cause instanceof CommitConflict && cause.code === 'identity_conflict') return { outcome: 'refused', reasonCode: 'message_conflict' };
      throw cause;
    }
    return disposition.outcome === 'accepted' ? { outcome: 'accepted' } : { outcome: 'refused', reasonCode: disposition.reasonCode };
  }
  /**
   * Owner API ("Cancel", §8.8), from A's delegation chip or from B's `bot_request` Turn.
   * It rejects when `core.cancel` fails. The cancel fact is already committed, and the timer delivers it later.
   */
  cancelDelegation(id: string, ...by: PrincipalArg): Promise<void> {
    return this.exclusive(() => {
      this.ownerOnly(by, 'cancelDelegation', id);
      return this.settleChain(this.commitKeyless({ kind: 'cancel_delegation', delegationId: id }));
    });
  }
  /** Owner API ("End", §8.3): close a held reply or an uncertain delegation with `abandoned`. */
  abandonDelegation(id: string, ...by: PrincipalArg): Promise<void> {
    return this.exclusive(() => {
      this.ownerOnly(by, 'abandonDelegation', id);
      return this.settleChain(this.commitKeyless({ kind: 'abandon_delegation', delegationId: id }));
    });
  }
  /** A committed cancel fact is delivered after the commit. */
  private async settleChain(result: CommitResult): Promise<void> {
    if (valueOf<{ deliver: boolean }>(result).deliver) await this.deliverCancels();
    await this.process();
  }
  /**
   * Deliver each committed cancel to its frozen target (§8.8). A crash before
   * `delivered` leaves the fact for the next pass. It never picks a new Turn.
   */
  private async deliverCancels(): Promise<void> {
    for (const d of Object.values(this.snapshot().delegations)) {
      if (!d.cancel || d.cancel.delivered) continue;
      await this.core.cancel(d.cancel.targetTurnId);
      this.ledger.transaction(s => { stateOf(s.application).delegations[d.id]!.cancel!.delivered = true; });
    }
  }

  /**
   * Host persona mode (#879): the Host applied `revision` of this Bot's profile to its Agent home. The current revision
   * readies the Bot. An older revision changes nothing, and a newer one refuses.
   */
  async personaReady(botId: string, revision: string): Promise<void> {
    await this.exclusive(async () => {
      this.commitKeyless({ kind: 'persona_ready', botId, revision });
      await this.process();
    });
  }
  /** Owner API. Advance the desired revision after a rejected persona delivery. */
  async retryPersona(botId: string): Promise<void> {
    await this.exclusive(async () => {
      this.commitKeyless({ kind: 'retry_persona', botId });
      await this.process();
    });
  }
  /**
   * External team mode (#739 Q4c): apply the authority's team snapshot. The command id is its team revision,
   * so the same revision with the same Bots replays, and other Bots are an identity conflict. A revision that
   * is not newer, and not applied before, refuses with `stale_team` after the process pass.
   */
  async applyTeam(snapshot: TeamSnapshot): Promise<void> {
    await this.exclusive(async () => {
      const valid = teamSnapshot(snapshot);
      const { disposition } = this.commitOwner(hash(['team', valid.revision]), { kind: 'team_snapshot', snapshot: valid },
        (_s, state) => ({ teamBot: row => writeSnapshotBot(state, row, this.models(), this.options.readOnlyToolsets) }));
      await this.process();
      if (disposition.outcome === 'refused') throw new TeamModeError('stale_team', disposition.reason ?? 'stale_team');
    });
  }
  async setMainBot(botId: string, mainBot: boolean): Promise<void> {
    await this.exclusive(async () => {
      this.commitKeyless({ kind: 'set_main_bot', botId, mainBot });
      await this.process();
    });
  }
  /** Any verified human can post in a room. The room message records the principal id; without one it is from `user`. */
  async roomInput(key: string, roomId: string, text: string, mentions: Mentions = [], ...by: PrincipalArg): Promise<string> {
    let id!: string;
    await this.exclusive(async () => {
      const principal = by.length ? this.verifiedOnly(by[0], 'roomInput', roomId) : undefined;
      // R5: a bot message is room background. Its mention entities select no seat.
      const called = principal?.kind === 'bot' ? [] : mentions;
      const result = this.commitOwner(hash(['room_input', roomId, key]),
        { kind: 'room_input', key, roomId, text, mentions: called, ...(principal ? { from: principal.id } : {}) });
      id = turnOf(result);
      await this.process();
    });
    return id;
  }
  async updateRoom(roomId: string, update: Partial<RoomFields>): Promise<void> {
    await this.exclusive(async () => {
      this.commitKeyless({ kind: 'update_room', roomId, update });
      await this.process();
    });
  }
  async answer(id: string, answer: string, ...by: PrincipalArg): Promise<void> {
    await this.exclusive(async () => {
      this.ownerOnly(by, 'answer', id);
      this.commitOwner(hash(['answer', id]), { kind: 'answer', questionId: id, answer });
      await this.process();
    });
  }
  /** For IM, call it only from a verified button callback, never for a text command (R2). */
  async decide(id: string, decision: 'confirmed' | 'rejected', ...by: PrincipalArg): Promise<void> {
    await this.exclusive(async () => {
      this.ownerOnly(by, 'decide', id);
      let error: string | undefined;
      try {
        const { disposition } = this.commitOwner(hash(['decide', id]), { kind: 'decide', cardId: id, decision });
        if (disposition.outcome === 'refused') error = disposition.reason;
      } catch (cause) {
        // A different decision for a decided card throws after the process pass, as a refused decision does.
        if (!(cause instanceof CommitConflict) || cause.code !== 'identity_conflict') throw cause;
        error = cause.message;
      }
      await this.process();
      if (error) throw new Error(error);
    });
  }
  /** Owner API for the Main Bot's own routines. */
  async setRoutineLifecycle(id: string, value: Routine['lifecycle']): Promise<void> {
    await this.exclusive(async () => {
      try { await this.core.lifecycle(owned(this.routineRows(), this.options.botId, id).definition.id, value); }
      finally { await this.process(); }
    });
  }
  /** Owner API (§55c): completes any open Bot routine, an archived owner's too, with this Host's Main Bot authority. */
  async endRoutine(id: string): Promise<void> {
    await this.exclusive(async () => {
      try {
        this.commitOwner(randomUUID(), { kind: 'end_routine', botId: this.options.botId, routineId: id }, s => ({ routines: {
          end: routineId => setLifecycle(s, endable(Object.values(s.routines), routineId).definition.id, 'completed', this.now(), routineCalendar) } }));
      } finally { await this.process(); }
    });
  }
  async updateRoutine(action: UpdateRoutineAction): Promise<void> {
    await this.exclusive(async () => {
      try { await this.core.updateRoutine(updateDefinition(this.routineRows(), this.options.botId, action)); }
      finally { await this.process(); }
    });
  }
  private routineRows(): Routine[] { return Object.values(this.ledger.snapshot().routines); }
  /** K4 records routine wakes. The `bot-routine` hook writes the routine Turn in the same commit. */
  readonly consume = (wake: DueWake, signal: AbortSignal): Promise<void> => this.exclusive(async () => {
    signal.throwIfAborted();
    this.ledger.transaction((s, rows) => { this.sync(s, rows); });
    try { await this.core.consume(wake, signal); } finally { await this.process(); }
  });
  drain(): Promise<void> { return this.exclusive(() => this.process()); }
  cancelTurn(id: string, ...by: PrincipalArg): Promise<void> {
    return this.exclusive(async () => {
      this.ownerOnly(by, 'cancelTurn', id);
      const result = this.commitKeyless({ kind: 'cancel_turn', turnId: id });
      const value = valueOf<{ deliver: boolean } | { target: string; admitted: boolean }>(result);
      if ('deliver' in value) return this.settleChain(result);
      if (value.admitted) await this.core.cancel(value.target);
      await this.process();
    });
  }
  /**
   * Explicit retention (#798). Moves every row of each acknowledged settled root out of the state, and retires its ids.
   * A root that is still in use throws `RetentionRefused`, and nothing changes. Never runs on its own.
   */
  retain(input: RetentionInput): Promise<RetentionResult> {
    return this.exclusive(async () => retainInLedger(this.ledger, input, { contextTurnLimit: this.contextTurnLimit }));
  }
  recover(): Promise<void> {
    return this.exclusive(async () => {
      this.ledger.transaction((s, rows) => {
        for (const row of Object.values(stateOf(s.application).channel?.deliveries ?? {})) recoverDelivery(row);
        this.sync(s, rows);
      });
      try { await this.core.recover(); } finally { await this.process(); }
    });
  }
  private sync(s: LedgerState, rows: ApplicationRows, injected?: InjectedHistory): boolean {
    const state = stateOf(s.application);
    // A Host intent record lives as long as K4 keeps the intent, so a replay stays exact until K4 compacts it.
    for (const key of Object.keys(state.hostIntents ?? {})) if (!s.intents[hash(key)]) delete state.hostIntents![key];
    // A batch sealed here is enqueued in this pass, before later Turns of its Bot.
    sealDueBatches(state, this.coalesce, this.now());
    // Refresh passive state before any new offer freezes its ContextPack.
    expireCards(state, this.now());
    let materialized = false;
    const routines = botRoutines(Object.values(s.routines));
    advanceRooms(s, state, this.now(), (id, botId, request) => addTurn(state, seatTurn(id, botId, request)));
    const limits = { turnLimit: this.contextTurnLimit, contextMaxBytes: this.contextMaxBytes, instructionMaxBytes: this.instructionMaxBytes };
    for (const turn of Object.values(state.turns)) {
      materialized = syncTurnInLedger(this.ledger, s, rows, turn, { now: this.now(), models: Object.keys(this.models()),
        readOnlyToolsets: this.options.readOnlyToolsets ?? [], limits, historyMode: !!this.options.history, history: injected?.turns.get(turn.id),
        roomHistoryMode: !!this.options.roomHistory, roomHistory: injected?.rooms.get(turn.id), routines, offer: this.offer }) || materialized;
    }
    settleDelegations(s, state, this.now(), (key, value) => project(s, key, value), this.timers);
    reportCardDecisions(state, (key, value) => project(s, key, value));
    cleanReplyTokens(s, state, this.now());
    projectInputBatches(state, (key, value) => project(s, key, value));
    return materialized;
  }
  /** Example reconcile loop (§3.10). K4 arms no scan after a settled intent, so the Host checks replies itself. */
  private async flushReplies(): Promise<void> {
    for (const d of Object.values(this.snapshot().delegations)) {
      if (!replyCheckDue(d, this.now())) continue;
      // A compacted chain intent has no readback evidence. It takes the failed readback path and cannot stop the pass.
      const intent = this.core.intent(d.chainTurnIds.at(-1)!);
      let check: ReplyCheck = { failed: true };
      if (intent) try {
        if (!this.server.tasks.agentMessage) throw new Error('Agent message readback API required');
        check = { taskId: intent.taskId, failed: false,
          readback: await this.server.tasks.agentMessage(intent.taskId, intent.execution.deviceId, intent.execution.payload.agentRef) };
      } catch { check = { taskId: intent.taskId, failed: true }; }
      this.ledger.transaction(s => {
        const state = stateOf(s.application);
        checkReply(state, state.delegations[d.id]!, check, this.now(), (key: string, value: Json) => project(s, key, value), this.timers.uncertainAfterMs);
      });
    }
  }
  private async callConnector(card: CollaborationState['cards'][string]): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Connector timed out; external outcome is unknown');
        controller.abort(error);
        reject(error);
      }, this.connectorTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.options.connector(card.id, card.action.action, card.action.draft, controller.signal)),
        deadline,
      ]);
    } finally { clearTimeout(timer); }
  }
  private async flushCards(): Promise<void> {
    for (const card of Object.values(this.snapshot().cards)) {
      if (!cardCallDue(card)) continue;
      let outcome: Parameters<typeof settleCardCall>[1];
      try { outcome = { result: await this.callConnector(card) }; } catch (error) { outcome = { error }; }
      this.ledger.transaction(s => settleCardCall(stateOf(s.application).cards[card.id]!, outcome));
    }
  }
  private async flushDeliveries(): Promise<void> {
    const port = this.options.channel?.port;
    if (!port) return;
    if (port.readback) for (const old of Object.values(this.snapshot().channel?.deliveries ?? {}).filter(row => row.state === 'unknown')) {
      try {
        const result = await port.readback(old.id);
        this.ledger.transaction(s => {
          const row = stateOf(s.application).channel?.deliveries[old.id];
          if (row) readbackDelivery(row, old.attempts, result, this.now());
        });
      } catch { continue; } // Missing readback evidence leaves this row unknown.
    }
    for (const old of Object.values(this.snapshot().channel?.deliveries ?? {})) {
      const claim = this.ledger.transaction(s => {
        const state = stateOf(s.application), row = state.channel!.deliveries[old.id]!;
        if (row.state !== 'pending' || (row.nextAttemptAt ?? 0) > this.now()) return;
        const route = deliveryRoute(state, row, this.now());
        if (!route) { refuseRoute(state, row); return; }
        if (startDelivery(row, this.now())) return { row, route };
      });
      if (!claim) continue;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('delivery_timeout')); }, this.deliveryTimeoutMs);
      });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => port.send({ deliveryId: claim.row.id, route: claim.route, body: claim.row.body }, controller.signal)), deadline,
        ]);
        this.ledger.transaction(s => settleDelivery(stateOf(s.application).channel!.deliveries[claim.row.id]!, claim.row.attempts, result, this.now()));
      } catch {
        // send has started: neither an exception nor a deadline proves absence.
        this.ledger.transaction(s => unknownDelivery(stateOf(s.application).channel!.deliveries[claim.row.id]!, claim.row.attempts,
          controller.signal.aborted ? 'send_timeout' : 'send_failed'));
      } finally { clearTimeout(timer); }
    }
    this.ledger.transaction(s => cleanReplyTokens(s, stateOf(s.application), this.now()));
  }
  /** One sync transaction. In history mode, phase 1 reads the history first, outside the transaction. */
  private async syncWithHistory(): Promise<boolean> {
    const injected = await this.readHistory();
    return this.ledger.transaction((s, rows) => this.sync(s, rows, injected));
  }
  private async readHistory(): Promise<InjectedHistory | undefined> {
    const read = this.options.history, readRoom = this.options.roomHistory;
    if (!read && !readRoom) return undefined;
    const ledger = this.ledger.snapshot(), state = stateOf(ledger.application);
    const injected = { turns: new Map<string, { rows: ContextTurn[]; digest: string }>(), rooms: new Map<string, { rows: RoomMessage[]; digest: string }>() };
    for (const turn of Object.values(state.turns)) {
      if (!awaitsOffer(ledger, state, turn) || this.unread.has(turn.id)) continue;
      const seat = turn.source === 'room_slot' ? state.team.seats[turn.id] : undefined;
      try {
        if (seat && readRoom && !seat.released) {
          const pending = readRoom({ roomId: state.team.rounds[seat.roundId]!.roomId, botId: turn.botId, turnId: turn.id });
          const rows = roomMessages(await (seat.deadline === undefined ? pending : byDeadline(pending, seat.deadline - this.now())));
          injected.rooms.set(turn.id, { rows, digest: hash(canonical(rows)) });
        } else if (turn.source !== 'room_slot' && read) {
          const rows = contextTurns(await read({ botId: turn.botId, turnId: turn.id }));
          injected.turns.set(turn.id, { rows, digest: hash(canonical(rows)) });
        }
      } catch { this.unread.add(turn.id); }
    }
    return injected;
  }
  /** A failed pass still re-arms the timer, so other timer work keeps its times. K4 retries a failed wake call itself. */
  private async process(): Promise<void> {
    try { await this.pass(); } finally { this.armTimer(); }
  }
  /**
   * A failed K4 drain does not stop the rest of the pass, so deliveries and reply checks still move their due times.
   * The pass does not repeat after it, and it rethrows the first drain error for the caller and the SDK hook.
   */
  private async pass(): Promise<void> {
    this.unread.clear();
    let failure: { error: unknown } | undefined;
    let more: boolean;
    do {
      // A failed delivery keeps `delivered = false`. The timer retries it.
      await this.deliverCancels().catch(() => {});
      const admitted = await this.syncWithHistory();
      await flushHomes(this.server, this.ledger, this.now);
      this.intentFailures.clear();
      try { await this.core.drain(); } catch (error) { failure ??= { error }; }
      const refused = this.reportIntentFailures();
      if (refused) failure ??= { error: refused };
      // A Main Bot cancel applied in this drain commits with delivered = false.
      await this.deliverCancels().catch(() => {});
      let materialized = await this.syncWithHistory();
      await this.refreshDevices();
      await this.flushCards();
      materialized = await this.syncWithHistory() || materialized;
      await this.flushReplies();
      materialized = await this.syncWithHistory() || materialized;
      await this.flushDeliveries();
      const ledger = this.ledger.snapshot();
      // An immediate runtime terminal can create another turn on any pass.
      // Drain to a fixed point, so no application-only turn can lose its wake.
      const state = stateOf(ledger.application);
      more = admitted || materialized || Object.values(ledger.intents).some(intent => intent.phase === 'queued' && intent.cancelReason && !intent.conclusion)
        || Object.values(state.turns).some(turn => turn.status !== 'blocked' && awaitsOffer(ledger, state, turn) && !this.unread.has(turn.id));
    } while (more && !failure);
    if (failure) throw failure.error;
  }
  private armTimer(): void {
    clearTimeout(this.timer);
    if (!this.closed) {
      // Durable state is authority. The timer only retries outbox work, expires cards and seals input batches at their window end.
      const ledger = this.ledger.snapshot(), state = stateOf(ledger.application);
      // K4 retries a failed wake call from its own timer.
      const due = [...(this.options.channel ? Object.values(state.channel?.deliveries ?? {}).filter(row => row.state === 'pending').map(row => row.nextAttemptAt ?? this.now()) : []),
        ...Object.values(state.channel?.inbounds ?? {}).filter(row => row.reply?.token).map(row => row.reply!.expiresAt),
        ...collaborationDue(state, this.timers),
        ...state.team.homeOperations.filter(op => op.status === 'pending').map(op => Math.max(this.now() + 1000, op.retryAt ?? 0)),
        ...Object.values(state.delegations).filter(d => d.cancel && !d.cancel.delivered).map(() => this.now() + 1000),
        ...this.unread.size ? [this.now() + 1000] : []];
      if (due.length) {
        this.timer = setTimeout(() => { void this.drain().catch(() => {}); }, Math.max(1, Math.min(60_000, Math.min(...due) - this.now())));
        this.timer.unref?.();
      }
    }
  }
  private async refreshDevices(): Promise<void> {
    if (!this.server.machines) return;
    if (!Object.values(this.snapshot().delegations).some(d => !d.verdict && !d.cancel && (d.status === 'queued' || d.status === 'waiting_device'))) return;
    // A discovery failure must not block execution or invent an offline fact.
    let devices: Awaited<ReturnType<ByokServer['machines']['list']>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      devices = await Promise.race([
        this.server.machines.list(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Device discovery timed out')), 1000); }),
      ]);
    } catch { return; } finally { clearTimeout(timer); }
    this.ledger.transaction(s => observeDevices(s, stateOf(s.application), new Map(devices.map(d => [d.deviceId, d.connected])),
      (key, value) => project(s, key, value)));
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); await this.chain; clearTimeout(this.timer); await this.core.close();
  }
}
