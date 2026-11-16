import { describe, expect, it } from 'vitest';
import { TASK_STATES, TASK_TRANSITIONS, type TaskState } from '../index';

const TERMINAL_STATES: readonly TaskState[] = ['Complete', 'Failed', 'Cancelled'];

describe('TASK_TRANSITIONS', () => {
  it('has an entry for every declared task state', () => {
    for (const state of TASK_STATES) {
      expect(Array.isArray(TASK_TRANSITIONS[state])).toBe(true);
    }
  });

  it('terminal states (Complete/Failed/Cancelled) have no outgoing transitions', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(TASK_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('Offered can only move to Claimed, Cancelled, or Failed (task.decline maps to Failed — M1 gap #5)', () => {
    expect([...TASK_TRANSITIONS.Offered].sort()).toEqual(['Cancelled', 'Claimed', 'Failed']);
  });

  it('Offered cannot skip straight to Running', () => {
    expect(TASK_TRANSITIONS.Offered.includes('Running')).toBe(false);
  });

  it('AwaitApproval <-> Running loop is legal in both directions', () => {
    expect(TASK_TRANSITIONS.Running.includes('AwaitApproval')).toBe(true);
    expect(TASK_TRANSITIONS.AwaitApproval.includes('Running')).toBe(true);
  });

  it('rejects illegal transitions out of terminal states', () => {
    expect(TASK_TRANSITIONS.Complete.includes('Running')).toBe(false);
    expect(TASK_TRANSITIONS.Failed.includes('Complete')).toBe(false);
    expect(TASK_TRANSITIONS.Cancelled.includes('Offered')).toBe(false);
  });

  it('every non-terminal state can reach a terminal state (no dead ends)', () => {
    for (const state of TASK_STATES) {
      if (TERMINAL_STATES.includes(state)) continue;

      const seen = new Set<TaskState>();
      const queue: TaskState[] = [state];
      while (queue.length > 0) {
        const current = queue.pop() as TaskState;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of TASK_TRANSITIONS[current]) {
          queue.push(next);
        }
      }

      expect([...seen].some((s) => TERMINAL_STATES.includes(s))).toBe(true);
    }
  });

});
