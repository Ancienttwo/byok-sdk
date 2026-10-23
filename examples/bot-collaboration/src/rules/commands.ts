import type { RoomFields } from '@byok-sdk/protocol';
import { hash } from '@byok-sdk/example-host-execution-core';
import { addBatchTurns, addTurn, json, type Json, type Turn } from './turn';
import { activeBot } from './team';
import { roomInput, updateRoom, type Mentions } from './rooms';
import { sealBatchForCancel, type InputFields } from './coalesce';
import { abandonDelegation, arbitrateCancel, type IntentFacts, type Publish } from './delegation';
import { applyTurnOutcome, type OutcomePorts, type OutcomeState } from './outcome';
import { acceptMessage, type MessageFields } from './message';
import { commit, type CommitRequest, type CommitResult, type CommitState, type Disposition, type OutboxIntent } from './commit';

// The collaboration commands and their decisions as pure rules (#739 D1). `commitCommand` runs one command
// through the commit contract. Owner commands and the K4 callbacks use the same function.
// The Host gives ports for its own helpers. A port that a command needs and that is absent is a Host error.

/** Commands with a caller key or a K4 key. The store records them, so a retry replays the first result. */
export type KeyedCommand =
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
/** The same shape as the channel `Conversation`. */
export interface Conversation { kind: 'direct' | 'group'; id: string }
/**
 * Owner commands without a caller key (#739 6a). The store keeps no record: each call applies and adds 1 to the revision.
 * Only an explicit expected revision protects a retry. The first commit moves the head, so the retry is `stale_revision`.
 */
export type KeylessCommand =
  | { kind: 'set_main_bot'; botId: string; mainBot: boolean }
  | { kind: 'update_room'; roomId: string; update: Partial<RoomFields> }
  | { kind: 'retry_persona'; botId: string }
  | { kind: 'enable_push_route'; conversation: Conversation; channel: string; target: string; owner: string }
  | { kind: 'revoke_push_route'; routeId: string }
  | { kind: 'resend_delivery'; deliveryId: string }
  | { kind: 'cancel_delegation'; delegationId: string }
  | { kind: 'abandon_delegation'; delegationId: string }
  /** A Turn of an open delegation chain cancels the whole delegation (§8.8). */
  | { kind: 'cancel_turn'; turnId: string };
export type Command = KeyedCommand | KeylessCommand;
/** The Bot and home rows that the team commands read and change. */
interface TeamRows {
  team: {
    bots: Readonly<Record<string, { mainBot: boolean; readonly revision: string; readonly persona: string }>>;
    homeOperations: ReadonlyArray<{ readonly botId: string; readonly status: string;
      readonly request: { readonly payload: { readonly agentRef: { readonly profileRevision: string } } } }>;
  };
}
export type CommandState = OutcomeState & CommitState & TeamRows;
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
  /** The K4 intent rows by Turn id, read in the commit transaction. */
  intents?: Pick<IntentFacts, 'intent'>;
  /** Advances the desired persona revision of a Bot with the Host models and toolset policy. */
  updatePersona?(botId: string, persona: string): void;
  /** The channel route rows. Each function returns the id of the row that it wrote. */
  routes?: {
    enable(conversation: Conversation, channel: string, target: string, owner: string): string;
    revoke(routeId: string): void;
    resend(deliveryId: string): string;
  };
}
/**
 * `recordCallbacks` is false when the caller deduplicates the K4 callbacks durably, as K4 does in L.
 * K4 dedups terminals and occurrences, and accepted messages by their receipt. A refused message still gets a record.
 */
export interface CommandStore { scope: string; recordCallbacks: boolean }

const CALLBACKS = new Set<Command['kind']>(['outcome', 'message', 'occurrence']);
const KEYLESS = new Set<Command['kind']>(['set_main_bot', 'update_room', 'retry_persona', 'enable_push_route', 'revoke_push_route',
  'resend_delivery', 'cancel_delegation', 'abandon_delegation', 'cancel_turn']);
export function isKeyless(command: Command): command is KeylessCommand { return KEYLESS.has(command.kind); }
/** The fields that decide each command's effect: the fields that the existing identity checks compare. */
export function commandEvidence(command: KeyedCommand): Json {
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
function conflictMessage(state: CommandState, command: KeyedCommand): string {
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
    case 'set_main_bot':
      activeBot(state.team, command.botId).mainBot = command.mainBot;
      return accepted();
    case 'update_room':
      updateRoom(state.team, command.roomId, command.update);
      return accepted();
    case 'retry_persona': {
      const bot = activeBot(state.team, command.botId);
      const failed = state.team.homeOperations.find(op => op.botId === command.botId
        && op.request.payload.agentRef.profileRevision === bot.revision && op.status === 'failed');
      if (!failed) throw new Error('No failed persona delivery for the current revision');
      need(ports.updatePersona, command.kind)(command.botId, bot.persona);
      const intents = need(ports.intents, command.kind);
      for (const turn of Object.values(state.turns)) {
        if (turn.botId === command.botId && !intents.intent(turn.id)) delete turn.profileFailure;
      }
      publish(`persona-retry:${bot.id}:${bot.revision}`, json({ owner: bot.id, revision: bot.revision, status: 'pending' }));
      return accepted();
    }
    case 'enable_push_route': {
      const { conversation } = command;
      if (typeof conversation.id !== 'string' || !conversation.id.trim()) throw new Error('Invalid conversation');
      if (conversation.kind === 'direct') {
        if (!Object.hasOwn(state.team.bots, conversation.id)) throw new Error('Bot not found');
        activeBot(state.team, conversation.id);
      } else if (conversation.kind !== 'group' || !Object.hasOwn(state.team.rooms, conversation.id)) throw new Error('Room not found');
      return accepted(need(ports.routes, command.kind).enable(conversation, command.channel, command.target, command.owner));
    }
    case 'revoke_push_route':
      need(ports.routes, command.kind).revoke(command.routeId);
      return accepted();
    case 'resend_delivery': {
      const id = need(ports.routes, command.kind).resend(command.deliveryId);
      out({ kind: 'delivery', id });
      return accepted(id);
    }
    case 'cancel_delegation':
    case 'abandon_delegation': {
      const d = state.delegations[command.delegationId];
      if (!d) throw new Error('Delegation not found');
      const settle = command.kind === 'cancel_delegation' ? arbitrateCancel : abandonDelegation;
      return accepted({ deliver: settle(state, need(ports.intents, command.kind), d, ports.now(), publish) });
    }
    case 'cancel_turn': return cancelTurn(state, command.turnId, ports, publish);
  }
}
/**
 * `deliver`: the chain path committed a cancel fact for the Host to deliver.
 * `target` and `admitted`: the Turn that the Host cancels in K4, or that this commit concluded.
 */
function cancelTurn(state: CommandState, turnId: string, ports: CommandPorts, publish: Publish): Disposition {
  const intents = need(ports.intents, 'cancel_turn'), chain = state.turns[turnId]?.delegationId;
  if (chain && !state.delegations[chain]!.verdict) {
    return accepted({ deliver: arbitrateCancel(state, intents, state.delegations[chain]!, ports.now(), publish) });
  }
  const { id: target, sealed } = sealBatchForCancel(state, turnId);
  if (sealed) addBatchTurns(state, [sealed]);
  const turn = state.turns[target];
  if (!turn) throw new Error('Turn not found');
  if (intents.intent(target)) return accepted({ target, admitted: true });
  if (!turn.conclusion) {
    turn.status = 'failed'; turn.conclusion = 'cancelled';
    delete turn.blockedReason;
    publish(`bot-turn:${target}`, json({ owner: turn.botId, ...turn }));
    turn.reported = true;
  }
  return accepted({ target, admitted: false });
}
/** One command through the commit contract. The caller runs it inside one store transaction. A keyless command gets no record. */
export function commitCommand(state: CommandState, request: CommitRequest<Command>, store: CommandStore, ports: CommandPorts): CommitResult {
  const command = request.command;
  if (isKeyless(command)) return commit(state, request, { scope: store.scope }, out => decideCommand(state, command, ports, out));
  const deduplicated = !store.recordCallbacks && CALLBACKS.has(command.kind);
  // K4 writes a message receipt only for an acceptance, so a refused message keeps its record here.
  const record = !deduplicated || command.kind === 'message' ? { evidence: commandEvidence(command), conflict: () => conflictMessage(state, command),
    ...(deduplicated ? { keep: (disposition: Disposition) => disposition.outcome === 'refused' } : {}) } : undefined;
  return commit(state, request, { scope: store.scope, ...(record ? { record } : {}) },
  out => decideCommand(state, command, ports, out));
}
