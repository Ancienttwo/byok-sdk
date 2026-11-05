import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDOFF_EXCERPT_LINE_MAX_BYTES, buildHandoffPack, type HandoffPack, type HandoffPackBudgets, type HandoffTurn } from '../index';

interface Vector { name: string; turns: HandoffTurn[]; budgets: HandoffPackBudgets; pack: HandoffPack }
const vectors = JSON.parse(readFileSync(new URL('./golden/handoff-pack.vectors.json', import.meta.url), 'utf8')) as Vector[];
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const inner = (turns: readonly HandoffTurn[]) => bytes(turns) - 2;

describe('buildHandoffPack (#1441)', () => {
  it.each(vectors)('$name', ({ turns, budgets, pack }) => {
    expect(JSON.stringify(buildHandoffPack(turns, budgets))).toBe(JSON.stringify(pack));
  });

  it('stays inside every budget and keeps excerpt lines at the cap', () => {
    let seed = 1441;
    const next = (limit: number) => { seed = (seed * 48271) % 2147483647; return seed % limit; };
    const pieces = ['a', 'word ', '\n', '"', '\\', '\u0001', '中', '😀', '\ud83d', '\ude00', '…', 'x'.repeat(90)];
    const text = () => Array.from({ length: next(40) }, () => pieces[next(pieces.length)]!).join('');
    for (let round = 0; round < 3000; round += 1) {
      const turns = Array.from({ length: next(14) }, (_, id): HandoffTurn => ({
        lines: Array.from({ length: next(4) }, () => ({ speaker: next(2) ? 'user' : 'bot', text: text() })),
        ...(next(2) ? { meta: { id } } : {}) }));
      const budgets = { recentBytes: next(900), earlyBytes: next(1500), totalBytes: bytes({ omittedTurns: turns.length, earlier: [], recent: [] }) + next(1200) };
      const pack = buildHandoffPack(turns, budgets);
      expect(bytes(pack)).toBeLessThanOrEqual(budgets.totalBytes);
      expect(inner(pack.recent)).toBeLessThanOrEqual(budgets.recentBytes);
      expect(inner(pack.earlier)).toBeLessThanOrEqual(budgets.earlyBytes);
      for (const line of pack.earlier.flatMap(turn => turn.lines)) expect(bytes(line.text) - 2).toBeLessThanOrEqual(HANDOFF_EXCERPT_LINE_MAX_BYTES);
    }
  });

  it.each([
    ['a negative budget', [], { recentBytes: -1, earlyBytes: 0, totalBytes: 100 }],
    ['a fractional budget', [], { recentBytes: 0, earlyBytes: 0.5, totalBytes: 100 }],
    ['a total under the frame', [], { recentBytes: 0, earlyBytes: 0, totalBytes: 42 }],
    ['a frame that cannot hold the turn count', Array.from({ length: 10 }, () => ({ lines: [] })), { recentBytes: 0, earlyBytes: 0, totalBytes: 43 }],
  ] satisfies Array<[string, HandoffTurn[], HandoffPackBudgets]>)('refuses %s', (_, turns, budgets) => {
    expect(() => buildHandoffPack(turns, budgets)).toThrow(RangeError);
  });
});
