import { hash } from '@byok-sdk/server/execution-core/canonical';
import { addTurn, json, type Card, type Json, type TurnsState } from './turn';
import type { Publish } from './delegation';

// The confirmation card steps of a Host sync (#793 S5). L runs them in its sync; H runs them in each sync round.

/** Passive expiry: a pending card expires at its `expiresAt`. */
export function expireCard(card: Card, now: number): void {
  if (card.state === 'pending' && now >= card.expiresAt) card.state = 'expired';
}
/** Runs before the Turn steps, so a ContextPack frozen in the same sync shows each expiry. */
export function expireCards(state: { readonly cards: Readonly<Record<string, Card>> }, now: number): void {
  for (const card of Object.values(state.cards)) expireCard(card, now);
}
/**
 * The error of a connector call whose outcome is unknown: the call timed out, or a Host found its claim with no settle after
 * a crash. The call may have run, so the card fails and the connector is never called again.
 */
export const CONNECTOR_OUTCOME_UNKNOWN = 'Connector timed out; external outcome is unknown';
/** A confirmed card waits for its one connector call until it has a result or an error. */
export function cardCallDue(card: Card): boolean {
  return card.state === 'confirmed' && card.result === undefined && card.error === undefined;
}
/**
 * Writes the outcome of a card's connector call: the result, or the error cut to 1024 characters, and the conclusion. A
 * result that is not JSON is an error. The next sync's `reportCardDecisions` reports the card.
 */
export function settleCardCall(card: Card, outcome: { result: unknown } | { error: unknown }): void {
  let result: Json | undefined, error: string | undefined;
  if ('error' in outcome) error = errorText(outcome.error);
  else try { result = json(outcome.result); } catch (cause) { error = errorText(cause); }
  if (error !== undefined) card.error = error; else card.result = result!;
  card.conclusion = error === undefined ? 'succeeded' : 'failed';
}
const errorText = (cause: unknown): string => String(cause instanceof Error ? cause.message : cause).slice(0, 1024);
/**
 * Runs after the Turn steps. A decided card is projected once as `card:<id>:<state>`; a confirmed card waits for its
 * result or error. A confirmed or rejected card then gets its `action_result` Turn under the root of the Turn that made it.
 */
export function reportCardDecisions(state: TurnsState & { readonly cards: Readonly<Record<string, Card>> }, publish: Publish): void {
  for (const card of Object.values(state.cards)) {
    if (card.state !== 'pending' && (card.state !== 'confirmed' || card.result !== undefined || card.error !== undefined)) {
      if (!card.decisionReported) {
        publish(`card:${card.id}:${card.state}`, json(card));
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
}
