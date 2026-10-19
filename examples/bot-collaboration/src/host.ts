import type { BotTurnOutcome, ResultSchema, UpdateRoutineAction } from '@byok-sdk/protocol';
import { BOT_TURN_OUTCOME_CONTRACT, validateResultOutcome } from '@byok-sdk/protocol';
import type { DueWake } from '@byok-sdk/server';
import { HostExecutionCore, type ExecutionServer, type OutcomeTransaction } from '../../host-execution-core/src/core';
import { HostLedger } from '../../host-execution-core/src/ledger';
import { hash, project, time, type ExecutionTemplate, type Json, type LedgerState } from '../../host-execution-core/src/model';
import { enqueue } from '../../host-execution-core/src/transitions';
import { WAKE_HORIZON_MS } from '../../host-execution-core/src/routines';
import { json, stateOf, type CollaborationState, type Routine, type Turn } from './model';
import { contextPack, outcomeSchema, SYSTEM_PROMPT } from './schema';
import { arm, consumeRoutine, createRoutine, lifecycle, operation, owned, switchVersion, updateRoutine } from './routines';

export interface BotOptions {
  botId: string; execution: ExecutionTemplate; now?: () => number;
  /** Must deduplicate by id. A committed confirmation can be replayed after a crash. */
  connector: (id: string, action: string, draft: Json, signal: AbortSignal) => Promise<Json>;
  /** The Host also enforces this limit when a connector ignores cancellation. */
  connectorTimeoutMs?: number;
}

/** Copy-and-own Host example. Use one instance per ledger tenant. */
export class BotCollaboration {
  readonly core: HostExecutionCore;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly now: () => number;
  private readonly connectorTimeoutMs: number;
  constructor(readonly server: ExecutionServer, readonly ledger: HostLedger, private readonly options: BotOptions) {
    if (!options.botId || options.execution.payload.agentRef.agentId !== options.botId) throw new Error('Select this Bot Agent');
    if (options.execution.payload.requiredToolsets?.length) throw new Error('Bot executions cannot have connector toolsets');
    this.now = () => time((options.now ?? Date.now)());
    this.connectorTimeoutMs = time(options.connectorTimeoutMs ?? 30_000);
    if (this.connectorTimeoutMs < 1 || this.connectorTimeoutMs > 2_147_483_647) throw new Error('Invalid connector timeout');
    this.core = new HostExecutionCore(server, ledger, { now: this.now, reconcileMs: 100,
      applyOutcome: (document, tx) => this.applyOutcome(document, tx) });
    ledger.transaction(s => { stateOf(s.application); });
  }
  snapshot(): CollaborationState { return stateOf(this.ledger.snapshot().application); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Bot Host is closed'));
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }
  async input(key: string, request: string): Promise<string> {
    const id = hash(['user', key]);
    await this.exclusive(async () => {
      this.ledger.transaction(s => {
        const state = stateOf(s.application);
        const old = state.turns[id];
        if (old && old.request !== request) throw new Error('Input identity conflict');
        state.budgets[id] ??= { continuation: 0, delegation: 0 };
        this.addTurn(state, id, id, 'user', request);
      });
      await this.process();
    });
    return id;
  }
  private addTurn(state: CollaborationState, id: string, root: string, source: Turn['source'], request: string): void {
    state.turns[id] ??= { id, root, source, request, hop: 0, status: 'queued' };
    state.budgets[root] ??= { continuation: 0, delegation: 0 };
  }
  private applyOutcome(document: unknown, tx: OutcomeTransaction): void {
    const state = stateOf(tx.application);
    const turn = state.turns[tx.intent.key];
    if (!turn) throw new Error('Missing Bot turn');
    const schema = state.schemas[turn.id];
    if (!schema || !validateResultOutcome(schema, document).ok) throw new Error('Outcome differs from the frozen schema');
    const outcome = document as BotTurnOutcome;
    turn.outcome = json(document);
    const accept = (action: string, work: () => void) => {
      try { work(); } catch (error) {
        state.rejected.push({ taskId: tx.intent.taskId, action, reason: String(error instanceof Error ? error.message : error) });
      }
    };
    outcome.create_routine?.forEach((action, index) => accept('create_routine', () => {
      createRoutine(state, this.options.botId, tx.intent.taskId, index, action, this.now());
    }));
    outcome.update_routine?.forEach(action => accept('update_routine', () => updateRoutine(state, this.options.botId, action, this.now())));
    outcome.cancel_routine?.forEach(action => accept('cancel_routine', () => {
      lifecycle(state, owned(state, this.options.botId, action.routineId), 'completed', this.now());
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
    const delegated = new Set<string>();
    outcome.delegate?.forEach((action, index) => accept('delegate', () => {
      if (action.to !== this.options.botId) throw new Error('Target is not this Bot');
      if (delegated.has(action.to)) throw new Error('Duplicate delegation target');
      delegated.add(action.to);
      const budget = state.budgets[turn.root]!;
      if (budget.continuation >= 4) throw new Error('Continuation budget is 4');
      budget.continuation++;
      // This single Bot schema only offers self. Hop and delegation stay unchanged.
      this.addTurn(state, hash([tx.intent.taskId, 'delegate', index]), turn.root, 'continuation', action.request);
    }));
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
        this.addTurn(state, turnId, turnId, 'answer', JSON.stringify({ question: question.value, answer }));
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
    if (wake.dedupKey.startsWith('host-scan:')) await this.core.consume(wake, signal);
    else this.ledger.transaction(s => {
      const state = stateOf(s.application);
      consumeRoutine(state, wake, this.now(), (id, request) => this.addTurn(state, id, id, 'routine', request));
    });
    await this.process();
  });
  drain(): Promise<void> { return this.exclusive(() => this.process()); }
  cancelTurn(id: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.snapshot().turns[id]) throw new Error('Turn not found');
      await this.core.cancel(id);
      await this.process();
    });
  }
  recover(): Promise<void> {
    return this.exclusive(async () => {
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
  private sync(s: LedgerState): boolean {
    const state = stateOf(s.application);
    // Refresh passive state before any new offer freezes its ContextPack.
    for (const card of Object.values(state.cards)) {
      if (card.state === 'pending' && this.now() >= card.expiresAt) card.state = 'expired';
    }
    let materialized = false;
    for (const turn of Object.values(state.turns)) {
      const intent = s.intents[hash(turn.id)];
      if (!intent) {
        const schema: ResultSchema = outcomeSchema(this.options.botId, state);
        state.schemas[turn.id] = schema;
        const base = this.options.execution;
        enqueue(s, this.ledger.tenant, { key: turn.id, source: turn.source === 'routine' ? 'routine' : turn.source === 'user' || turn.source === 'answer' ? 'user' : 'bot',
          waitUntil: this.now() + 300_000, execution: { ...base, payload: { ...base.payload,
            instruction: `${SYSTEM_PROMPT}\n\nRequest:\n${turn.request}\n\nContextPack:\n${JSON.stringify(contextPack(state))}`,
            terminalProjection: { mode: 'result-document', contract: BOT_TURN_OUTCOME_CONTRACT, schema },
          } } });
        turn.status = 'processing';
        materialized = true;
      } else if (intent.conclusion) {
        turn.status = intent.conclusion === 'succeeded' ? 'succeeded' : 'failed';
        turn.conclusion = intent.conclusion;
        if (!turn.reported) {
          project(s, `bot-turn:${turn.id}`, json({ owner: this.options.botId, ...turn }));
          turn.reported = true;
        }
      }
    }
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
        const root = state.turns[card.turnId]!.root;
        this.addTurn(state, hash(['action_result', card.id]), root, 'action_result', JSON.stringify({ cardId: card.id, state: card.state, result: card.result, error: card.error }));
      }
    }
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
      });
    }
  }
  private async process(): Promise<void> {
    let more: boolean;
    do {
      await this.core.drain();
      let materialized = this.ledger.transaction(s => this.sync(s));
      await this.flushCards();
      materialized = this.ledger.transaction(s => this.sync(s)) || materialized;
      await this.flushWakes();
      const ledger = this.ledger.snapshot();
      // An immediate runtime terminal can create another turn on any pass.
      // Drain to a fixed point, so no application-only turn can lose its wake.
      more = materialized || Object.values(stateOf(ledger.application).turns).some(turn => !ledger.intents[hash(turn.id)]);
    } while (more);
    clearTimeout(this.timer);
    if (!this.closed) {
      // Durable state is authority. The timer only retries outbox work and expires cards.
      const state = this.snapshot();
      const heads = new Map<string, number>();
      for (const op of state.operations.filter(o => o.state === 'pending').sort((a, b) => a.sequence - b.sequence)) {
        if (!heads.has(op.routineId)) heads.set(op.routineId, op.retryAt ?? this.now());
      }
      const due = [...heads.values(),
        ...Object.values(state.cards).filter(c => c.state === 'pending').map(c => c.expiresAt)];
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
