import { validateResultOutcome, type BotTurnOutcome, type ResultSchema } from '@byok-sdk/protocol';
import { hash } from '@byok-sdk/server/execution-core/canonical';
import { json, type Card, type Question, type Turn } from './turn';
import { applyDelegate, arbitrateCancel, endChain, observeStart, type DelegationBot, type DelegationState, type IntentFacts, type Publish } from './delegation';
import { applySpeech, memberPresent, roomMessageProjection, type RoomsState } from './rooms';
import { requireMain } from './team';
import { observes, type AutonomyGate, type AutonomyState } from './autonomy';

/**
 * The outcome of one Bot Turn as pure rules (#739 D1): the frozen-schema check, the audit-only cases,
 * the management gate and the order of the actions. The Host gives the ports for its own stores:
 * team management, K4 routines and the channel outbox. Each port throws to refuse its action.
 */
export type Accept = (action: string, work: () => void) => void;
type Action<K extends 'create_routine' | 'update_routine' | 'cancel_routine'> = NonNullable<BotTurnOutcome[K]>[number];
export interface OutcomeState extends DelegationState, AutonomyState {
  team: { bots: Readonly<Record<string, DelegationBot & { readonly mainBot: boolean }>> } & RoomsState;
  schemas: Record<string, ResultSchema>; cards: Record<string, Card>; questions: Record<string, Question>;
}
export interface OutcomePorts {
  /** The Host clock. Each action reads it when it runs. */
  now(): number;
  publish: Publish;
  /** The committed K4 intents, for a Main Bot cancel. */
  committed: Pick<IntentFacts, 'intent'>;
  /** Team management actions. Run each one through `managed`. */
  manage(turn: Turn, outcome: BotTurnOutcome, managed: Accept): void;
  createRoutine(turn: Turn, action: Action<'create_routine'>, index: number): void;
  updateRoutine(turn: Turn, action: Action<'update_routine'>): void;
  cancelRoutine(turn: Turn, action: Action<'cancel_routine'>): void;
  /** Queue one channel message. Absent: the Host has no channel. */
  deliver?(turn: Turn, key: string, text: string): void;
  /**
   * Bot autonomy (#1229). `observe` records each `create_routine`, cross-Bot `delegate` and `room_call` as a would-do row
   * instead of applying it. Absent: every action applies, as before #1229.
   */
  autonomy?: AutonomyGate;
  /**
   * Room history mode (#883): an accepted seat post also publishes `room-message:<roomId>:<messageId>` with the stored
   * message, so the Host can write it to its room authority. Absent: no such projection.
   */
  roomPosts?: boolean;
}
/** `turnId` is the Turn of the K4 intent key; `taskId` is the task of the terminal. A refused action goes to `rejected`. */
export function applyTurnOutcome(state: OutcomeState, turnId: string, taskId: string, document: unknown, ports: OutcomePorts): void {
  const turn = state.turns[turnId];
  if (!turn) throw new Error('Missing Bot turn');
  const schema = state.schemas[turn.id];
  if (!schema || !validateResultOutcome(schema, document).ok) throw new Error('Outcome differs from the frozen schema');
  const delegation = turn.delegationId ? state.delegations[turn.delegationId] : undefined;
  // A cancelled or resolved chain never applies B's staged outcome (§8.3, §8.8).
  if (delegation && (delegation.verdict || delegation.cancel)) { state.audit.push(`Outcome audit only: ${taskId}`); return; }
  const outcome = document as BotTurnOutcome;
  turn.outcome = json(document);
  const accept: Accept = (action, work) => {
    try { work(); } catch (error) {
      state.rejected.push({ botId: turn.botId, taskId, action, reason: String(error instanceof Error ? error.message : error) });
    }
  };
  const bot = state.team.bots[turn.botId];
  const seat = state.team.seats[turn.id];
  if (!bot || bot.archived || seat && (!memberPresent(state.team, seat) || ['removed', 'busy', 'blocked'].includes(seat.status))) {
    state.audit.push(`Outcome audit only: ${taskId}`); return;
  }
  if (seat) {
    applySpeech(state.team, turn.id, outcome, taskId, ports.now(), accept, ports.autonomy);
    if (state.team.seats[turn.id]?.status === 'post' && outcome.speech?.kind === 'post') {
      ports.deliver?.(turn, `speech:${turn.id}`, outcome.speech.text);
      if (ports.roomPosts) {
        const roomId = state.team.rounds[seat.roundId]!.roomId, message = state.team.rooms[roomId]!.messages.find(row => row.id === turn.id)!;
        ports.publish(roomMessageProjection(roomId, message.id), { roomId, ...message });
      }
    }
  }
  const managed: Accept = (kind, work) => accept(kind, () => {
    // Also deny management from room offers frozen before this policy change.
    if (seat) throw new Error('Room seats cannot manage the team');
    // Another Bot's request never drives management, at any depth (§6.1).
    if (turn.authority !== 'owner') throw new Error('Management needs owner authority');
    work();
  });
  ports.manage(turn, outcome, managed);
  // Main Bot cancel (§8.8): after management, before the routine actions, in the same arbitration as cancelDelegation.
  // Only this Turn's intent changes in the terminal transaction, so the committed intents are current for the target.
  outcome.cancel_delegation?.forEach(action => managed('cancel_delegation', () => {
    requireMain(state.team, turn.botId);
    const d = state.delegations[action.delegationId];
    if (!d) throw new Error('Delegation not found');
    if (d.verdict) throw new Error('already_resolved');
    arbitrateCancel(state, ports.committed, d, ports.now(), ports.publish, 'main_bot_cancelled');
  }));
  // K4 routine commands refuse before any write, so a rejected action changes no routine.
  // #1229: an observing Bot records the routine it would have created. No routine row, wake or occurrence is written.
  outcome.create_routine?.forEach((action, index) => {
    if (observes(ports.autonomy)) { ports.autonomy.record('create_routine', index, json(action)); return; }
    accept('create_routine', () => ports.createRoutine(turn, action, index));
  });
  outcome.update_routine?.forEach(action => accept('update_routine', () => ports.updateRoutine(turn, action)));
  outcome.cancel_routine?.forEach(action => accept('cancel_routine', () => ports.cancelRoutine(turn, action)));
  outcome.confirmable_action?.forEach((action, index) => {
    const id = hash([taskId, 'confirmable_action', index]);
    state.cards[id] = { id, turnId: turn.id, action: { action: action.action, summary: action.summary, draft: json(action.draft) },
      state: 'pending', expiresAt: ports.now() + 86_400_000 };
    ports.publish(`card:${id}`, json(state.cards[id]));
    ports.deliver?.(turn, `card:${id}`, action.summary);
  });
  if (outcome.ask_user) accept('ask_user', () => {
    const question = outcome.ask_user!;
    if (question.answerKind === 'single_choice' && new Set(question.options.map(o => o.id)).size !== question.options.length) throw new Error('Duplicate option id');
    const id = hash([taskId, 'ask_user']);
    state.questions[id] = { id, turnId: turn.id, value: question };
    ports.publish(`question:${id}`, json(state.questions[id]));
    ports.deliver?.(turn, `question:${id}`, question.question);
  });
  const { successor } = applyDelegate(state, turn, taskId, outcome, !!seat, ports.now(), ports.publish, accept, ports.autonomy);
  if (turn.delegationId) {
    // A device terminal proves that this chain Turn ran.
    observeStart(state, turn, ports.now(), ports.publish);
    if (!successor) endChain(state, turn, taskId, !!outcome.delegate?.some(action => action.to === turn.botId), ports.now(), ports.publish);
  }
}
