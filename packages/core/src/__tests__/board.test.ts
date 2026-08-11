/**
 * The board vocabulary and transition table (§12.3).
 *
 * Behavior lives in the conformance suite; what this file pins is the *shape* —
 * the five statuses, the exact edge set from the state diagram, and the two
 * sinks. A transition table is the kind of thing that grows an extra edge
 * during an unrelated change, and an extra edge here means a work item can
 * reach `done` without human acceptance.
 */
import { describe, expect, it } from 'vitest';
import { BOARD_STATUSES, BOARD_TRANSITIONS, isLegalBoardTransition } from '../board';
import { PRESENCE_LEVELS } from '../presence';

/** The §12.3 state diagram, transcribed independently of the source table. */
const DIAGRAM_EDGES: readonly (readonly [string, string])[] = [
  ['todo', 'in_progress'],
  ['todo', 'closed'],
  ['in_progress', 'todo'],
  ['in_progress', 'in_review'],
  ['in_progress', 'closed'],
  ['in_review', 'in_progress'],
  ['in_review', 'done'],
  ['in_review', 'closed'],
];

describe('board vocabulary', () => {
  it('has exactly the five documented statuses', () => {
    expect([...BOARD_STATUSES]).toEqual(['todo', 'in_progress', 'in_review', 'done', 'closed']);
  });

  it('shares no value with the presence vocabulary', () => {
    const overlap = BOARD_STATUSES.filter((status) =>
      (PRESENCE_LEVELS as readonly string[]).includes(status),
    );
    expect(overlap).toEqual([]);
  });
});

describe('board transitions', () => {
  it('matches the state diagram edge for edge', () => {
    const declared = BOARD_STATUSES.flatMap((from) =>
      BOARD_TRANSITIONS[from].map((to) => `${from}->${to}`),
    ).sort();
    const expected = DIAGRAM_EDGES.map(([from, to]) => `${from}->${to}`).sort();
    expect(declared).toEqual(expected);
  });

  it('treats done and closed as sinks', () => {
    expect(BOARD_TRANSITIONS.done).toEqual([]);
    expect(BOARD_TRANSITIONS.closed).toEqual([]);
  });

  it('never allows acceptance without review', () => {
    expect(isLegalBoardTransition('todo', 'done')).toBe(false);
    expect(isLegalBoardTransition('in_progress', 'done')).toBe(false);
    expect(isLegalBoardTransition('in_review', 'done')).toBe(true);
  });

  it('rejects self-transitions', () => {
    for (const status of BOARD_STATUSES) {
      expect(isLegalBoardTransition(status, status)).toBe(false);
    }
  });
});
