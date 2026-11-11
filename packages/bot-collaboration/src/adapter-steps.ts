import type { RoutineCommands } from '@byok-sdk/server/execution-core';
import { sealDueBatches, projectInputBatches, type CoalescePolicy } from './coalesce.js';
import { cleanReplyTokens, withholdStaged, type IntentConclusions } from './delivery-routing.js';
import { projectInboundDispositions } from './inbound.js';
import type { Publish } from './rules/delegation.js';
import { expireCards } from './rules/commands.js';
import { dreamOf } from './dream.js';
import type { CollaborationState } from './model.js';
import type { CommandPorts } from './rules/commands.js';
import { createDefinition, owned, updateDefinition } from './routines.js';

/**
 * A K4 terminal that K8 cannot apply (#882 Q6f): its key is neither a Bot Turn nor a Host intent, its Host handler
 * failed, or the outcome commit of its Bot Turn threw. The intent stays open at the head of its FIFO, and each pass rejects
 * with this error, until the outcome applies or the owner calls `failStuckIntent`.
 */
export class IntentOutcomeError extends Error {
  constructor(readonly key: string, readonly code: 'unknown_intent' | 'handler_failed' | 'outcome_failed', message: string) {
    super(message); this.name = 'IntentOutcomeError';
  }
}

type OutcomePorts = NonNullable<CommandPorts['outcome']>;

/** Routes a success terminal to a Host intent handler, a dream (closed by sync), or a Bot Turn outcome. */
export function routeTerminal(state: CollaborationState, key: string, handler: string | undefined):
  { kind: 'host_intent'; handler: string } | { kind: 'dream' } | { kind: 'bot_turn' } {
  if (handler !== undefined) return { kind: 'host_intent', handler };
  if (dreamOf(state, key)) return { kind: 'dream' };
  if (!Object.hasOwn(state.turns, key)) throw new IntentOutcomeError(key, 'unknown_intent', 'No Bot Turn or Host intent has this key');
  return { kind: 'bot_turn' };
}

/**
 * Runs a Host intent handler in the terminal transaction. `run` is undefined when no handler has this name.
 * L rejects missing handlers at startup; H has no startup check across every scope, so the terminal fails closed here.
 */
export function runHostIntentHandler(key: string, name: string, run: (() => unknown) | undefined): void {
  if (run === undefined) throw new IntentOutcomeError(key, 'handler_failed', `Unknown Host intent handler: ${name}`);
  let result: unknown;
  try { result = run(); } catch (cause) {
    throw new IntentOutcomeError(key, 'handler_failed', cause instanceof Error ? cause.message : String(cause));
  }
  // The handler shares the terminal transaction, so it must not resolve later. Its promise must not reject unhandled.
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new IntentOutcomeError(key, 'handler_failed', 'Host intent handler must be synchronous');
  }
}

/** The refusal of a Bot Turn whose outcome commit threw. */
export function outcomeFailure(key: string, cause: unknown): IntentOutcomeError {
  return new IntentOutcomeError(key, 'outcome_failed', cause instanceof Error ? cause.message : String(cause));
}

/** The outcome ports shared by L, H and their vector subjects. The caller adds `committed`. */
export function botOutcomePorts({ taskId, routines, manage, roomPosts }: {
  taskId: string; routines: RoutineCommands; manage: OutcomePorts['manage']; roomPosts: boolean;
}): Omit<OutcomePorts, 'committed'> {
  return {
    manage,
    createRoutine: (turn, action, index) => routines.create(createDefinition(routines.list(), turn.botId, taskId, index, action, turn.authority ?? 'bot')),
    updateRoutine: (turn, action) => routines.update(updateDefinition(routines.list(), turn.botId, action)),
    cancelRoutine: (turn, action) => routines.lifecycle(owned(routines.list(), turn.botId, action.routineId).definition.id, 'completed'),
    roomPosts,
  };
}

/** Seals due batches and expires cards before the sync freezes any new ContextPack. */
export function syncHead(state: CollaborationState, coalesce: CoalescePolicy | undefined, now: number): void {
  sealDueBatches(state, coalesce, now);
  expireCards(state, now);
}

/**
 * Withholds the staged replies of concluded intents, cleans reply tokens and projects every input batch and inbound destination after the sync's Turn steps.
 * H's finishDelivery also cleans reply tokens, corresponding to L's cleanup in each flush pass.
 * #1229 item 3: one projection per destination; an unchanged destination keeps the same projection id and value.
 */
export function syncTail(state: CollaborationState, conclusions: IntentConclusions | undefined, now: number, emit: Publish): void {
  if (conclusions !== undefined) {
    withholdStaged(conclusions, state);
    cleanReplyTokens(conclusions, state, now);
  }
  projectInputBatches(state, emit);
  projectInboundDispositions(state, emit);
}
