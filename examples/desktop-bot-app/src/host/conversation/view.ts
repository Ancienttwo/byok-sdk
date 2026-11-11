import type { CollaborationState, Turn } from '@byok-sdk/example-bot-collaboration';
import type { BotRow, TranscriptEntry, TurnRecord } from '../store/types.ts';

/**
 * The conversation view model the Host projects for the renderer (#1499 s1.8). The store and K8 state are its only
 * sources; it adds no state of its own besides display-only drafts and the failure text read back from the server.
 */

/** A rail state, in priority order: the first that applies wins. */
export type BotState = 'archived' | 'runtime_unavailable' | 'profile_updating' | 'waiting' | 'working' | 'idle';

export interface BotView extends BotRow {
  readonly state: BotState;
  /** Why the Bot cannot run: a blocked or held Turn's code, or the failed persona delivery. */
  readonly reason?: string;
}

export type Question = CollaborationState['questions'][string];

/** A live reply suffix from `tasks.messageDraft`. Display only; it is never written to the transcript. */
export interface Draft {
  readonly text: string;
  readonly state: 'open' | 'overflow' | 'gap' | 'failed';
  readonly error?: string;
}

/** A Turn that ended without a visible reply, with the reason when an authority gave one. */
export interface TurnEnd {
  readonly turnId: string;
  /** `failed`, `cancelled`, `expired` and other K4 conclusions, or `no_reply` for a succeeded Turn that sent no reply. */
  readonly conclusion: string;
  readonly reason?: string;
  /** #1499 R2: the packaged Host refused a background Pi subagent or workflow. */
  readonly backgroundUnavailable?: true;
}

export type ConversationItem =
  | { readonly kind: 'input'; readonly key: string; readonly text: string; readonly at: number; readonly folded: boolean }
  | { readonly kind: 'reply'; readonly key: string; readonly text: string; readonly at: number; readonly folded: boolean }
  | { readonly kind: 'clear'; readonly key: string; readonly at: number }
  | { readonly kind: 'working'; readonly key: string; readonly turnId: string; readonly draft?: Draft; readonly blocked?: string }
  | { readonly kind: 'ended'; readonly key: string; readonly folded: boolean; readonly end: TurnEnd }
  | { readonly kind: 'question'; readonly key: string; readonly id: string; readonly question: Question['value']; readonly answer?: string };

export interface ConversationView {
  readonly botId: string;
  readonly items: readonly ConversationItem[];
  /** The Turns the composer may cancel: queued, processing or blocked, oldest first. */
  readonly cancellable: readonly string[];
}

const PI_BACKGROUND_UNAVAILABLE = 'pi_background_unavailable';

type Bots = CollaborationState['team']['bots'];

/** The open Turns of one Bot, oldest first: no conclusion yet. */
export function openTurns(turns: Record<string, Turn>, botId: string): Turn[] {
  return Object.values(turns).filter(turn => turn.botId === botId && turn.conclusion === undefined);
}

/** The rail: every store Bot with the state K8 holds for it. */
export function botViews(rows: readonly BotRow[], state: Pick<CollaborationState, 'turns' | 'questions'> & { team: { bots: Bots } }): BotView[] {
  return rows.map(row => {
    if (row.archived) return { ...row, state: 'archived' };
    const open = openTurns(state.turns, row.id);
    const stuck = open.find(turn => turn.status === 'blocked' || turn.held !== undefined || turn.profileFailure !== undefined);
    if (stuck) return { ...row, state: 'runtime_unavailable', reason: stuck.profileFailure?.reason ?? stuck.blockedReason ?? stuck.held! };
    const bot = state.team.bots[row.id];
    if (!bot || bot.readyRevision !== bot.revision) return { ...row, state: 'profile_updating' };
    const waiting = Object.values(state.questions).some(question => question.answer === undefined && state.turns[question.turnId]?.botId === row.id);
    if (waiting) return { ...row, state: 'waiting' };
    return { ...row, state: open.length > 0 ? 'working' : 'idle' };
  });
}

/** How an ended Turn shows. `taskReason` is the server's display reason of the Turn's task terminal, when it has one. */
export function turnEnd(record: TurnRecord, taskReason: string | undefined): TurnEnd {
  const { projection } = record;
  const reason = projection.reason ?? projection.profileFailure?.reason ?? projection.blockedReason ?? taskReason;
  const conclusion = projection.conclusion === 'succeeded' ? 'no_reply' : projection.conclusion!;
  return {
    turnId: record.turnId, conclusion, ...(reason === undefined ? {} : { reason }),
    ...(reason?.startsWith(PI_BACKGROUND_UNAVAILABLE) ? { backgroundUnavailable: true as const } : {}),
  };
}

export interface ConversationSources {
  readonly entries: readonly TranscriptEntry[];
  /** The store's Turn records of the Bot (ended Turns: K8 publishes a `bot-turn:` projection at the end). */
  readonly ended: readonly TurnRecord[];
  /** K8's open Turns of the Bot. */
  readonly open: readonly Turn[];
  /** K8's questions whose Turn belongs to the Bot. */
  readonly questions: readonly Question[];
  readonly drafts: ReadonlyMap<string, Draft>;
  /** Server display reasons of ended Turns' tasks, by Turn id. */
  readonly taskReasons: ReadonlyMap<string, string>;
}

/**
 * The transcript in commit order with each Turn's status at its place: after the input it answers, else at the store
 * position of its record, else at the end. Rows above the latest
 * clear are folded, never dropped.
 */
export function conversationItems(botId: string, sources: ConversationSources): ConversationView {
  const inputSeq = new Map<string, number>();
  for (const entry of sources.entries) if (entry.kind === 'input' && entry.turnId !== undefined) inputSeq.set(entry.turnId, entry.seq);
  const epoch = sources.entries.reduce((last, entry) => entry.kind === 'clear' ? entry.seq : last, 0);
  const placed: Array<{ at: number; item: ConversationItem }> = [];
  for (const entry of sources.entries) {
    const folded = entry.seq < epoch;
    if (entry.kind === 'input') placed.push({ at: entry.seq, item: { kind: 'input', key: `e${entry.seq}`, text: entry.text, at: entry.at, folded } });
    else if (entry.kind === 'reply') placed.push({ at: entry.seq, item: { kind: 'reply', key: `e${entry.seq}`, text: entry.text, at: entry.at, folded } });
    else placed.push({ at: entry.seq, item: { kind: 'clear', key: `e${entry.seq}`, at: entry.at } });
  }
  // A status row sits just after its anchor entry, before the next one.
  const after = (seq: number) => seq + 0.5;
  const asked = new Set(sources.questions.map(question => question.turnId));
  for (const record of sources.ended) {
    // A succeeded Turn shows its reply or its question; only one with neither needs a status row.
    if (record.projection.conclusion === 'succeeded' && (record.reply !== undefined || asked.has(record.turnId))) continue;
    const seq = inputSeq.get(record.turnId) ?? record.seq;
    placed.push({ at: after(seq), item: { kind: 'ended', key: `t${record.turnId}`, folded: seq < epoch, end: turnEnd(record, sources.taskReasons.get(record.turnId)) } });
  }
  for (const turn of sources.open) {
    const draft = sources.drafts.get(turn.id);
    const blocked = turn.profileFailure?.reason ?? turn.blockedReason ?? turn.held;
    placed.push({ at: after(inputSeq.get(turn.id) ?? Number.MAX_SAFE_INTEGER), item: {
      kind: 'working', key: `t${turn.id}`, turnId: turn.id, ...(draft ? { draft } : {}), ...(blocked === undefined ? {} : { blocked }),
    } });
  }
  const turnSeq = new Map(sources.ended.map(record => [record.turnId, inputSeq.get(record.turnId) ?? record.seq]));
  for (const question of sources.questions) {
    placed.push({ at: after(turnSeq.get(question.turnId) ?? Number.MAX_SAFE_INTEGER) + 0.25, item: {
      kind: 'question', key: `q${question.id}`, id: question.id, question: question.value, ...(question.answer === undefined ? {} : { answer: question.answer }),
    } });
  }
  return {
    botId,
    items: placed.sort((a, b) => a.at - b.at).map(row => row.item),
    cancellable: sources.open.map(turn => turn.id),
  };
}
