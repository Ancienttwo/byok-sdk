/**
 * Rules of the bot-turn-outcome.v1 contract that the K7 schema subset cannot
 * express. `validateResultOutcome` runs them after the schema check when the
 * projection names this contract. Only type imports from result-schema, so
 * result-schema can dispatch here without an import cycle.
 */
import type { ResultIssue } from './result-schema';

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

/**
 * Any JSON value; a part of the wrong shape is skipped. A string that is empty
 * after trim() (outside confirmable_action[*].draft) is `blank-text`; a
 * repeated option id within ask_user is `duplicate-option-id` at the later id.
 * Messages never echo the value. The caller caps the list.
 */
export function botTurnOutcomeRuleIssues(outcome: unknown): ResultIssue[] {
  const issues: ResultIssue[] = [];
  blankText(outcome, '', issues);
  const options = isObject(outcome) && isObject(outcome.ask_user) ? outcome.ask_user.options : undefined;
  if (Array.isArray(options)) {
    const seen = new Set<string>();
    options.forEach((option: unknown, index) => {
      if (!isObject(option) || typeof option.id !== 'string') return;
      if (seen.has(option.id)) issues.push({ pointer: `/ask_user/options/${index}/id`, keyword: 'duplicate-option-id', message: 'Duplicate option id' });
      seen.add(option.id);
    });
  }
  return issues;
}
