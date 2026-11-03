/**
 * Rules of the bot-turn-outcome.v1 contract that the K7 schema subset cannot
 * express. `validateResultOutcome` runs them after the schema check when the
 * projection names this contract. Only type imports from result-schema, so
 * result-schema can dispatch here without an import cycle.
 */
import type { ResultIssue } from './result-schema';
import { checkRoutineSchedule, type RoutineSchedule } from './routine-schedule';

export const BOT_TURN_OUTCOME_CONTRACT = 'bot-turn-outcome.v1';

const token = (key: string | number): string => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function blankText(value: unknown, pointer: string, issues: ResultIssue[]): void {
  if (typeof value === 'string') {
    if (value.trim() === '') issues.push({ pointer, keyword: 'blank-text', message: 'Blank text' });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => blankText(item, `${pointer}/${index}`, issues));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      // The Host defines the draft schema; its strings are outside this rule.
      if (key === 'draft' && /^\/confirmable_action\/\d+$/.test(pointer)) continue;
      blankText(child, `${pointer}/${token(key)}`, issues);
    }
  }
}

const items = (value: unknown): [Record<string, unknown>, number][] =>
  Array.isArray(value) ? value.flatMap((item: unknown, index) => isObject(item) ? [[item, index] as [Record<string, unknown>, number]] : []) : [];

/** Each later repeat of a string in `values` (at `pointer/<index><suffix>`) is `keyword`. */
function repeats(values: [unknown, string][], keyword: string, message: string, issues: ResultIssue[]): void {
  const seen = new Set<string>();
  for (const [value, pointer] of values) {
    if (typeof value !== 'string') continue;
    if (seen.has(value)) issues.push({ pointer, keyword, message });
    seen.add(value);
  }
}
const repeatedField = (outcome: Record<string, unknown>, kind: string, field: string, keyword: string, message: string, issues: ResultIssue[]) =>
  repeats(items(outcome[kind]).map(([item, index]) => [item[field], `/${kind}/${index}/${field}`]), keyword, message, issues);
const repeatedMember = (members: unknown, pointer: string, issues: ResultIssue[]) => {
  if (Array.isArray(members)) repeats(members.map((id: unknown, index) => [id, `${pointer}/${index}`]), 'duplicate-member', 'Duplicate member', issues);
};
/** An update item with no field besides its id is `empty-update`. */
function emptyUpdates(outcome: Record<string, unknown>, kind: string, id: string, issues: ResultIssue[]): void {
  for (const [item, index] of items(outcome[kind])) {
    if (Object.keys(item).every(key => key === id)) issues.push({ pointer: `/${kind}/${index}`, keyword: 'empty-update', message: 'An update must change a field' });
  }
}

/**
 * Any JSON value; a part of the wrong shape is skipped. Messages never echo
 * a model-written value. The caller caps the list. Each repeat is reported
 * at the later occurrence.
 * - `blank-text`: a string that is empty after trim(), outside
 *   confirmable_action[*].draft.
 * - `duplicate-option-id`: an option id repeated within ask_user.
 * - `duplicate-target`: a delegate `to` repeated, this Bot included.
 * - `duplicate-local-id`: a create_bot localId repeated.
 * - `duplicate-id`: a cancel_routine routineId or cancel_delegation
 *   delegationId repeated.
 * - `duplicate-member`: a member repeated within room_call, or within one
 *   create_room or update_room item.
 * - `admin-not-member`: a create_room admin outside its members.
 * - `empty-update`: an update_routine with neither schedule nor prompt, or an
 *   update_bot or update_room item with no field besides its id.
 * - `schedule-invalid`, `schedule-unreachable`, `schedule-beyond-horizon`,
 *   `tz-invalid`: a create_routine or update_routine schedule that
 *   checkRoutineSchedule refuses, with its code.
 */
export function botTurnOutcomeRuleIssues(outcome: unknown): ResultIssue[] {
  const issues: ResultIssue[] = [];
  blankText(outcome, '', issues);
  if (!isObject(outcome)) return issues;
  const options = isObject(outcome.ask_user) ? outcome.ask_user.options : undefined;
  if (Array.isArray(options)) {
    repeats(options.map((option: unknown, index) => [isObject(option) ? option.id : undefined, `/ask_user/options/${index}/id`]),
      'duplicate-option-id', 'Duplicate option id', issues);
  }
  repeatedField(outcome, 'delegate', 'to', 'duplicate-target', 'Duplicate delegation target', issues);
  repeatedField(outcome, 'create_bot', 'localId', 'duplicate-local-id', 'Duplicate localId', issues);
  repeatedField(outcome, 'cancel_routine', 'routineId', 'duplicate-id', 'Duplicate routineId', issues);
  repeatedField(outcome, 'cancel_delegation', 'delegationId', 'duplicate-id', 'Duplicate delegationId', issues);
  if (isObject(outcome.room_call)) repeatedMember(outcome.room_call.members, '/room_call/members', issues);
  for (const kind of ['create_room', 'update_room']) {
    for (const [item, index] of items(outcome[kind])) repeatedMember(item.members, `/${kind}/${index}/members`, issues);
  }
  for (const [item, index] of items(outcome.create_room)) {
    if (typeof item.admin === 'string' && Array.isArray(item.members) && !item.members.includes(item.admin)) {
      issues.push({ pointer: `/create_room/${index}/admin`, keyword: 'admin-not-member', message: 'Admin must be a room member' });
    }
  }
  for (const [item, index] of items(outcome.update_routine)) {
    if (item.schedule === undefined && item.prompt === undefined) {
      issues.push({ pointer: `/update_routine/${index}`, keyword: 'empty-update', message: 'An update must change schedule or prompt' });
    }
  }
  emptyUpdates(outcome, 'update_bot', 'botId', issues);
  emptyUpdates(outcome, 'update_room', 'roomId', issues);
  for (const kind of ['create_routine', 'update_routine']) {
    for (const [item, index] of items(outcome[kind])) {
      if (!isObject(item.schedule)) continue;
      const check = checkRoutineSchedule(item.schedule as unknown as RoutineSchedule);
      if (!check.ok) issues.push({ pointer: `/${kind}/${index}/schedule`, keyword: check.code.replace(/_/g, '-'), message: check.message });
    }
  }
  return issues;
}
