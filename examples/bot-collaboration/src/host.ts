import type { BotTurnOutcome, ResultSchema, UpdateRoutineAction } from '@byok-sdk/protocol';
import { BOT_TURN_OUTCOME_CONTRACT, BotTurnOutcomeSchemaError, validateResultOutcome } from '@byok-sdk/protocol';
import type { ByokServer, CreateByokServerOptions, DueWake } from '@byok-sdk/server';
import { HostExecutionCore, type ExecutionServer, type OutcomeTransaction } from '@byok-sdk/example-host-execution-core';
import { HostLedger } from '@byok-sdk/example-host-execution-core';
import { hash, project, time, type ExecutionTemplate, type Json, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { enqueue } from '@byok-sdk/example-host-execution-core';
import { WAKE_HORIZON_MS } from '@byok-sdk/example-host-execution-core';
import { addTurn, json, stateOf, type CollaborationState, type Delegation, type Routine, type Turn } from './model';
import { turnInstruction, outcomeSchema, SYSTEM_PROMPT } from './schema';
import { abandonDelegation, applyDelegate, arbitrateCancel, BOT_REPLY_MAX_BYTES, DEFAULT_CANCEL_GRACE_MS, DEFAULT_INSTRUCTION_MAX_BYTES,
  delegationDue, endChain, minimumInstructionBytes, observeStart, reconcileReply, REPLY_UNCERTAIN_AFTER_MS, resolveDelegation, retryReply,
  settleDelegations, type DelegationTimers } from './delegation';
import { arm, consumeRoutine, createRoutine, lifecycle, operation, owned, switchVersion, updateRoutine } from './routines';

import { activeBot, applyManagement, requireMain, roomFields, same, updateBot, roomVisibility } from './team';
import { advanceRooms, applySpeech, memberPresent, roomInput, type Mentions } from './rooms';
import type { RoomFields } from '@byok-sdk/protocol';

import { CurrentRequestTooLargeError, HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS } from './history';
import { flushHomes, type HomeServer } from './home-projections';
import { admitUserInput, coalescePolicy, projectInputBatches, sealBatchForCancel, sealDueBatches, type CoalescePolicy } from './coalesce';
export interface BotOptions {
  botId: string; execution: ExecutionTemplate; now?: () => number;
  /** Host-owned model templates. New Bots stay on the selected template's device. */
  models?: Record<string, ExecutionTemplate>;
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
}
/** Reply readback port (§3.3). The Host acceptance record stays the body authority. */
export type MessageServer = { tasks: Partial<Pick<ByokServer['tasks'], 'agentMessage'>> };
export type AgentMessageInput = Parameters<NonNullable<CreateByokServerOptions['agentMessage']>['consume']>[0];

/** Copy-and-own Host example. Use one instance per ledger tenant. */
export class BotCollaboration {
  readonly core: HostExecutionCore;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly now: () => number;
  private readonly connectorTimeoutMs: number;
  private readonly contextMaxBytes: number;
  private readonly contextTurnLimit: number;
  private readonly instructionMaxBytes: number;
  private readonly timers: DelegationTimers;
  private readonly coalesce?: CoalescePolicy;
  constructor(readonly server: ExecutionServer & HomeServer & MessageServer, readonly ledger: HostLedger, private readonly options: BotOptions) {
    if (!options.botId || options.execution.payload.agentRef.agentId !== options.botId) throw new Error('Select this Bot Agent');
    if (options.execution.payload.requiredToolsets?.length) throw new Error('Bot executions cannot have connector toolsets');
    this.now = () => time((options.now ?? Date.now)());
    this.connectorTimeoutMs = time(options.connectorTimeoutMs ?? 30_000);
    if (this.connectorTimeoutMs < 1 || this.connectorTimeoutMs > 2_147_483_647) throw new Error('Invalid connector timeout');
    this.contextMaxBytes = time(options.contextMaxBytes ?? HISTORY_MAX_BYTES);
    this.contextTurnLimit = time(options.contextTurnLimit ?? HISTORY_MAX_ITEMS);
    if (this.contextMaxBytes < 1 || this.contextTurnLimit < 1) throw new Error('Invalid ContextPack limits');
    if (options.coalesce) this.coalesce = coalescePolicy(options.coalesce, this.contextMaxBytes);
    this.instructionMaxBytes = time(options.instructionMaxBytes ?? DEFAULT_INSTRUCTION_MAX_BYTES);
    const minimum = minimumInstructionBytes(SYSTEM_PROMPT);
    if (this.instructionMaxBytes < minimum) throw new Error(`instructionMaxBytes must be at least ${minimum}`);
    this.timers = { cancelGraceMs: time(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS), uncertainAfterMs: time(options.uncertainAfterMs ?? REPLY_UNCERTAIN_AFTER_MS) };
    if (this.timers.cancelGraceMs < 1 || this.timers.uncertainAfterMs < 1) throw new Error('Invalid delegation timers');
    this.core = new HostExecutionCore(server, ledger, { now: this.now, reconcileMs: 100,
      applyOutcome: (document, tx) => this.applyOutcome(document, tx) });
    ledger.transaction(s => {
      const state = stateOf(s.application);
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
   */
  input(key: string, request: string, botId = this.options.botId): Promise<string> {
    const id = hash(['user', botId, key]);
    return this.exclusive(async () => {
      const turnId = this.ledger.transaction(s => {
        const state = stateOf(s.application);
        activeBot(state.team, botId);
        // The sender is the owner until verified IM senders arrive (#552).
        return admitUserInput(state, { id, key, botId, request, sender: 'owner', authority: 'owner' }, this.coalesce, this.now());
      });
      await this.process();
      return turnId;
    });
  }
  private applyOutcome(document: unknown, tx: OutcomeTransaction): void {
    const state = stateOf(tx.application);
    const turn = state.turns[tx.intent.key];
    if (!turn) throw new Error('Missing Bot turn');
    const schema = state.schemas[turn.id];
    if (!schema || !validateResultOutcome(schema, document).ok) throw new Error('Outcome differs from the frozen schema');
    const delegation = turn.delegationId ? state.delegations[turn.delegationId] : undefined;
    // A cancelled or resolved chain never applies B's staged outcome (§8.3, §8.8).
    if (delegation && (delegation.verdict || delegation.cancel)) { state.audit.push(`Outcome audit only: ${tx.intent.taskId}`); return; }
    const outcome = document as BotTurnOutcome;
    turn.outcome = json(document);
    const accept = (action: string, work: () => void) => {
      try { work(); } catch (error) {
        state.rejected.push({ botId: turn.botId, taskId: tx.intent.taskId, action, reason: String(error instanceof Error ? error.message : error) });
      }
    };
    const bot = state.team.bots[turn.botId];
    const seat = state.team.seats[turn.id];
    if (!bot || bot.archived || seat && (!memberPresent(state.team, seat) || ['removed', 'busy', 'blocked'].includes(seat.status))) {
      state.audit.push(`Outcome audit only: ${tx.intent.taskId}`); return;
    }
    if (seat) applySpeech(state, turn, outcome, tx.intent.taskId, this.now(), accept);
    const managed = (kind: string, work: () => void) => accept(kind, () => {
      // Also deny management from room offers frozen before this policy change.
      if (seat) throw new Error('Room seats cannot manage the team');
      // Another Bot's request never drives management, at any depth (§6.1).
      if (turn.authority !== 'owner') throw new Error('Management needs owner authority');
      work();
    });
    applyManagement(state, turn.botId, tx.intent.taskId, outcome, this.models(), managed);
    // Main Bot cancel (§8.8): after management, before the routine actions, in the same arbitration as cancelDelegation.
    // Only this Turn's intent changes in the terminal transaction, so the committed intents are current for the target.
    outcome.cancel_delegation?.forEach(action => managed('cancel_delegation', () => {
      requireMain(state.team, turn.botId);
      const d = state.delegations[action.delegationId];
      if (!d) throw new Error('Delegation not found');
      if (d.verdict) throw new Error('already_resolved');
      arbitrateCancel(this.ledger.snapshot(), state, d, this.now(), tx.publish, 'main_bot_cancelled');
    }));
    outcome.create_routine?.forEach((action, index) => accept('create_routine', () => {
      createRoutine(state, turn.botId, tx.intent.taskId, index, action, this.now(), turn.authority ?? 'bot');
    }));
    outcome.update_routine?.forEach(action => accept('update_routine', () => updateRoutine(state, turn.botId, action, this.now())));
    outcome.cancel_routine?.forEach(action => accept('cancel_routine', () => {
      lifecycle(state, owned(state, turn.botId, action.routineId), 'completed', this.now());
    }));
    outcome.confirmable_action?.forEach((action, index) => {
      const id = hash([tx.intent.taskId, 'confirmable_action', index]);
      state.cards[id] = { id, turnId: turn.id, action: { action: action.action, summary: action.summary, draft: json(action.draft) },
        state: 'pending', expiresAt: this.now() + 86_400_000 };
      tx.publish(`card:${id}`, json(state.cards[id]));
    });
    if (outcome.ask_user) accept('ask_user', () => {
      const question = outcome.ask_user!;
      if (question.answerKind === 'single_choice' && new Set(question.options.map(o => o.id)).size !== question.options.length) throw new Error('Duplicate option id');
      const id = hash([tx.intent.taskId, 'ask_user']);
      state.questions[id] = { id, turnId: turn.id, value: question };
      tx.publish(`question:${id}`, json(state.questions[id]));
    });
    const { successor } = applyDelegate(state, turn, tx.intent.taskId, outcome, !!seat, this.now(), tx.publish, accept);
    if (turn.delegationId) {
      // A device terminal proves that this chain Turn ran.
      observeStart(state, turn, this.now(), tx.publish);
      if (!successor) endChain(state, turn, tx.intent.taskId, !!outcome.delegate?.some(action => action.to === turn.botId), this.now(), tx.publish);
    }
  }

  /**
   * Install as the server's `agentMessage.consume`. One ledger transaction
   * checks the exact binding and records the first acceptance (§3.3).
   */
  async consumeMessage(input: AgentMessageInput): Promise<{ outcome: 'accepted' | 'refused'; reasonCode?: string }> {
    if (this.closed) throw new Error('Bot Host is closed');
    return this.ledger.transaction(s => {
      const state = stateOf(s.application);
      const refuse = (reasonCode: string) => ({ outcome: 'refused' as const, reasonCode });
      const prior = state.replies[input.taskId];
      if (prior) return prior.messageId === input.payload.messageId && prior.contentHash === input.payload.contentHash ? { outcome: 'accepted' as const } : refuse('message_conflict');
      const intent = Object.values(s.intents).find(row => row.taskId === input.taskId);
      if (!intent) return refuse(s.executions[input.taskId] ? 'stale_generation' : 'unknown_task');
      const frozen = s.executions[input.taskId]!.input, turn = state.turns[intent.key];
      if (!turn || input.tenant !== this.ledger.tenant || input.deviceId !== frozen.deviceId
        || !same(input.payload.agentRef, frozen.payload.agentRef) || !same(input.context, frozen.agentMessageContext)) return refuse('binding_mismatch');
      const delegation = turn.delegationId ? state.delegations[turn.delegationId] : undefined;
      if (delegation?.verdict) {
        state.audit.push(`Delegation message after verdict: ${delegation.id} ${input.taskId}`);
        return refuse('delegation_resolved');
      }
      // Cancel and first acceptance meet in this transaction boundary (§8.8).
      if (delegation?.cancel?.targetTurnId === turn.id) {
        state.audit.push(`Delegation message after cancel: ${delegation.id} ${input.taskId}`);
        return refuse('delegation_cancelled');
      }
      if (delegation && Buffer.byteLength(input.payload.body, 'utf8') > BOT_REPLY_MAX_BYTES) return refuse('reply_too_large');
      state.replies[input.taskId] = { turnId: turn.id, messageId: input.payload.messageId, contentHash: input.payload.contentHash,
        contentType: input.payload.contentType, acceptedAt: this.now(), ...(delegation ? { body: input.payload.body } : {}) };
      return { outcome: 'accepted' as const };
    });
  }
  /**
   * Owner API ("Cancel", §8.8), from A's delegation chip or from B's `bot_request` Turn.
   * It rejects when `core.cancel` fails. The cancel fact is already committed, and the timer delivers it later.
   */
  cancelDelegation(id: string): Promise<void> {
    return this.exclusive(() => this.settleChain(id, (s, state, d) => arbitrateCancel(s, state, d, this.now(), (key, value) => project(s, key, value))));
  }
  /** Owner API ("End", §8.3): close a held reply or an uncertain delegation with `abandoned`. */
  abandonDelegation(id: string): Promise<void> {
    return this.exclusive(() => this.settleChain(id, (s, state, d) => abandonDelegation(s, state, d, this.now(), (key, value) => project(s, key, value))));
  }
  private async settleChain(id: string, decide: (s: LedgerState, state: CollaborationState, d: Delegation) => boolean): Promise<void> {
    const deliver = this.ledger.transaction(s => {
      const state = stateOf(s.application), d = state.delegations[id];
      if (!d) throw new Error('Delegation not found');
      return decide(s, state, d);
    });
    if (deliver) await this.deliverCancels();
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

  /** Owner API. Advance the desired revision after a rejected persona delivery. */
  async retryPersona(botId: string): Promise<void> {
    await this.exclusive(async () => {
      this.ledger.transaction(s => {
        const state = stateOf(s.application), bot = activeBot(state.team, botId);
        const failed = state.team.homeOperations.find(op => op.botId === botId
          && op.request.payload.agentRef.profileRevision === bot.revision && op.status === 'failed');
        if (!failed) throw new Error('No failed persona delivery for the current revision');
        updateBot(state, { botId, persona: bot.persona }, this.models());
        for (const turn of Object.values(state.turns)) {
          if (turn.botId === botId && !s.intents[hash(turn.id)]) delete turn.profileFailure;
        }
        project(s, `persona-retry:${bot.id}:${bot.revision}`, json({ owner: bot.id, revision: bot.revision, status: 'pending' }));
      });
      await this.process();
    });
  }
  async setMainBot(botId: string, mainBot: boolean): Promise<void> {
    await this.exclusive(async () => {
      this.ledger.transaction(s => { activeBot(stateOf(s.application).team, botId).mainBot = mainBot; });
      await this.process();
    });
  }
  async roomInput(key: string, roomId: string, text: string, mentions: Mentions = []): Promise<string> {
    let id!: string;
    await this.exclusive(async () => {
      this.ledger.transaction(s => { id = roomInput(stateOf(s.application), key, roomId, text, mentions); });
      await this.process();
    });
    return id;
  }
  async updateRoom(roomId: string, update: Partial<RoomFields>): Promise<void> {
    await this.exclusive(async () => {
      this.ledger.transaction(s => {
        const team = stateOf(s.application).team, room = team.rooms[roomId];
        if (!room) throw new Error('Room not found');
        const fields = { ...room, ...update };
        if (!update.admin && !fields.members.includes(fields.admin ?? '')) delete fields.admin;
        const next = roomFields(team, fields);
        next.visibleFrom = roomVisibility(room, next.members);
        Object.assign(room, next); if (!next.admin) delete room.admin;
      });
      await this.process();
    });
  }
  async answer(id: string, answer: string): Promise<void> {
    await this.exclusive(async () => {
      this.ledger.transaction(s => {
        const state = stateOf(s.application), question = state.questions[id];
        if (!question) throw new Error('Question not found');
        if (question.answer !== undefined) {
          if (question.answer !== answer) throw new Error('Answer identity conflict');
          return;
        }
        if (!answer.trim() || question.value.answerKind === 'single_choice' && !question.value.options.some(o => o.id === answer)) throw new Error('Invalid answer');
        question.answer = answer;
        const turnId = hash(['answer', id]);
        addTurn(state, { id: turnId, root: turnId, source: 'answer', request: JSON.stringify({ question: question.value, answer }),
          botId: state.turns[question.turnId]!.botId, hop: 0, authority: 'owner' });
      });
      await this.process();
    });
  }
  async decide(id: string, decision: 'confirmed' | 'rejected'): Promise<void> {
    await this.exclusive(async () => {
      const error = this.ledger.transaction(s => {
        const state = stateOf(s.application), card = state.cards[id];
        if (!card) throw new Error('Card not found');
        if (card.state === 'pending' && this.now() >= card.expiresAt) card.state = 'expired';
        if (card.state === 'expired') return 'Card expired';
        if (card.state !== 'pending') return card.state === decision ? undefined : `Card already ${card.state}`;
        card.state = decision;
      });
      await this.process();
      if (error) throw new Error(error);
    });
  }
  async setRoutineLifecycle(id: string, value: Routine['lifecycle']): Promise<void> {
    await this.exclusive(async () => {
      this.ledger.transaction(s => lifecycle(stateOf(s.application), owned(stateOf(s.application), this.options.botId, id), value, this.now()));
      await this.process();
    });
  }
  async updateRoutine(action: UpdateRoutineAction): Promise<void> {
    await this.exclusive(async () => {
      this.ledger.transaction(s => updateRoutine(stateOf(s.application), this.options.botId, action, this.now()));
      await this.process();
    });
  }
  readonly consume = (wake: DueWake, signal: AbortSignal): Promise<void> => this.exclusive(async () => {
    signal.throwIfAborted();
    if (wake.dedupKey.startsWith('host-scan:')) {
      this.ledger.transaction(s => { this.sync(s); });
      await this.core.consume(wake, signal);
    }
    else this.ledger.transaction(s => {
      const state = stateOf(s.application);
      consumeRoutine(state, wake, this.now(), (id, request, routine) => {
        const occurrence = state.occurrences[wake.dedupKey]!;
        addTurn(state, { id, root: id, source: 'routine', request, botId: occurrence.definition!.target, hop: 0, authority: routine.authority ?? 'bot' });
      });
    });
    await this.process();
  });
  drain(): Promise<void> { return this.exclusive(() => this.process()); }
  cancelTurn(id: string): Promise<void> {
    return this.exclusive(async () => {
      const turn = this.snapshot().turns[id];
      // A chain Turn cancels its whole delegation, so one verdict covers it (§8.8).
      if (turn?.delegationId && !this.snapshot().delegations[turn.delegationId]!.verdict) {
        return this.settleChain(turn.delegationId, (s, state, d) => arbitrateCancel(s, state, d, this.now(), (key, value) => project(s, key, value)));
      }
      let target = id;
      const admitted = this.ledger.transaction(s => {
        const state = stateOf(s.application);
        target = sealBatchForCancel(state, id);
        const turn = state.turns[target];
        if (!turn) throw new Error('Turn not found');
        if (s.intents[hash(target)]) return true;
        if (!turn.conclusion) {
          turn.status = 'failed'; turn.conclusion = 'cancelled';
          delete turn.blockedReason;
          project(s, `bot-turn:${target}`, json({ owner: turn.botId, ...turn }));
          turn.reported = true;
        }
        return false;
      });
      if (admitted) await this.core.cancel(target);
      await this.process();
    });
  }
  recover(): Promise<void> {
    return this.exclusive(async () => {
      this.ledger.transaction(s => { this.sync(s); });
      await this.core.recover();
      const pending = new Set((await this.server.wakes.pending()).map(w => w.dedupKey));
      this.ledger.transaction(s => {
        const state = stateOf(s.application);
        for (const routine of Object.values(state.routines)) {
          if (routine.lifecycle !== 'active') continue;
          if (routine.armed && !pending.has(routine.armed.key)) operation(state, routine, 'schedule', routine.armed);
          else if (!routine.armed && routine.pending === null) arm(state, routine, this.now(), this.now());
        }
      });
      await this.process();
    });
  }
  private blockTurn(state: LedgerState, turn: Turn, reason: string): void {
    if (turn.blockedReason !== reason) project(state, `blocked:${turn.id}`, {
      owner: turn.botId, turnId: turn.id, reason,
    });
    const seat = stateOf(state.application).team.seats[turn.id];
    if (seat) { seat.status = 'blocked'; seat.released = true; seat.reason = reason; }
    turn.status = 'blocked'; turn.blockedReason = reason;
  }
  private sync(s: LedgerState): boolean {
    const state = stateOf(s.application);
    // A batch sealed here is enqueued in this pass, before later Turns of its Bot.
    sealDueBatches(state, this.coalesce, this.now());
    // Refresh passive state before any new offer freezes its ContextPack.
    for (const card of Object.values(state.cards)) {
      if (card.state === 'pending' && this.now() >= card.expiresAt) card.state = 'expired';
    }
    let materialized = false;
    // Seats never manage or delegate (§5), so no seat Turn carries owner authority.
    advanceRooms(s, state, this.now(), (id, botId, request) => addTurn(state, { id, root: id, source: 'room_slot', request, botId, hop: 0, authority: 'bot' }));
    for (const turn of Object.values(state.turns)) {
      const intent = s.intents[hash(turn.id)];
      const bot = state.team.bots[turn.botId];
      if (!intent && bot?.archived) { turn.status = 'failed'; turn.conclusion = 'cancelled'; }
      if (!intent && (turn.conclusion || turn.source === 'room_slot' && state.team.seats[turn.id]?.status === 'blocked')) continue;
      if (intent && bot?.archived && !s.executions[intent.taskId]?.started && !intent.conclusion) intent.cancelReason = 'cancelled';
      if (!intent) {
        if (!bot || bot.readyRevision !== bot.revision) {
          const failed = state.team.homeOperations.find(op => op.botId === turn.botId
            && op.request.payload.agentRef.profileRevision === bot?.revision && op.status === 'failed');
          if (failed) {
            turn.profileFailure = { sequence: failed.sequence, revision: failed.request.payload.agentRef.profileRevision,
              reason: failed.error ?? 'Persona delivery failed' };
            project(s, `persona-turn-failed:${turn.id}:${failed.sequence}`, json({ owner: turn.botId, turnId: turn.id,
              status: 'blocked', recoverable: true, ...turn.profileFailure }));
          }
          continue;
        }
        delete turn.profileFailure;
        let schema: ResultSchema, frozen: ReturnType<typeof turnInstruction>;
        try {
          schema = outcomeSchema(turn.botId, state, turn, Object.keys(this.models()));
          frozen = turnInstruction(state, turn, { turnLimit: this.contextTurnLimit, contextMaxBytes: this.contextMaxBytes, instructionMaxBytes: this.instructionMaxBytes });
        } catch (error) {
          if (error instanceof BotTurnOutcomeSchemaError && error.code === 'schema-over-budget') {
            this.blockTurn(s, turn, `Outcome schema over budget after flat fallback: ${error.message}`);
          } else if (error instanceof CurrentRequestTooLargeError) this.blockTurn(s, turn, error.message);
          else throw error;
          continue;
        }
        state.schemas[turn.id] = schema;
        const base = bot.execution;
        const { messageEgress: egress, ...roomPayload } = base.payload;
        // A delegated reply is capped at BOT_REPLY_MAX_BYTES, and its cursor is B's Turn.
        const chain = turn.delegationId && egress ? {
          agentMessageContext: { ...base.agentMessageContext!, freshnessCursor: turn.id },
          payload: { ...base.payload, messageEgress: { ...egress, maxBytes: Math.min(egress.maxBytes, BOT_REPLY_MAX_BYTES) } },
        } : undefined;
        const execution = turn.source === 'room_slot' ? { ...base, agentMessageContext: undefined, payload: roomPayload } : { ...base, ...chain };
        enqueue(s, this.ledger.tenant, { key: turn.id, source: turn.source === 'routine' ? 'routine' : turn.source === 'user' || turn.source === 'answer' ? 'user' : 'bot',
          waitUntil: this.now() + 300_000, execution: { ...execution, payload: { ...execution.payload, instruction: frozen.instruction,
            terminalProjection: { mode: 'result-document', contract: BOT_TURN_OUTCOME_CONTRACT, schema },
          } } });
        for (const rejection of frozen.context.rejectedActions) rejection.consumedBy = turn.id;
        delete turn.blockedReason;
        turn.status = 'processing';
        materialized = true;
      } else if (intent.conclusion) {
        if (intent.conclusion !== 'succeeded' && !s.executions[intent.taskId]!.started) {
          for (const rejection of state.rejected) if (rejection.consumedBy === turn.id) delete rejection.consumedBy;
        }
        turn.status = intent.conclusion === 'succeeded' ? 'succeeded' : 'failed';
        turn.conclusion = intent.conclusion;
        if (!turn.reported) {
          project(s, `bot-turn:${turn.id}`, json({ owner: turn.botId, ...turn }));
          turn.reported = true;
        }
      }
    }
    settleDelegations(s, state, this.now(), (key, value) => project(s, key, value), this.timers);
    for (const routine of Object.values(state.routines)) {
      routine.inflight = routine.inflight.filter(key => {
        const occurrence = state.occurrences[key]!;
        const turn = state.turns[occurrence.turnId!]!;
        if (turn.status !== 'succeeded' && turn.status !== 'failed') return true;
        occurrence.settled = true; return false;
      });
      // A due armed slot also counts as old work.
      if (!routine.inflight.length && routine.pending !== null && routine.lifecycle === 'active'
        && !(routine.armed && routine.armed.at <= this.now())) switchVersion(state, routine, this.now());
    }
    for (const card of Object.values(state.cards)) {
      if (card.state !== 'pending' && (card.state !== 'confirmed' || card.result !== undefined || card.error !== undefined)) {
        if (!card.decisionReported) {
          project(s, `card:${card.id}:${card.state}`, json(card));
          card.decisionReported = true;
        }
        // Passive expiry is visible in ContextPack. It cannot start a paid turn.
        if (card.state === 'expired') continue;
        const origin = state.turns[card.turnId]!;
        addTurn(state, { id: hash(['action_result', card.id]), root: origin.root, source: 'action_result', botId: origin.botId,
          request: JSON.stringify({ cardId: card.id, state: card.state, conclusion: card.conclusion, result: card.result, error: card.error }),
          hop: origin.hop, authority: origin.authority ?? 'bot' });
      }
    }
    projectInputBatches(state, (key, value) => project(s, key, value));
    return materialized;
  }
  private async flushWakes(): Promise<void> {
    // All mutations and store calls run on this instance's single serial chain.
    const blocked = new Set<string>();
    for (const op of this.snapshot().operations.filter(o => o.state === 'pending').sort((a, b) => a.sequence - b.sequence)) {
      if (blocked.has(op.routineId)) continue;
      const routine = this.snapshot().routines[op.routineId]!;
      if (op.kind === 'schedule' && (routine.generation !== op.generation || routine.lifecycle !== 'active' || routine.armed?.key !== op.slot.key)) {
        this.ledger.transaction(s => { stateOf(s.application).operations.find(o => o.sequence === op.sequence)!.state = 'obsolete'; });
        continue;
      }
      if (op.retryAt !== undefined && op.retryAt > this.now()) {
        blocked.add(op.routineId);
        continue;
      }
      try {
        if (op.kind === 'cancel') await this.server.wakes.cancel(op.slot.key);
        else {
          if (op.slot.at - this.now() > WAKE_HORIZON_MS) throw new Error('Wake is beyond the 368 day horizon');
          await this.server.wakes.schedule({ dedupKey: op.slot.key, availableAt: op.slot.at });
        }
        this.ledger.transaction(s => {
          const state = stateOf(s.application), row = state.operations.find(o => o.sequence === op.sequence)!;
          row.state = 'done'; delete row.retryAt;
          const routine = state.routines[op.routineId]!;
          const retrying = state.operations.some(o => o.routineId === op.routineId && o.state === 'pending' && o.retryAt !== undefined);
          if (!retrying && (op.kind === 'schedule' || routine.status === 'schedule_retrying')) routine.status = 'ok';
        });
      } catch (error) {
        this.ledger.transaction(s => {
          const state = stateOf(s.application), row = state.operations.find(o => o.sequence === op.sequence)!;
          row.error = String(error instanceof Error ? error.message : error).slice(0, 1024); row.retryAt = this.now() + 60_000;
          state.routines[op.routineId]!.status = 'schedule_retrying';
        });
        // Only this routine waits. Its later operations cannot overtake the failure.
        blocked.add(op.routineId);
      }
    }
  }
  /** Example reconcile loop (§3.10). K4 arms no scan after a settled intent, so the Host checks replies itself. */
  private async flushReplies(): Promise<void> {
    for (const d of Object.values(this.snapshot().delegations)) {
      if (d.verdict || d.nextCheckAt === undefined || d.nextCheckAt > this.now()) continue;
      const intent = this.core.intent(d.chainTurnIds.at(-1)!)!;
      let readback: Awaited<ReturnType<NonNullable<MessageServer['tasks']['agentMessage']>>> | undefined, failed = false;
      try {
        if (!this.server.tasks.agentMessage) throw new Error('Agent message readback API required');
        readback = await this.server.tasks.agentMessage(intent.taskId, intent.execution.deviceId, intent.execution.payload.agentRef);
      } catch { failed = true; }
      this.ledger.transaction(s => {
        const state = stateOf(s.application), row = state.delegations[d.id]!;
        const emit = (key: string, value: Json) => project(s, key, value);
        if (state.replies[intent.taskId]?.body !== undefined) resolveDelegation(state, row, 'answered', this.now(), emit, undefined, intent.taskId);
        else if (failed) retryReply(row, this.now(), emit, this.timers.uncertainAfterMs);
        else reconcileReply(state, row, readback, this.now(), emit, this.timers.uncertainAfterMs);
      });
    }
  }
  private async callConnector(card: CollaborationState['cards'][string]): Promise<Json> {
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
      return json(await Promise.race([
        Promise.resolve().then(() => this.options.connector(card.id, card.action.action, card.action.draft, controller.signal)),
        deadline,
      ]));
    } finally { clearTimeout(timer); }
  }
  private async flushCards(): Promise<void> {
    for (const card of Object.values(this.snapshot().cards)) {
      if (card.state !== 'confirmed' || card.result !== undefined || card.error !== undefined) continue;
      let result: Json | undefined, error: string | undefined;
      try { result = await this.callConnector(card); }
      catch (cause) { error = String(cause instanceof Error ? cause.message : cause).slice(0, 1024); }
      this.ledger.transaction(s => {
        const row = stateOf(s.application).cards[card.id]!;
        if (error !== undefined) row.error = error; else row.result = result!;
        row.conclusion = error === undefined ? 'succeeded' : 'failed';
      });
    }
  }
  private async process(): Promise<void> {
    let more: boolean;
    do {
      // A failed delivery keeps `delivered = false`. The timer retries it.
      await this.deliverCancels().catch(() => {});
      const admitted = this.ledger.transaction(s => this.sync(s));
      await flushHomes(this.server, this.ledger, this.now);
      await this.core.drain();
      // A Main Bot cancel applied in this drain commits with delivered = false.
      await this.deliverCancels().catch(() => {});
      let materialized = this.ledger.transaction(s => this.sync(s));
      await this.flushCards();
      materialized = this.ledger.transaction(s => this.sync(s)) || materialized;
      await this.flushWakes();
      await this.flushReplies();
      materialized = this.ledger.transaction(s => this.sync(s)) || materialized;
      const ledger = this.ledger.snapshot();
      // An immediate runtime terminal can create another turn on any pass.
      // Drain to a fixed point, so no application-only turn can lose its wake.
      const state = stateOf(ledger.application);
      more = admitted || materialized || Object.values(ledger.intents).some(intent => intent.phase === 'queued' && intent.cancelReason && !intent.conclusion)
        || Object.values(state.turns).some(turn => !turn.conclusion && !ledger.intents[hash(turn.id)] && turn.status !== 'blocked'
        && turn.status !== 'failed' && !!state.team.bots[turn.botId] && !state.team.bots[turn.botId]!.archived
        && state.team.bots[turn.botId]?.readyRevision === state.team.bots[turn.botId]?.revision);
    } while (more);
    clearTimeout(this.timer);
    if (!this.closed) {
      // Durable state is authority. The timer only retries outbox work, expires cards and seals input batches at their window end.
      const state = this.snapshot();
      const heads = new Map<string, number>();
      for (const op of state.operations.filter(o => o.state === 'pending').sort((a, b) => a.sequence - b.sequence)) {
        if (!heads.has(op.routineId)) heads.set(op.routineId, op.retryAt ?? this.now());
      }
      const due = [...heads.values(),
        ...Object.values(state.cards).filter(c => c.state === 'pending').map(c => c.expiresAt),
        ...Object.values(state.team.seats).filter(seat => !seat.released && seat.deadline !== undefined).map(seat => seat.deadline!),
        ...state.team.homeOperations.filter(op => op.status === 'pending').map(op => Math.max(this.now() + 1000, op.retryAt ?? 0)),
        ...delegationDue(state, this.timers),
        ...Object.values(state.inputBatches ?? {}).filter(batch => batch.state === 'open').map(batch => batch.sealAt),
        ...Object.values(state.delegations).filter(d => d.cancel && !d.cancel.delivered).map(() => this.now() + 1000)];
      if (due.length) {
        this.timer = setTimeout(() => { void this.drain().catch(() => {}); }, Math.max(1, Math.min(60_000, Math.min(...due) - this.now())));
        this.timer.unref?.();
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); await this.chain; clearTimeout(this.timer); await this.core.close();
  }
}
