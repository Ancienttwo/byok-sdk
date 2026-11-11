import { hash } from '@byok-sdk/server/execution-core/canonical';
import { json, type Json } from './turn';

/**
 * Bot autonomy as pure rules (#1229, owner ruling of 2026-10-31). A Bot starts in `observe`: its autonomous actions
 * (`create_routine`, a cross-Bot `delegate` and `room_call`) are recorded as would-do rows instead of being applied.
 * `messageEgress`, `confirmable_action` and `ask_user` are not autonomous actions and are never gated here.
 * Only the owner principal switches a Bot, and only for outcomes recorded after the switch (no replay).
 */
export type Autonomy = 'observe' | 'auto';
/** The default of a new Bot, and of a Bot row that has no autonomy field (an older ledger). */
export const DEFAULT_AUTONOMY: Autonomy = 'observe';
/** The three actions that observe records instead of applying. */
export type WouldDoAction = 'create_routine' | 'delegate' | 'room_call';
/**
 * One action that an observing Bot would have taken. `id` is stable for the outcome that proposed it, so applying the
 * same outcome twice records one row. `detail` is the frozen-schema action, never a summary written by the model.
 * `turnId` is the Turn whose outcome proposed the action; retention moves the row with that Turn's root.
 */
export interface WouldDo {
  id: string; botId: string; turnId: string; taskId: string; action: WouldDoAction; index: number; at: number; detail: Json;
}
/** The Host state that observe adds. It appears at the first observed action, so an older ledger reads no rows. */
export interface AutonomyState { wouldDo?: Record<string, WouldDo> }
/** The autonomy of a Bot. An absent row or field is `observe`, the default of a new Bot. */
export function autonomyOf(bot: { readonly autonomy?: Autonomy } | undefined): Autonomy {
  return bot?.autonomy ?? DEFAULT_AUTONOMY;
}
/** `taskId` and the action's own index make the row once-only, as the K4 outcome transaction makes the action once-only. */
export function wouldDoId(taskId: string, action: WouldDoAction, index: number): string {
  return hash([taskId, 'would-do', action, index]);
}
/** Records one would-do row. Returns the new row, or `undefined` when the same outcome already recorded it. */
export function recordWouldDo(state: AutonomyState, row: Omit<WouldDo, 'id'>): WouldDo | undefined {
  const id = wouldDoId(row.taskId, row.action, row.index);
  if (state.wouldDo && Object.hasOwn(state.wouldDo, id)) return undefined;
  const record: WouldDo = { id, ...row };
  (state.wouldDo ??= {})[id] = record;
  return record;
}
/** The would-do rows of one Bot, or of every Bot, oldest first. A row of the same instant keeps a stable id order. */
export function wouldDoRows(state: AutonomyState, botId?: string): WouldDo[] {
  return Object.values(state.wouldDo ?? {})
    .filter(row => botId === undefined || row.botId === botId)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/**
 * The gate that a Turn outcome passes to each autonomous action. `record` writes the would-do row and publishes it for
 * the Host UI; it never applies the action.
 */
export interface AutonomyGate {
  readonly autonomy: Autonomy;
  record(action: WouldDoAction, index: number, detail: Json): void;
}
/** Whether the gate observes: the action is recorded, not applied. */
export function observes(gate: AutonomyGate): boolean {
  return gate.autonomy === 'observe';
}
/** The autonomy gate of one outcome (#1229): an observing Bot records its autonomous actions instead of applying them. */
export function autonomyGate(
  state: AutonomyState & { turns: Record<string, { botId: string }>; team: { bots: Record<string, { autonomy?: Autonomy } | undefined> } },
  turnId: string, taskId: string, now: () => number, publish: (id: string, value: Json) => void,
): AutonomyGate {
  const turn = state.turns[turnId]!;
  return { autonomy: autonomyOf(state.team.bots[turn.botId]), record: (action, index, detail) => {
    const row = recordWouldDo(state, { botId: turn.botId, turnId, taskId, action, index, at: now(), detail });
    if (row) publish(`would-do:${row.id}`, json(row));
  } };
}
