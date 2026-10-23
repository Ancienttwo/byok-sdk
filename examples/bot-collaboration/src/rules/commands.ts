import { hash } from '@byok-sdk/example-host-execution-core';
import { addTurn, type Json, type Turn } from './turn';
import { activeBot } from './team';
import { roomInput, type Mentions } from './rooms';
import type { InputFields } from './coalesce';
import type { Publish } from './delegation';
import { applyTurnOutcome, type OutcomePorts, type OutcomeState } from './outcome';
import { acceptMessage, type MessageFields } from './message';
import { commit, type CommitRequest, type CommitResult, type CommitState, type Disposition, type OutboxIntent } from './commit';

/**
 * The collaboration commands and their decisions as pure rules (#739 D1). `commitCommand` runs one command
 * through the commit contract. Owner commands and the K4 callbacks use the same function.
 * The Host gives ports for its own helpers. A port that a command needs and that is absent is a Host error.
 */
export type Command =
  /** Owner input to a Bot. The Turn id comes from the Bot and the caller key. */
  | { kind: 'input'; botId: string; key: string; request: string; sender: string }
  /** A received IM message that the Host classified (docs/host-im-adapter.md §3). `key` is its inbound key. */
  | { kind: 'receive'; inbound: 'owner_input'; key: string; botId: string; request: string; sender: string }
  | { kind: 'receive'; inbound: 'room_input'; key: string; roomId: string; text: string; mentions: Mentions; from: string }
  | { kind: 'room_input'; key: string; roomId: string; text: string; mentions: Mentions; from?: string }
  | { kind: 'answer'; questionId: string; answer: string }
  | { kind: 'decide'; cardId: string; decision: 'confirmed' | 'rejected' }
  /** K4 callback: the outcome document of a success terminal. `turnId` is the intent key. */
  | { kind: 'outcome'; turnId: string; taskId: string; document: Json }
  /** K4 callback: the first acceptance of an Agent message. */
  | { kind: 'message'; turnId: string; message: MessageFields }
  /** K4 callback: the Bot routine occurrence hook. */
  | { kind: 'occurrence'; key: string };
export type CommandState = OutcomeState & CommitState;
export interface CommandPorts {
  /** The Host clock. A command reads it when it needs a time. */
  now(): number;
  publish: Publish;
  /** Input admission with the Host coalescing policy. Returns the id of the Turn that answers the input. */
  admitInput?(fields: InputFields): string;
  /** Saves the inbound route of a received message. Absent: the Host has no channel. */
  remember?(root: string): void;
  /** Queues one channel message and returns the delivery id. Absent: the Host has no channel. */
  deliver?(turn: Turn, key: string, text: string): string | undefined;
  outcome?: Omit<OutcomePorts, 'now' | 'publish' | 'deliver'>;
  /** Writes the routine Turn of the occurrence. */
  occurrence?(): void;
}
/** `recordCallbacks` is false when the caller deduplicates the K4 callbacks durably, as K4 does in L. */
export interface CommandStore { scope: string; recordCallbacks: boolean }

const CALLBACKS = new Set<Command['kind']>(['outcome', 'message', 'occurrence']);
/** The fields that decide each command's effect: the fields that the existing identity checks compare. */
export function commandEvidence(command: Command): Json {
  switch (command.kind) {
    case 'input': return { kind: command.kind, botId: command.botId, key: command.key, request: command.request };
    case 'receive': return command.inbound === 'owner_input'
      ? { kind: command.kind, inbound: command.inbound, botId: command.botId, key: command.key, request: command.request }
      : { kind: command.kind, inbound: command.inbound, roomId: command.roomId, key: command.key, text: command.text, mentions: mentionsJson(command.mentions), from: command.from };
    case 'room_input': return { kind: command.kind, roomId: command.roomId, key: command.key, text: command.text,
      mentions: mentionsJson(command.mentions), from: command.from ?? null };
    case 'answer': return { kind: command.kind, questionId: command.questionId, answer: command.answer };
    case 'decide': return { kind: command.kind, cardId: command.cardId, decision: command.decision };
    case 'outcome': return { kind: command.kind, taskId: command.taskId, document: command.document };
    case 'message': return { kind: command.kind, taskId: command.message.taskId, messageId: command.message.payload.messageId,
      contentHash: command.message.payload.contentHash };
    case 'occurrence': return { kind: command.kind, key: command.key };
  }
}
const mentionsJson = (value: Mentions): Json => value === 'all' ? 'all' : Array.isArray(value) ? [...value] : null;
/** Keeps the error text of each existing identity check. */
function conflictMessage(state: CommandState, command: Command): string {
  switch (command.kind) {
    case 'input': return 'Input identity conflict';
    case 'receive': return command.inbound === 'owner_input' ? 'Input identity conflict' : 'Room input identity conflict';
    case 'room_input': return 'Room input identity conflict';
    case 'answer': return 'Answer identity conflict';
    case 'decide': {
      const card = state.cards[command.cardId];
      return !card || card.state === 'expired' ? 'Card expired' : `Card already ${card.state}`;
    }
    case 'outcome': return 'Outcome identity conflict';
    case 'message': return 'message_conflict';
    case 'occurrence': return 'Occurrence identity conflict';
  }
}
function need<T>(port: T | undefined, kind: string): T {
  if (port === undefined) throw new Error(`The Host has no port for ${kind}`);
  return port;
}
const accepted = (value?: Json): Disposition => value === undefined ? { outcome: 'accepted' } : { outcome: 'accepted', value };
/** Decides one command and changes `state`. Each outbox row that it writes goes to `out`. */
export function decideCommand(state: CommandState, command: Command, ports: CommandPorts, out: (intent: OutboxIntent) => void): Disposition {
  const publish: Publish = (id, value) => { ports.publish(id, value); out({ kind: 'projection', id }); };
  const deliver = ports.deliver && ((turn: Turn, key: string, text: string) => {
    const id = ports.deliver!(turn, key, text);
    if (id !== undefined) out({ kind: 'delivery', id });
  });
  switch (command.kind) {
    case 'input': {
      activeBot(state.team, command.botId);
      return accepted(need(ports.admitInput, command.kind)({ id: hash(['user', command.botId, command.key]), key: command.key,
        botId: command.botId, request: command.request, sender: command.sender, authority: 'owner' }));
    }
    case 'receive': {
      let root: string;
      if (command.inbound === 'owner_input') {
        activeBot(state.team, command.botId);
        root = need(ports.admitInput, command.kind)({ id: hash(['user', command.botId, command.key]), key: command.key,
          botId: command.botId, request: command.request, sender: command.sender, authority: 'owner' });
      } else root = roomInput(state.team, command.key, command.roomId, command.text, command.mentions, command.from);
      ports.remember?.(root);
      return accepted(root);
    }
    case 'room_input': return accepted(roomInput(state.team, command.key, command.roomId, command.text, command.mentions, command.from));
    case 'answer': {
      const question = state.questions[command.questionId];
      if (!question) throw new Error('Question not found');
      if (question.answer !== undefined) {
        if (question.answer !== command.answer) throw new Error('Answer identity conflict');
        return accepted();
      }
      const answer = command.answer;
      if (!answer.trim() || question.value.answerKind === 'single_choice' && !question.value.options.some(o => o.id === answer)) throw new Error('Invalid answer');
      question.answer = answer;
      const turnId = hash(['answer', command.questionId]);
      addTurn(state, { id: turnId, root: turnId, source: 'answer', request: JSON.stringify({ question: question.value, answer }),
        botId: state.turns[question.turnId]!.botId, hop: 0, authority: 'owner' });
      return accepted();
    }
    case 'decide': {
      const card = state.cards[command.cardId];
      if (!card) throw new Error('Card not found');
      if (card.state === 'pending' && ports.now() >= card.expiresAt) card.state = 'expired';
      // The Host throws a refused decision after its process pass, so an expiry still commits.
      if (card.state === 'expired') return { outcome: 'refused', reasonCode: 'card_expired', reason: 'Card expired' };
      if (card.state !== 'pending') {
        return card.state === command.decision ? accepted() : { outcome: 'refused', reasonCode: 'card_decided', reason: `Card already ${card.state}` };
      }
      card.state = command.decision;
      return accepted();
    }
    case 'outcome':
      applyTurnOutcome(state, command.turnId, command.taskId, command.document, { ...need(ports.outcome, command.kind),
        now: ports.now, publish, ...(deliver ? { deliver } : {}) });
      return accepted();
    case 'message': return acceptMessage(state, command.turnId, command.message, ports.now, deliver);
    case 'occurrence':
      need(ports.occurrence, command.kind)();
      return accepted();
  }
}
/** One command through the commit contract. The caller runs it inside one store transaction. */
export function commitCommand(state: CommandState, request: CommitRequest<Command>, store: CommandStore, ports: CommandPorts): CommitResult {
  const command = request.command;
  return commit(state, request, { scope: store.scope, evidence: commandEvidence(command),
    record: store.recordCallbacks || !CALLBACKS.has(command.kind), conflict: () => conflictMessage(state, command) },
  out => decideCommand(state, command, ports, out));
}
